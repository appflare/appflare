#!/usr/bin/env node
// Rewrites catalog manifests (appflare.jsonc) written for the schema before
// v1 into the v1 shape, keeping comments and layout: every change is a
// targeted edit of the file's text, never a re-serialisation.
//
//   node scripts/codemod-manifest-v1.mjs [--write | --out <dir>] [--check] <appflare.jsonc>...
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
// Needs Node 22.18 or later: it reads the schema's own TypeScript sources
// (the permission groups, the licence rules, the strict schema) through
// Node's type stripping, so it always agrees with this version of the schema.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { strictCatalogManifestSchema } from "../src/catalog.ts";
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

/** Rewrites one manifest's text; returns the document with its record of changes. */
export function migrate(text) {
  const doc = new Document(text);
  const manifest = doc.get([]);
  if (manifest === null || typeof manifest !== "object") {
    doc.todos.push("not a JSON object; nothing done");
    return doc;
  }
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
    const health = {};
    if (install.healthPath !== undefined && install.healthPath !== "/")
      health.path = install.healthPath;
    if (install.healthMode !== undefined && install.healthMode !== "default") {
      health.mode = install.healthMode;
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
      doc.remove(["install", first], "the default health check");
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
  (manifest.vars ?? []).forEach((v, i) => {
    const at = ["vars", i];
    const keepsValue = v.derive !== undefined || v.seedOnly === true;
    if (v.required === true) {
      doc.remove([...at, "required"], "a var needs a value unless it is optional");
    } else if (keepsValue) {
      if (v.required !== undefined)
        doc.remove([...at, "required"], "a derived or seed-only var always has a value");
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
    if (arg === "--write") write = true;
    else if (arg === "--check") check = true;
    else if (arg === "--out") out = argv[++i];
    else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else files.push(arg);
  }
  if (files.length === 0) {
    console.error(
      "usage: codemod-manifest-v1.mjs [--write | --out <dir>] [--check] <appflare.jsonc>...",
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
