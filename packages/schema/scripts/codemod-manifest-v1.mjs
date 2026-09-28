#!/usr/bin/env node
// Rewrites catalog manifests (appflare.jsonc) written for the schema before
// v1 into the v1 shape, keeping comments and layout: every change is a
// targeted edit of the file's text, never a re-serialisation.
//
//   node scripts/codemod-manifest-v1.mjs [--write | --out <dir>] [--check] <appflare.jsonc>...
//   node scripts/codemod-manifest-v1.mjs --help
//
//   --write        rewrite each file in place
//   --out <dir>    write each result to <dir>/<entry folder>/appflare.jsonc instead
//   --check        parse each result with the strict catalog manifest schema and
//                  print what it refuses
//
// Without --write or --out nothing is written; the report still lists every
// change. Lines marked TODO need a person: the codemod made its best guess
// (or none) and says what to check.
//
// Running it again is safe: a file already in the v1 shape passes through
// unchanged. A file counts as written before v1 when it uses a field or a
// form v1 no longer has (`vars[].required`, a token permission `name`,
// `install.healthPath`, a boolean `generate`, ...), or, failing that, when
// it has no v1 field either and still lists `install.tier`, `requires`,
// `secrets`, `vars` and `tokenPermissions`, which were all required then.
//
// Vars: before v1 a var needed a value only with `required: true`; in v1
// every var needs one unless it sets `optional: true`. So each var without
// `required: true` gets `optional: true`, even one with a `default`: the
// admin could clear that default before, and still can. Remove the flag by
// hand where the app cannot run without the value.
//
// Health check modes: `"default"` is now `"no-server-errors"` (the default,
// so it is dropped) and `"status-only"` is now `"any-response"`.
//
// Needs Node 22.18 or later: it reads the schema's own TypeScript sources
// (the permission groups, the licence rules, the strict schema) through
// Node's type stripping, so it always agrees with this version of the schema.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_HEALTH_MODE, strictCatalogManifestSchema } from "../src/catalog.ts";
import { CATALOG_CATEGORY_IDS } from "../src/categories.ts";
import { catalogLicenseProblem } from "../src/license.ts";
import { formatPath } from "../src/strict.ts";
import { APP_TOKEN_PERMISSION_GROUPS } from "../src/token-permissions.ts";

// jsonc-parser's ES module build uses extensionless imports Node cannot
// resolve, so load its CommonJS build.
const { applyEdits, findNodeAtLocation, getNodeValue, modify, parseTree } = createRequire(
  import.meta.url,
)("jsonc-parser");

const FORMATTING = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } };

/** Category ids that were folded into others. */
const FOLDED_CATEGORIES = {
  social: "community",
  storage: "files",
  blogging: "cms",
  gaming: "games",
};

/** The v1 names of the health check modes, by their names before v1. */
const HEALTH_MODE_NAMES = { default: "no-server-errors", "status-only": "any-response" };

/** Secret names apps give their own Cloudflare API token. */
const TOKEN_SECRET_NAME = /(?:^|_)(?:CF|CLOUDFLARE)_(?:[A-Z0-9]+_)?TOKEN$/;

/** An inline rendering of a JSON value, as a one-line object in these files is written. */
function inline(value) {
  if (Array.isArray(value)) return `[${value.map(inline).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${inline(v)}`);
    return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
  }
  return JSON.stringify(value);
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A JSONC document edited in place, with a record of what changed. */
class Document {
  constructor(text) {
    this.text = text;
    this.changes = [];
    this.todos = [];
    this.notes = [];
  }

  tree() {
    return parseTree(this.text, [], { allowTrailingComma: true });
  }

  node(path) {
    return findNodeAtLocation(this.tree(), path);
  }

  get(path) {
    const node = this.node(path);
    return node === undefined ? undefined : getNodeValue(node);
  }

  slice(node) {
    return this.text.slice(node.offset, node.offset + node.length);
  }

  singleLine(node) {
    return !this.slice(node).includes("\n");
  }

  splice(offset, length, content) {
    this.text = this.text.slice(0, offset) + content + this.text.slice(offset + length);
  }

  /** The offset where the line holding `offset` starts. */
  lineStart(offset) {
    return this.text.lastIndexOf("\n", offset - 1) + 1;
  }

  /** The offset just past the end of the value at `end`: its comma, a comment on its line, the line break. */
  lineEndAfter(end) {
    let k = end;
    while (this.text[k] === " " || this.text[k] === "\t") k++;
    if (this.text[k] === ",") k++;
    while (this.text[k] === " " || this.text[k] === "\t") k++;
    if (this.text.startsWith("//", k)) {
      const newline = this.text.indexOf("\n", k);
      k = newline === -1 ? this.text.length : newline;
    }
    if (this.text[k] === "\n") k++;
    return k;
  }

  /** Removes the property at `path`; says so, and notes a comment that goes with it. */
  remove(path, why) {
    const value = this.node(path);
    if (value === undefined) return;
    const property = value.parent;
    const container = property.parent;
    const siblings = container.children;
    const index = siblings.indexOf(property);
    const previous = siblings[index - 1];
    const next = siblings[index + 1];
    let removed;
    if (this.singleLine(container)) {
      if (siblings.length === 1) {
        removed = this.slice(container);
        this.splice(container.offset, container.length, "{}");
      } else if (next !== undefined) {
        removed = this.text.slice(property.offset, next.offset);
        this.splice(property.offset, next.offset - property.offset, "");
      } else {
        const start = previous.offset + previous.length;
        removed = this.text.slice(start, property.offset + property.length);
        this.splice(start, property.offset + property.length - start, "");
      }
    } else {
      // Whole lines: the property's own, and the comment lines right above it.
      let start = property.offset;
      const lineStart = this.lineStart(start);
      if (this.text.slice(lineStart, start).trim() === "") {
        start = lineStart;
        const floor =
          previous === undefined ? container.offset + 1 : previous.offset + previous.length;
        for (;;) {
          const above = this.lineStart(start - 1);
          if (above < floor || start === 0) break;
          const line = this.text.slice(above, start).trim();
          if (!/^(?:\/\/|\/\*|\*)/.test(line)) break;
          start = above;
        }
      }
      const end = this.lineEndAfter(property.offset + property.length);
      removed = this.text.slice(start, end);
      this.splice(start, end - start, "");
      if (next === undefined && previous !== undefined) {
        // The property was last: drop the comma after the one before it.
        let k = previous.offset + previous.length;
        while (/\s/.test(this.text[k] ?? "")) k++;
        if (this.text[k] === ",") this.splice(k, 1, "");
      }
    }
    const withoutStrings = removed.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    const comment = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/.exec(withoutStrings);
    this.changes.push(`removed ${formatPath(path)}${why ? ` (${why})` : ""}`);
    if (comment !== null) {
      const text = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/.exec(removed)?.[1] ?? comment[1];
      this.todos.push(
        `a comment went with ${formatPath(path)}; put it back where it still applies: ${text.slice(0, 90).trim()}`,
      );
    }
  }

  /** The comment written right above the property at `path`, or on its line; null when none is. */
  commentOf(path) {
    const value = this.node(path);
    if (value === undefined) return null;
    const property = value.parent;
    const siblings = property.parent.children;
    const previous = siblings[siblings.indexOf(property) - 1];
    const floor =
      previous === undefined ? property.parent.offset + 1 : previous.offset + previous.length;
    const above = this.text.slice(floor, property.offset);
    const lineEnd = this.lineEndAfter(property.offset + property.length);
    const after = this.text.slice(property.offset + property.length, lineEnd);
    const match = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/.exec(`${above}\n${after}`);
    return match === null ? null : match[1];
  }

  /**
   * Removes a property that only states its default, unless a comment explains
   * it: the comment would lose its subject, so both stay for a person to judge.
   */
  strip(path, why) {
    const comment = this.commentOf(path);
    if (comment === null) {
      this.remove(path, why);
      return;
    }
    this.notes.push(
      `kept ${formatPath(path)}, which ${why}, because a comment explains it (${comment.slice(0, 70).trim()}); remove both if the comment no longer matters`,
    );
  }

  /** Sets the value at `path`: replaced where it is, or added as the object's last property. */
  set(path, value, change) {
    const existing = this.node(path);
    if (existing !== undefined) {
      this.splice(existing.offset, existing.length, inline(value));
    } else {
      const parentPath = path.slice(0, -1);
      const key = path[path.length - 1];
      const container = this.node(parentPath);
      if (container === undefined) throw new Error(`no ${formatPath(parentPath)} to add ${key} to`);
      const property = `${JSON.stringify(key)}: ${inline(value)}`;
      const last = container.children?.[container.children.length - 1];
      if (last === undefined) {
        this.splice(container.offset, container.length, `{ ${property} }`);
      } else if (this.singleLine(container)) {
        this.splice(last.offset + last.length, 0, `, ${property}`);
      } else {
        // A line of its own after the last property, indented like it.
        const lineStart = this.lineStart(last.offset);
        const indent = /^[ \t]*/.exec(this.text.slice(lineStart))?.[0] ?? "";
        let lineEnd = this.lineEndAfter(last.offset + last.length);
        if (this.text[lineEnd - 1] === "\n") lineEnd--;
        let k = last.offset + last.length;
        while (this.text[k] === " " || this.text[k] === "\t") k++;
        const hasComma = this.text[k] === ",";
        this.splice(lineEnd, 0, `\n${indent}${property}${hasComma ? "," : ""}`);
        if (!hasComma) this.splice(last.offset + last.length, 0, ",");
      }
    }
    if (change !== undefined) this.changes.push(change);
  }

  /** Renames the key of the property at `path`. */
  rename(path, key, why) {
    const value = this.node(path);
    if (value === undefined) return;
    const keyNode = value.parent.children[0];
    this.splice(keyNode.offset, keyNode.length, JSON.stringify(key));
    if (why !== false) {
      this.changes.push(`renamed ${formatPath(path)} to ${key}${why ? ` (${why})` : ""}`);
    }
  }

  /** Replaces the whole value at `path`, laid out by jsonc-parser (for a value whose shape changes). */
  replace(path, value, change) {
    this.text = applyEdits(this.text, modify(this.text, path, value, FORMATTING));
    this.changes.push(change);
  }
}

/**
 * The v1 form of an old `tokenPermissions` entry (`{ name, scope?, description? }`,
 * the name `Zone.DNS:Edit`, `Workers Scripts` or `Access: Apps and Policies`), or
 * null when its group is not one Appflare knows.
 */
function convertPermission(old) {
  const match = /^(.*?)(?::(read|edit))?$/i.exec(String(old.name ?? "").trim());
  if (match === null) return null;
  let base = match[1].trim().replace(/\s+/g, " ");
  let scope = old.scope;
  const dot = base.indexOf(".");
  if (dot !== -1 && /^(?:zone|account)$/i.test(base.slice(0, dot))) {
    const prefix = base.slice(0, dot).toLowerCase();
    if (scope !== undefined && scope !== prefix) return null;
    scope = prefix;
    base = base.slice(dot + 1).trim();
  }
  const lower = base.toLowerCase();
  const known = APP_TOKEN_PERMISSION_GROUPS.find(
    (g) => g.scope === scope && g.group.toLowerCase() === lower,
  );
  if (known === undefined) return null;
  return {
    permission: {
      group: known.group,
      scope,
      access: match[2]?.toLowerCase() === "read" ? "read" : "edit",
      reason: old.description ?? "TODO: say why the app needs this permission",
    },
    accessStated: match[2] !== undefined,
  };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Whether a token permission entry is still in its form before v1. */
function isOldPermission(p) {
  return !isObject(p) || "name" in p || "description" in p;
}

/**
 * What only a person can finish, which a rewrite therefore leaves in the
 * file: token permissions of a group Appflare does not know, and a stage
 * option other than the tool's own. A file with these and nothing else from
 * before v1 gets no further changes, only the same TODO lines again.
 */
export function leftForAPerson(manifest) {
  const left = [];
  const permissions = Array.isArray(manifest.tokenPermissions) ? manifest.tokenPermissions : [];
  permissions.forEach((p, i) => {
    if (isOldPermission(p) && convertPermission(isObject(p) ? p : {}) === null) {
      left.push(`tokenPermissions[${i}]`);
    }
  });
  const stageArg = manifest.install?.selfDeploying?.stageArg;
  if (stageArg !== undefined && stageArg !== "--stage") left.push("install.selfDeploying.stageArg");
  return left;
}

/**
 * What shows a parsed manifest is still in the shape before v1 and has
 * something the rewrite converts, one line each; empty when it is in the v1
 * shape (apart from {@link leftForAPerson}). See the header for the rule.
 */
export function preV1Signs(manifest) {
  const signs = [];
  const install = isObject(manifest.install) ? manifest.install : {};
  const list = (key) => (Array.isArray(manifest[key]) ? manifest[key].filter(isObject) : []);
  const vars = list("vars");
  const secrets = list("secrets");
  const permissions = Array.isArray(manifest.tokenPermissions) ? manifest.tokenPermissions : [];
  if (vars.some((v) => "required" in v)) signs.push("vars[].required");
  if (permissions.some((p) => isOldPermission(p) && convertPermission(isObject(p) ? p : {}))) {
    signs.push("tokenPermissions[].name");
  }
  if (secrets.some((s) => typeof s.generate === "boolean")) signs.push("secrets[].generate: true");
  for (const key of ["healthPath", "healthMode", "version", "sandbox", "wildcardReason"]) {
    if (key in install) signs.push(`install.${key}`);
  }
  if (typeof install.wildcardHostname === "boolean") signs.push("install.wildcardHostname: true");
  const selfDeploying = isObject(install.selfDeploying) ? install.selfDeploying : {};
  for (const key of ["workers", "stateStore"]) {
    if (key in selfDeploying) signs.push(`install.selfDeploying.${key}`);
  }
  if (selfDeploying.stageArg === "--stage") signs.push("install.selfDeploying.stageArg");
  if (Array.isArray(manifest.resources?.hyperdrive)) signs.push("resources.hyperdrive as a list");
  if (Object.values(manifest.resources?.d1 ?? {}).some((d) => isObject(d) && "migrations" in d)) {
    signs.push("resources.d1[binding].migrations");
  }
  const categories = Array.isArray(manifest.categories) ? manifest.categories : [];
  if (categories.some((id) => Object.hasOwn(FOLDED_CATEGORIES, id)))
    signs.push("a folded category");
  if (signs.length > 0) return signs;
  // Nothing only the old shape has: a field only v1 has settles it.
  const v1 =
    vars.some((v) => "optional" in v) ||
    permissions.some((p) => isObject(p) && "group" in p) ||
    secrets.some((s) => "cloudflareToken" in s) ||
    "health" in install ||
    "container" in install ||
    isObject(install.wildcardHostname) ||
    "workerNames" in selfDeploying ||
    (isObject(manifest.source) && "version" in manifest.source) ||
    Object.values(manifest.resources?.d1 ?? {}).some((d) => isObject(d) && "migrationsGlob" in d);
  if (v1) return [];
  // Before v1 these were all required; the rewrite drops them where they state a default.
  const required = ["requires", "secrets", "vars", "tokenPermissions"];
  if ("tier" in install && required.every((key) => key in manifest)) {
    signs.push("install.tier, requires, secrets, vars and tokenPermissions all present");
  }
  return signs;
}

/** Rewrites one manifest's text; returns the document with its record of changes. */
export function migrate(text) {
  const doc = new Document(text);
  const manifest = doc.get([]);
  if (!isObject(manifest)) {
    doc.todos.push("not a JSON object; nothing done");
    return doc;
  }
  const preV1 = preV1Signs(manifest).length > 0;
  if (!preV1 && leftForAPerson(manifest).length === 0) {
    doc.notes.push("already in the v1 shape; left as it is");
    return doc;
  }
  // Only what a person must finish is left: every step below is then a no-op
  // but for its TODO lines, except the vars, whose missing `optional` reads
  // differently before v1 and must not be converted twice.
  const slug = manifest.slug;

  // Top level.
  if (manifest.homepage === `https://github.com/${manifest.repo}`) {
    doc.strip(["homepage"], "defaults to the repository");
  }
  for (const key of ["requires", "secrets", "vars", "tokenPermissions"]) {
    if (Array.isArray(manifest[key]) && manifest[key].length === 0) {
      doc.strip([key], "defaults to []");
    }
  }
  if (manifest.revision === 1) doc.strip(["revision"], "defaults to 1");
  if (sameJson(manifest.bump, { autoMerge: false })) doc.strip(["bump"], "is the default");

  // Categories.
  (manifest.categories ?? []).forEach((id, i) => {
    const folded = FOLDED_CATEGORIES[id];
    if (folded !== undefined)
      doc.set(["categories", i], folded, `categories[${i}]: ${id} is now ${folded}`);
    else if (!CATALOG_CATEGORY_IDS.includes(id)) {
      doc.todos.push(`categories[${i}] "${id}" is not a category; pick one of the list`);
    }
  });
  if ((manifest.categories ?? []).length > 3) {
    doc.todos.push(`categories lists ${manifest.categories.length}; keep at most 3`);
  }

  // License.
  if (typeof manifest.license === "string") {
    const problem = catalogLicenseProblem(manifest.license);
    if (problem !== null) doc.todos.push(`license ${problem}`);
  }

  // install.
  const install = manifest.install ?? {};
  if (install.tier === "artifact") doc.strip(["install", "tier"], 'defaults to "artifact"');
  if (install.workerName !== undefined && install.workerName === slug) {
    doc.strip(["install", "workerName"], "defaults to the slug");
  }
  if (install.fixedWorkerName === false)
    doc.strip(["install", "fixedWorkerName"], "is the default");
  if (install.healthPath !== undefined || install.healthMode !== undefined) {
    // The first of the two becomes install.health, so a comment above it stays.
    // A value that is now the default is dropped, as other defaults are,
    // unless a comment explains it: then it stays, stated in the new shape.
    const health = {};
    const keepsDefault = (key, why) => {
      const comment = doc.commentOf(["install", key]);
      if (comment === null) return false;
      doc.notes.push(
        `kept install.${why}, which is the default, because a comment explains it (${comment.slice(0, 70).trim()}); remove both if the comment no longer matters`,
      );
      return true;
    };
    if (install.healthPath !== undefined) {
      if (install.healthPath !== "/" || keepsDefault("healthPath", 'health.path "/"')) {
        health.path = install.healthPath;
      }
    }
    if (install.healthMode !== undefined) {
      const mode = HEALTH_MODE_NAMES[install.healthMode];
      if (mode === undefined) {
        health.mode = install.healthMode;
        doc.todos.push(
          `install.healthMode "${install.healthMode}" is not a mode; write "no-server-errors" or "any-response"`,
        );
      } else if (mode !== DEFAULT_HEALTH_MODE) {
        health.mode = mode;
        doc.changes.push(`install.healthMode "${install.healthMode}" is now "${mode}"`);
      } else if (keepsDefault("healthMode", `health.mode "${mode}"`)) {
        health.mode = mode;
      }
    }
    const keys = Object.keys(install);
    const [first, second] =
      install.healthPath === undefined ||
      (install.healthMode !== undefined && keys.indexOf("healthMode") < keys.indexOf("healthPath"))
        ? ["healthMode", "healthPath"]
        : ["healthPath", "healthMode"];
    doc.remove(["install", second]);
    if (Object.keys(health).length > 0) {
      doc.rename(["install", first], "health", false);
      doc.set(["install", "health"], health);
      doc.changes.push("install.healthPath and healthMode are now install.health");
    } else {
      // No comment explains it (else `health` would hold the value), so this removes it.
      doc.strip(["install", first], "is the default health check");
    }
  }
  if (install.version !== undefined) {
    doc.remove(["install", "version"]);
    doc.set(["source", "version"], install.version, "install.version moved to source.version");
  }
  if (install.sandbox !== undefined) doc.rename(["install", "sandbox"], "container");
  if (install.wildcardHostname === true) {
    doc.set(
      ["install", "wildcardHostname"],
      { reason: install.wildcardReason ?? "TODO: why the app needs every name under its hostname" },
      "install.wildcardHostname and wildcardReason became wildcardHostname.reason",
    );
    doc.remove(["install", "wildcardReason"]);
    if (install.wildcardReason === undefined)
      doc.todos.push("install.wildcardHostname needs a reason");
  } else if (install.wildcardHostname === false) {
    doc.remove(["install", "wildcardHostname"], "false is the default");
    doc.remove(["install", "wildcardReason"]);
  }
  const selfDeploying = install.selfDeploying;
  if (selfDeploying !== undefined) {
    doc.remove(["install", "selfDeploying", "stateStore"], "the state store is always the account");
    if (selfDeploying.stageArg !== undefined) {
      if (selfDeploying.stageArg === "--stage") {
        doc.remove(["install", "selfDeploying", "stageArg"], "the tool's own option");
      } else {
        doc.todos.push(
          `install.selfDeploying.stageArg "${selfDeploying.stageArg}" is gone: the tool's own option is always used`,
        );
      }
    }
    if (selfDeploying.workers !== undefined) {
      doc.rename(["install", "selfDeploying", "workers"], "workerNames");
    }
  }
  const emailRouting = install.emailRouting;
  if (emailRouting !== undefined) {
    if (emailRouting.catchAll === false)
      doc.strip(["install", "emailRouting", "catchAll"], "is the default");
    if (sameJson(emailRouting.rules, []))
      doc.strip(["install", "emailRouting", "rules"], "is the default");
  }
  (install.workers ?? []).forEach((worker, i) => {
    if (worker.primary === false) doc.strip(["install", "workers", i, "primary"], "is the default");
    if (worker.workersDev === true)
      doc.strip(["install", "workers", i, "workersDev"], "is the default");
  });
  (install.installDirs ?? []).forEach((dir, i) => {
    if (dir.lockfile === "required")
      doc.strip(["install", "installDirs", i, "lockfile"], "is the default");
    if (dir.devDependencies === true) {
      doc.strip(["install", "installDirs", i, "devDependencies"], "is the default");
    }
  });

  // Secrets.
  (manifest.secrets ?? []).forEach((secret, i) => {
    const at = ["secrets", i];
    if (secret.generate === true)
      doc.set([...at, "generate"], "password", `secrets[${i}].generate: true is now "password"`);
    if (secret.generate === false) doc.remove([...at, "generate"], "not generated is the default");
    for (const flag of ["optional", "seedOnly", "multiline"]) {
      if (secret[flag] === false) doc.strip([...at, flag], "is the default");
    }
  });

  // Vars: one `optional` flag instead of `required`.
  (preV1 ? (manifest.vars ?? []) : []).forEach((v, i) => {
    const at = ["vars", i];
    const keepsValue = v.derive !== undefined || v.seedOnly === true;
    if (v.required === true) {
      doc.remove([...at, "required"], "a var needs a value unless it is optional");
    } else if (keepsValue) {
      if (v.required !== undefined)
        doc.remove([...at, "required"], "a derived or seed-only var always has a value");
    } else if (v.required === undefined && v.optional !== undefined) {
      // Already says whether it is optional, as v1 does.
    } else {
      if (v.required === false) {
        // Keep the property's place: rename it, then set its value.
        doc.rename([...at, "required"], "optional", false);
        doc.set([...at, "optional"], true);
      } else {
        doc.set([...at, "optional"], true);
      }
      doc.changes.push(
        `vars[${i}] (${v.name}) is optional: true, as a var without required: true was`,
      );
    }
    if (v.type === "text") doc.strip([...at, "type"], "is the default");
  });

  // Token permissions.
  let convertedCount = 0;
  (manifest.tokenPermissions ?? []).forEach((old, i) => {
    // Already { group, scope, access, reason }: nothing to convert.
    if (isObject(old) && !("name" in old) && !("description" in old) && "group" in old) return;
    const converted = convertPermission(old);
    const oldText = inline(old);
    if (converted === null) {
      doc.todos.push(
        `tokenPermissions[${i}] ${oldText}: not converted, its group is not one Appflare knows; write { group, scope, access, reason } by hand`,
      );
      return;
    }
    // Property by property, so the entry keeps its layout and comments.
    const at = ["tokenPermissions", i];
    const { group, scope, access, reason } = converted.permission;
    doc.rename([...at, "name"], "group", false);
    doc.set([...at, "group"], group);
    if (old.scope === undefined) doc.set([...at, "scope"], scope);
    else if (old.scope !== scope) doc.set([...at, "scope"], scope);
    if (old.description !== undefined) doc.rename([...at, "description"], "reason", false);
    else doc.set([...at, "reason"], reason);
    doc.set([...at, "access"], access);
    convertedCount++;
    doc.todos.push(
      `tokenPermissions[${i}] ${oldText} is now ${scope} "${group}" with ${access} access` +
        (converted.accessStated ? "" : " (the old default, as it named no level)") +
        "; check the level and the reason",
    );
  });
  if (convertedCount > 0) {
    doc.changes.push(
      `tokenPermissions: ${convertedCount} entries are now { group, scope, access, reason }`,
    );
  }

  // The secret that takes the app's own Cloudflare API token.
  const pipelineSecrets = Object.values(manifest.resources?.pipelines ?? {}).map(
    (p) => p.sink?.tokenSecret,
  );
  if ((manifest.tokenPermissions ?? []).length > 0 || pipelineSecrets.length > 0) {
    const secrets = manifest.secrets ?? [];
    const flagged = secrets.filter((s) => s.cloudflareToken === true);
    if (flagged.length === 0) {
      const candidates = secrets
        .map((s, i) => ({ s, i }))
        .filter(
          ({ s }) => s.derive === undefined && s.seedOnly !== true && s.generate === undefined,
        )
        .filter(({ s }) => pipelineSecrets.includes(s.name) || TOKEN_SECRET_NAME.test(s.name));
      if (candidates.length === 1) {
        const { s, i } = candidates[0];
        doc.set(
          ["secrets", i, "cloudflareToken"],
          true,
          `secrets[${i}] (${s.name}) takes the app's Cloudflare API token`,
        );
        doc.todos.push(
          `secrets[${i}] (${s.name}) was marked cloudflareToken by its name; check it takes the token`,
        );
      } else if (candidates.length === 0) {
        doc.todos.push(
          "the entry lists tokenPermissions but no secret looks like the token's; mark the secret that takes it with cloudflareToken: true, if the app has one",
        );
      } else {
        doc.todos.push(
          `several secrets look like the app's token (${candidates.map(({ s }) => s.name).join(", ")}); mark the one that takes it with cloudflareToken: true`,
        );
      }
    }
  }

  // Resources.
  const hyperdrive = manifest.resources?.hyperdrive;
  if (Array.isArray(hyperdrive)) {
    const record = Object.fromEntries(hyperdrive.map(({ binding, ...rest }) => [binding, rest]));
    doc.replace(
      ["resources", "hyperdrive"],
      record,
      "resources.hyperdrive is now keyed by binding",
    );
  }
  for (const [binding, d1] of Object.entries(manifest.resources?.d1 ?? {})) {
    if (d1.migrations !== undefined)
      doc.rename(["resources", "d1", binding, "migrations"], "migrationsGlob");
  }

  // Placeholders: {{workerUrl}} stays the workers.dev address; say where the
  // app's own address is probably meant.
  const workerUrl = /\{\{\s*workerUrl(?::[a-z0-9-]+)?\s*\}\}/;
  (manifest.vars ?? []).forEach((v, i) => {
    if (typeof v.default === "string" && workerUrl.test(v.default)) {
      doc.notes.push(
        `vars[${i}] (${v.name}) defaults to ${JSON.stringify(v.default)}; if it means the address people use, write {{appUrl}}`,
      );
    }
  });
  const inPostInstall = (manifest.postInstall ?? []).filter(
    (step) => typeof step.content === "string" && workerUrl.test(step.content),
  ).length;
  if (inPostInstall > 0) {
    doc.notes.push(
      `postInstall uses {{workerUrl}} in ${inPostInstall} step(s); for the address people open, {{appUrl}} follows a custom domain`,
    );
  }
  return doc;
}

function main(argv) {
  const files = [];
  let out;
  let write = false;
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      // The comment at the top of this file is the help.
      const own = readFileSync(new URL(import.meta.url), "utf8").split("\n");
      const help = own.slice(
        1,
        own.findIndex((line) => line.startsWith("import ")),
      );
      console.log(
        help
          .map((line) => line.replace(/^\/\/ ?/, ""))
          .join("\n")
          .trim(),
      );
      return;
    }
    if (arg === "--write") write = true;
    else if (arg === "--check") check = true;
    else if (arg === "--out") out = argv[++i];
    else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else files.push(arg);
  }
  if (files.length === 0) {
    console.error(
      "usage: codemod-manifest-v1.mjs [--write | --out <dir>] [--check] <appflare.jsonc>... (--help explains)",
    );
    process.exit(2);
  }
  let failed = 0;
  for (const file of files) {
    const doc = migrate(readFileSync(file, "utf8"));
    console.log(`== ${file}`);
    for (const line of doc.changes) console.log(`  changed: ${line}`);
    for (const line of doc.notes) console.log(`  note: ${line}`);
    for (const line of doc.todos) console.log(`  TODO: ${line}`);
    if (write) writeFileSync(file, doc.text);
    if (out !== undefined) {
      const target = join(out, basename(dirname(file)), "appflare.jsonc");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, doc.text);
      console.log(`  wrote ${target}`);
    }
    if (check) {
      const parsed = parseTree(doc.text, [], { allowTrailingComma: true });
      const result = strictCatalogManifestSchema.safeParse(
        parsed === undefined ? null : getNodeValue(parsed),
      );
      if (result.success) {
        console.log("  check: parses under the strict catalog manifest schema");
      } else {
        failed++;
        for (const issue of result.error.issues) {
          console.log(`  check: ${formatPath(issue.path) || "(root)"}: ${issue.message}`);
        }
      }
    }
  }
  if (check && failed > 0) process.exitCode = 1;
}

// Run only as a script, not when a test imports `migrate`.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
