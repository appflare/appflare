import { describe, expect, it } from "vitest";
import { catalogManifestSchema } from "./catalog.ts";
import { PATCHED_WRANGLER_CONFIG } from "./config-patch.ts";
import {
  inlineConfigPathProblem,
  inlineWranglerConfig,
  wranglerConfigInlineSchema,
} from "./wrangler-config-inline.ts";

function issues(value: unknown): string[] {
  const result = wranglerConfigInlineSchema.safeParse(value);
  return result.success
    ? []
    : result.error.issues.map((i) => `${i.path.join(".")}${i.path.length ? ": " : ""}${i.message}`);
}

const BASE = { main: "src/index.ts", compatibility_date: "2026-01-20" };

describe("wranglerConfigInlineSchema", () => {
  it("accepts a config of the allowed keys", () => {
    expect(
      issues({
        ...BASE,
        compatibility_flags: ["nodejs_compat"],
        assets: { directory: "./dist/client", binding: "ASSETS" },
        vars: { NAME: "Rin", LIMITS: { max: 5 } },
        triggers: { crons: ["*/20 * * * *"] },
        observability: { enabled: true, logs: { invocation_logs: true } },
        placement: { mode: "smart" },
        kv_namespaces: [{ binding: "CACHE" }],
        r2_buckets: [{ binding: "FILES" }],
        d1_databases: [{ binding: "DB", database_name: "rin", migrations_dir: "server/sql" }],
        queues: {
          producers: [{ binding: "EVENTS", queue: "events" }],
          consumers: [{ queue: "events", max_batch_size: 1 }],
        },
        durable_objects: { bindings: [{ name: "ROOM", class_name: "Room" }] },
        migrations: [{ tag: "v1", new_sqlite_classes: ["Room"] }],
        workflows: [{ binding: "JOBS", name: "jobs", class_name: "Jobs" }],
        services: [{ binding: "SELF", service: "rin" }],
        ai: { binding: "AI" },
        browser: { binding: "BROWSER" },
        images: { binding: "IMAGES" },
        version_metadata: { binding: "VERSION" },
      }),
    ).toEqual([]);
  });

  it("accepts a Worker of static assets only", () => {
    expect(issues({ compatibility_date: "2025-05-01", assets: { directory: "dist" } })).toEqual([]);
  });

  it("refuses keys outside the allowlist, naming why where it can", () => {
    expect(issues({ ...BASE, name: "rin" })).toEqual([
      "name: an inline wrangler config may not set name: the packer names the Worker after install.workerName; it may set only main, compatibility_date, compatibility_flags, assets, vars, triggers, observability, placement, kv_namespaces, r2_buckets, d1_databases, queues, durable_objects, migrations, workflows, services, ai, browser, images, version_metadata",
    ]);
    expect(issues({ ...BASE, vpc_services: [] })[0]).toMatch(
      /^vpc_services: an inline wrangler config may not set vpc_services: Appflare cannot install it;/,
    );
    expect(issues({ ...BASE, build: { command: "make" } })[0]).toContain("install.buildCommand");
    expect(issues({ ...BASE, account_id: "abc" })).toHaveLength(1);
    expect(
      issues(JSON.parse('{"main":"x.js","compatibility_date":"2026-01-01","__proto__":{}}')),
    ).toEqual([
      expect.stringMatching(/^__proto__: an inline wrangler config may not set __proto__/),
    ]);
  });

  it("refuses ids on storage bindings", () => {
    for (const [key, entry] of [
      ["kv_namespaces", { binding: "K", id: "abc" }],
      ["r2_buckets", { binding: "R", bucket_name: "bucket" }],
      ["d1_databases", { binding: "D", database_id: "uuid" }],
    ] as const) {
      expect(issues({ ...BASE, [key]: [entry] })).toEqual([
        expect.stringContaining("ids are left out, so the install provisions the resource"),
      ]);
    }
  });

  it("keeps Durable Objects in this Worker and SQLite-backed", () => {
    expect(issues({ ...BASE, migrations: [{ tag: "v1", new_classes: ["Room"] }] })[0]).toContain(
      "SQLite-backed",
    );
    expect(
      issues({
        ...BASE,
        durable_objects: { bindings: [{ name: "ROOM", class_name: "Room", script_name: "other" }] },
        migrations: [{ tag: "v1", new_sqlite_classes: ["Room"] }],
      })[0],
    ).toContain("the class is one of this Worker's");
    expect(
      issues({ ...BASE, durable_objects: { bindings: [{ name: "ROOM", class_name: "Room" }] } }),
    ).toEqual([
      "the Durable Object binding ROOM names the class Room, which the inline config's migrations do not create in new_sqlite_classes",
    ]);
    expect(
      issues({
        ...BASE,
        durable_objects: { bindings: [{ name: "ROOM", class_name: "Hall" }] },
        migrations: [
          { tag: "v1", new_sqlite_classes: ["Room"] },
          { tag: "v2", renamed_classes: [{ from: "Room", to: "Hall" }] },
        ],
      }),
    ).toEqual([]);
  });

  it("needs a compatibility date and main or assets", () => {
    expect(issues({ main: "x.js" })[0]).toMatch(/^compatibility_date: /);
    expect(issues({ compatibility_date: "2026-01-01" })).toEqual([
      "an inline config needs main, assets, or both",
    ]);
    expect(issues({ main: "../x.js", compatibility_date: "2026-01-01" })[0]).toMatch(/^main: /);
  });
});

describe("inlineConfigPathProblem", () => {
  it("allows only the packer's own file name, inside the repository", () => {
    expect(inlineConfigPathProblem(PATCHED_WRANGLER_CONFIG)).toBeNull();
    expect(inlineConfigPathProblem(`server/${PATCHED_WRANGLER_CONFIG}`)).toBeNull();
    for (const bad of [
      "wrangler.jsonc",
      `../${PATCHED_WRANGLER_CONFIG}`,
      `/abs/${PATCHED_WRANGLER_CONFIG}`,
      `dir\\${PATCHED_WRANGLER_CONFIG}`,
    ]) {
      expect(inlineConfigPathProblem(bad)).toContain("names where the packer writes it");
    }
  });

  it("puts the Worker's name first", () => {
    expect(Object.keys(inlineWranglerConfig({ ...BASE }, "rin"))).toEqual([
      "name",
      "main",
      "compatibility_date",
    ]);
  });
});

function manifest(install: Record<string, unknown>) {
  return catalogManifestSchema.safeParse({
    slug: "rin",
    name: "Rin",
    summary: "A blog.",
    homepage: "https://example.com",
    repo: "example/rin",
    license: "MIT",
    categories: ["blogging"],
    maintainers: ["example"],
    source: { ref: "main", sha: "0123456789abcdef0123456789abcdef01234567" },
    install: { tier: "artifact", packageManager: "npm", workerName: "rin", ...install },
    plan: "free",
    requires: [],
    secrets: [],
    vars: [],
    postInstall: [],
    tokenPermissions: [],
  });
}

function messages(install: Record<string, unknown>): string[] {
  const result = manifest(install);
  return result.success ? [] : result.error.issues.map((i) => i.message);
}

describe("install.wranglerConfigInline", () => {
  it("is accepted where wranglerConfig names the packer's file", () => {
    expect(
      messages({ wranglerConfig: PATCHED_WRANGLER_CONFIG, wranglerConfigInline: BASE }),
    ).toEqual([]);
  });

  it("is refused at another path, beside a config patch, and on a self-deploying entry", () => {
    expect(messages({ wranglerConfig: "wrangler.jsonc", wranglerConfigInline: BASE })).toEqual([
      expect.stringContaining("names where the packer writes it"),
    ]);
    expect(
      messages({
        wranglerConfig: PATCHED_WRANGLER_CONFIG,
        wranglerConfigInline: BASE,
        configPatch: { main: "dist/index.js" },
      }),
    ).toEqual([expect.stringContaining("change the inline config instead")]);
    expect(
      messages({
        tier: "self-deploying",
        wranglerConfig: PATCHED_WRANGLER_CONFIG,
        wranglerConfigInline: BASE,
      }),
    ).toContain(
      "install.wranglerConfigInline is not allowed for the self-deploying tier: its installer deploys the app without the packer that writes the config",
    );
  });

  it("is set per Worker in an app of several", () => {
    const workers = [
      {
        name: "web",
        wranglerConfig: PATCHED_WRANGLER_CONFIG,
        primary: true,
        wranglerConfigInline: BASE,
      },
      { name: "api", wranglerConfig: `api/${PATCHED_WRANGLER_CONFIG}`, wranglerConfigInline: BASE },
    ];
    expect(messages({ wranglerConfig: PATCHED_WRANGLER_CONFIG, workers })).toEqual([]);
    expect(
      messages({ wranglerConfig: PATCHED_WRANGLER_CONFIG, wranglerConfigInline: BASE, workers }),
    ).toEqual([
      expect.stringContaining("set wranglerConfigInline on the Worker whose config it is"),
    ]);
    expect(
      messages({
        wranglerConfig: PATCHED_WRANGLER_CONFIG,
        workers: [workers[0], { ...workers[1], wranglerConfig: "api/wrangler.toml" }],
      }),
    ).toEqual([expect.stringContaining("names where the packer writes it")]);
  });
});
