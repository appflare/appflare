import { describe, expect, it } from "vitest";
import { catalogManifestSchema } from "./catalog";
import {
  applyMergePatch,
  type ConfigPatch,
  configPatchDiff,
  configPatchProblems,
  configPatchSchema,
  patchWranglerConfig,
} from "./config-patch";

function issues(value: unknown): string[] {
  const parsed = configPatchSchema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

function patch(value: unknown): ConfigPatch {
  return configPatchSchema.parse(value);
}

const manifest = {
  slug: "mdpage",
  name: "md.page",
  summary: "Publish markdown as a page.",
  homepage: "https://example.com",
  repo: "example/mdpage",
  license: "MIT",
  categories: ["utilities"],
  maintainers: ["example"],
  source: { ref: "v1.0.0", sha: "0".repeat(40) },
  install: {
    tier: "artifact",
    packageManager: "pnpm",
    wranglerConfig: "wrangler.jsonc",
    workerName: "mdpage",
  },
  plan: "free",
  requires: [],
  secrets: [],
  vars: [],
  postInstall: [],
  tokenPermissions: [],
};

describe("configPatchSchema", () => {
  it("accepts every allowlisted key in the shape it allows", () => {
    expect(
      issues({
        main: "dist/index.js",
        assets: { directory: "./dist/client", binding: null },
        build: null,
        services: [{ binding: "SELF", service: "app" }],
        kv_namespaces: [{ binding: "KV" }],
        r2_buckets: [{ binding: "FILES" }],
        d1_databases: [{ binding: "DB", database_name: "app" }],
        vars: { DEBUG: null },
        migrations: [{ tag: "v1", new_sqlite_classes: ["Room"] }],
      }),
    ).toEqual([]);
    expect(issues({ services: null })).toEqual([]);
    expect(issues({ vars: null })).toEqual([]);
    expect(issues({ assets: null })).toEqual([]);
  });

  it("refuses keys outside the allowlist, naming why where it can", () => {
    expect(issues({ name: "other" })).toEqual([
      "name: a config patch may not set name: the Worker's name comes from the install, not " +
        "the config; it may set only main, assets, build, services, kv_namespaces, r2_buckets, " +
        "d1_databases, vars, migrations",
    ]);
    expect(issues({ durable_objects: { bindings: [] } })[0]).toContain(
      "rename new_classes to new_sqlite_classes in migrations",
    );
    expect(issues({ queues: {} })[0]).toMatch(/^queues: a config patch may not set queues; it/);
    expect(issues({ main: "x.js", account_id: "abc" })).toHaveLength(1);
  });

  it("allows build only as null, vars only as removals, storage only as a list", () => {
    expect(issues({ build: { command: "make" } })).toEqual([
      "build: build may only be null, which removes the config's build",
    ]);
    expect(issues({ vars: { DEBUG: "true" } })).toEqual([
      "vars.DEBUG: a config patch may only remove vars, with null",
    ]);
    expect(issues({ kv_namespaces: null })).toHaveLength(1);
    expect(issues({ migrations: null })).toHaveLength(1);
    expect(issues({ assets: { directory: "x", serve_directly: true } })).toHaveLength(1);
  });

  it("refuses a __proto__ key rather than dropping it", () => {
    expect(issues(JSON.parse('{"main":"dist/index.js","__proto__":{"name":"x"}}'))).toEqual([
      "__proto__: a config patch may not set __proto__: it is not a wrangler config key; it " +
        "may set only main, assets, build, services, kv_namespaces, r2_buckets, d1_databases, " +
        "vars, migrations",
    ]);
  });

  it("keeps main and assets.directory relative to the config and inside it", () => {
    for (const ok of ["dist/index.js", "./dist/index.js", "build/..hidden/x.js", "a..b.js"]) {
      expect(issues({ main: ok, assets: { directory: ok } })).toEqual([]);
    }
    for (const bad of [
      "/etc/x.js",
      "\\share\\x.js",
      "C:/x.js",
      "../x.js",
      "dist/../../x.js",
      "..",
    ]) {
      expect(issues({ main: bad })).toEqual([
        "main: must be a path relative to the wrangler config, not absolute and without ..",
      ]);
      expect(issues({ assets: { directory: bad } })).toHaveLength(1);
    }
  });

  it("refuses an empty patch", () => {
    expect(issues({})).toEqual([": a config patch changes at least one key"]);
  });
});

describe("the catalog manifest's configPatch", () => {
  it("is accepted on an entry of one Worker and on each Worker of several", () => {
    const one = catalogManifestSchema.parse({
      ...manifest,
      install: { ...manifest.install, configPatch: { build: null } },
    });
    expect(one.install.configPatch).toEqual({ build: null });
    const several = catalogManifestSchema.safeParse({
      ...manifest,
      install: {
        ...manifest.install,
        workers: [
          {
            name: "web",
            wranglerConfig: "wrangler.jsonc",
            primary: true,
            configPatch: { vars: { X: null } },
          },
          { name: "api", wranglerConfig: "api/wrangler.jsonc" },
        ],
      },
    });
    expect(several.success).toBe(true);
  });

  it("is refused beside install.workers and on a self-deploying entry", () => {
    const beside = catalogManifestSchema.safeParse({
      ...manifest,
      install: {
        ...manifest.install,
        configPatch: { build: null },
        workers: [
          { name: "web", wranglerConfig: "wrangler.jsonc", primary: true },
          { name: "api", wranglerConfig: "api/wrangler.jsonc" },
        ],
      },
    });
    expect(beside.success).toBe(false);
    expect(beside.error?.issues.map((i) => i.message)).toContain(
      "install.configPatch is for an app of one Worker; with install.workers, set configPatch on the Worker whose config it changes",
    );
    const selfDeploying = catalogManifestSchema.safeParse({
      ...manifest,
      install: { ...manifest.install, tier: "self-deploying", configPatch: { build: null } },
    });
    expect(
      selfDeploying.error?.issues.some(
        (i) => i.path.join(".") === "install.configPatch" && i.message.includes("self-deploying"),
      ),
    ).toBe(true);
  });

  it("refuses a patch that sets a key outside the allowlist", () => {
    const parsed = catalogManifestSchema.safeParse({
      ...manifest,
      install: { ...manifest.install, configPatch: { routes: [] } },
    });
    expect(parsed.error?.issues[0]?.path).toEqual(["install", "configPatch", "routes"]);
  });
});

describe("applyMergePatch (RFC 7386)", () => {
  it("merges objects key by key, removes keys set to null, and replaces arrays", () => {
    const target = {
      main: "src/index.ts",
      build: { command: "npm run build" },
      vars: { A: "1", B: "2" },
      assets: { directory: "./public", binding: "ASSETS" },
      services: [{ binding: "X", service: "x" }],
    };
    const result = applyMergePatch(target, {
      main: "dist/index.js",
      build: null,
      vars: { A: null },
      assets: { directory: "./dist" },
      services: [],
    });
    expect(result).toEqual({
      main: "dist/index.js",
      vars: { B: "2" },
      assets: { directory: "./dist", binding: "ASSETS" },
      services: [],
    });
    // Neither input changes.
    expect(target.vars).toEqual({ A: "1", B: "2" });
    expect(target.build).toEqual({ command: "npm run build" });
  });

  it("follows the RFC's examples for missing and non-object targets", () => {
    expect(applyMergePatch({ a: "b" }, { a: "c" })).toEqual({ a: "c" });
    expect(applyMergePatch({ a: "b" }, { b: "c" })).toEqual({ a: "b", b: "c" });
    expect(applyMergePatch({ a: "b" }, { a: null })).toEqual({});
    expect(applyMergePatch({ a: [{ b: "c" }] }, { a: [1] })).toEqual({ a: [1] });
    expect(applyMergePatch(["a", "b"], ["c", "d"])).toEqual(["c", "d"]);
    expect(applyMergePatch({ a: "foo" }, "bar")).toBe("bar");
    expect(applyMergePatch({ e: null }, { a: 1 })).toEqual({ e: null, a: 1 });
    expect(applyMergePatch({}, { a: { bb: { ccc: null } } })).toEqual({ a: { bb: {} } });
  });

  it("keeps a key named __proto__ an own property, never the prototype", () => {
    const result = applyMergePatch({}, JSON.parse('{"vars":{"__proto__":{"polluted":true}}}')) as {
      vars: Record<string, unknown>;
    };
    expect(Object.getPrototypeOf(result.vars)).toBe(Object.prototype);
    expect(Object.hasOwn(result.vars, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("configPatchProblems", () => {
  const none = new Set<string>();

  it("lets services leave bindings out, and add one only to a Worker of the entry", () => {
    const raw = {
      name: "deepcrawl",
      services: [
        { binding: "AUTH_WORKER", service: "deepcrawl-auth" },
        { binding: "SELF", service: "deepcrawl" },
      ],
    };
    const entry = new Set(["deepcrawl", "deepcrawl-api"]);
    expect(
      configPatchProblems(
        raw,
        patch({ services: [{ binding: "SELF", service: "deepcrawl" }] }),
        entry,
      ),
    ).toEqual([]);
    expect(configPatchProblems(raw, patch({ services: null }), entry)).toEqual([]);
    expect(
      configPatchProblems(
        raw,
        patch({ services: [{ binding: "API", service: "deepcrawl-api" }] }),
        entry,
      ),
    ).toEqual([]);
    const outside = configPatchProblems(
      raw,
      patch({ services: [{ binding: "AUTH_WORKER", service: "someone-else" }] }),
      entry,
    );
    expect(outside).toHaveLength(1);
    expect(outside[0]).toContain("services adds or changes the binding AUTH_WORKER");
    expect(
      configPatchProblems(
        raw,
        patch({
          services: [
            { binding: "SELF", service: "deepcrawl" },
            { binding: "SELF", service: "deepcrawl-api" },
          ],
        }),
        entry,
      ),
    ).toContain("services names the binding SELF twice");
  });

  it("lets storage lists add bindings and clear an empty id, and nothing else", () => {
    const raw = {
      kv_namespaces: [{ binding: "KV", id: "" }],
      r2_buckets: [{ binding: "FILES", bucket_name: "" }],
      d1_databases: [{ binding: "DB", database_name: "md", database_id: "" }],
    };
    expect(
      configPatchProblems(
        raw,
        patch({
          kv_namespaces: [{ binding: "KV" }, { binding: "CACHE" }],
          r2_buckets: [{ binding: "FILES" }],
          d1_databases: [{ binding: "DB", database_name: "md" }],
        }),
        none,
      ),
    ).toEqual([]);
    // Unchanged entries are fine too.
    expect(configPatchProblems(raw, patch({ kv_namespaces: raw.kv_namespaces }), none)).toEqual([]);
    expect(
      configPatchProblems(raw, patch({ kv_namespaces: [{ binding: "OTHER" }] }), none),
    ).toEqual([
      "kv_namespaces leaves out the binding KV; a patch may only add storage bindings, never remove one",
    ]);
    expect(
      configPatchProblems(raw, patch({ kv_namespaces: [{ binding: "KV", id: "abc" }] }), none)[0],
    ).toMatch(/^kv_namespaces changes the binding KV;/);
    expect(
      configPatchProblems(
        raw,
        patch({ d1_databases: [{ binding: "DB", database_name: "other" }] }),
        none,
      )[0],
    ).toMatch(/^d1_databases changes the binding DB;/);
  });

  it("refuses clearing an id that is not empty", () => {
    const raw = { kv_namespaces: [{ binding: "KV", id: "0123abcd" }] };
    expect(
      configPatchProblems(raw, patch({ kv_namespaces: [{ binding: "KV" }] }), none),
    ).toHaveLength(1);
  });

  it("lets migrations only rename new_classes to new_sqlite_classes", () => {
    const raw = {
      migrations: [
        { tag: "v1", new_classes: ["Mailbox"] },
        { tag: "v2", new_sqlite_classes: ["Queue"], new_classes: ["Stats"] },
        { tag: "v3", deleted_classes: ["Stats"] },
      ],
    };
    const renamed = [
      { tag: "v1", new_sqlite_classes: ["Mailbox"] },
      { tag: "v2", new_sqlite_classes: ["Queue", "Stats"] },
      { tag: "v3", deleted_classes: ["Stats"] },
    ];
    expect(configPatchProblems(raw, patch({ migrations: renamed }), none)).toEqual([]);
    expect(
      configPatchProblems(raw, patch({ migrations: [renamed[0], renamed[1]] }), none)[0],
    ).toMatch(/^migrations has 2 migrations where the config has 3;/);
    expect(
      configPatchProblems(
        raw,
        patch({
          migrations: [{ tag: "v1", new_sqlite_classes: ["Other"] }, renamed[1], renamed[2]],
        }),
        none,
      ),
    ).toEqual([
      "migrations changes the migration v1 otherwise; a patch may only rename new_classes to new_sqlite_classes in the config's own migrations",
    ]);
  });
});

describe("patchWranglerConfig", () => {
  it("returns the patched config and one diff line per changed path", () => {
    const raw = {
      name: "nodrix",
      main: "src/index.ts",
      build: { command: "npm run build" },
      vars: { DEBUG: "true", NAME: "x" },
    };
    const { config, diff } = patchWranglerConfig(
      raw,
      patch({ main: "dist/index.js", build: null, vars: { DEBUG: null } }),
      new Set(),
    );
    expect(config).toEqual({ name: "nodrix", main: "dist/index.js", vars: { NAME: "x" } });
    expect(diff).toEqual([
      "build: removed",
      'main: "src/index.ts" -> "dist/index.js"',
      "vars.DEBUG: removed",
    ]);
  });

  it("throws with every problem at once", () => {
    expect(() =>
      patchWranglerConfig(
        { kv_namespaces: [{ binding: "KV", id: "x" }], services: [] },
        patch({ kv_namespaces: [], services: [{ binding: "S", service: "elsewhere" }] }),
        new Set(),
      ),
    ).toThrow(/cannot be applied: services adds .*; kv_namespaces leaves out the binding KV/);
  });
});

describe("configPatchDiff", () => {
  it("shows additions and replacements, never a removed value", () => {
    expect(
      configPatchDiff(
        { vars: { SECRETISH: "value" }, kv_namespaces: [{ binding: "KV", id: "" }] },
        { vars: {}, kv_namespaces: [{ binding: "KV" }], main: "x.js" },
      ),
    ).toEqual([
      'kv_namespaces: [{"binding":"KV","id":""}] -> [{"binding":"KV"}]',
      'main: added "x.js"',
      "vars.SECRETISH: removed",
    ]);
  });
});
