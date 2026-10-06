import { describe, expect, it } from "vitest";
import { catalogManifestSchema } from "./catalog";
import {
  applyMergePatch,
  type ConfigPatch,
  configPatchDiff,
  configPatchProblems,
  configPatchSchema,
  isClearableStorageId,
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
  tagline: "An app on Workers",
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
        "d1_databases, vars, migrations, ratelimits, ai, or null to drop a section Appflare cannot install or a key wrangler does not know",
    ]);
    expect(issues({ durable_objects: { bindings: [] } })[0]).toContain(
      "rename new_classes to new_sqlite_classes in migrations",
    );
    expect(issues({ queues: {} })[0]).toMatch(/^queues: a config patch may not set queues; it/);
    expect(issues({ main: "x.js", account_id: "abc" })).toHaveLength(1);
  });

  it("lets null drop a key wrangler does not know, and nothing else take its place", () => {
    // Which keys wrangler does not know is the packer's to check, when it applies the patch.
    expect(issues({ email: null })).toEqual([]);
    expect(issues({ email: { action: "drop" } })[0]).toMatch(
      /^email: a config patch may not set email; it may set only .*, or null to drop a section Appflare cannot install or a key wrangler does not know$/,
    );
    // A key refused for a reason stays refused, null or not.
    expect(issues({ name: null })[0]).toMatch(/^name: a config patch may not set name: /);
    expect(issues({ routes: null })[0]).toMatch(/^routes: a config patch may not set routes: /);
    expect(issues({ mtls_certificates: null })).toEqual([]);
  });

  it("allows build only as null, vars as text or removals, storage only as a list", () => {
    expect(issues({ build: { command: "make" } })).toEqual([
      "build: build may only be null, which removes the config's build",
    ]);
    expect(issues({ vars: { BASE_URL: "{{appUrl}}/gatekeeper/github", DEBUG: null } })).toEqual([]);
    expect(issues({ vars: { DEBUG: true } })).toEqual([
      "vars.DEBUG: a config patch sets a var to text, or removes it with null",
    ]);
    expect(issues({ vars: { LIST: ["a"] } })).toHaveLength(1);
    expect(issues({ kv_namespaces: null })).toHaveLength(1);
    expect(issues({ migrations: null })).toHaveLength(1);
    expect(issues({ assets: { directory: "x", serve_directly: true } })).toHaveLength(1);
  });

  it("refuses a __proto__ key rather than dropping it", () => {
    expect(issues(JSON.parse('{"main":"dist/index.js","__proto__":{"name":"x"}}'))).toEqual([
      "__proto__: a config patch may not set __proto__: it is not a wrangler config key; it " +
        "may set only main, assets, build, services, kv_namespaces, r2_buckets, d1_databases, " +
        "vars, migrations, ratelimits, ai, or null to drop a section Appflare cannot install or a key wrangler does not know",
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

  it("takes an ai binding by its name alone", () => {
    expect(issues({ ai: { binding: "WORKERS_AI" } })).toEqual([]);
    expect(issues({ ai: { binding: "AI", remote: true } })).toHaveLength(1);
    expect(issues({ ai: null })).toHaveLength(1);
  });

  it("takes props on a service binding only as an object", () => {
    expect(
      issues({
        services: [{ binding: "CTX", service: "context", props: { sharingDomain: "{{appUrl}}" } }],
      }),
    ).toEqual([]);
    expect(issues({ services: [{ binding: "CTX", service: "context", props: "x" }] })).toHaveLength(
      1,
    );
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

  const twoWorkers = (gatekeeper: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    catalogManifestSchema.safeParse({
      ...manifest,
      plan: "paid",
      requires: ["config-patch-values"],
      ...extra,
      install: {
        ...manifest.install,
        workers: [
          { name: "router", wranglerConfig: "wrangler.jsonc", primary: true },
          { name: "github", wranglerConfig: "github/wrangler.jsonc", configPatch: gatekeeper },
        ],
      },
    });

  it("lets a Worker's patch set a var of its own, with the placeholders a var default takes", () => {
    const parsed = twoWorkers({ vars: { BASE_URL: "{{appUrl}}/gatekeeper/github" } });
    expect(parsed.error?.issues).toBeUndefined();
    const wrong = twoWorkers({ vars: { BASE_URL: "{{appurl}}/x", OTHER: "{{appUrl:nope}}" } });
    expect(wrong.error?.issues.map((i) => i.path.join("."))).toEqual([
      "install.workers.1.configPatch.vars.BASE_URL",
      "install.workers.1.configPatch.vars.OTHER",
    ]);
  });

  it("refuses a patched var with the name of a secret its Worker gets", () => {
    const secret = { name: "BASE_URL", label: "Base", workers: ["github"] };
    const clash = twoWorkers({ vars: { BASE_URL: "x" } }, { secrets: [secret] });
    expect(clash.error?.issues.map((i) => i.message)).toEqual([
      "the patch sets the var BASE_URL, which is also a secret this Worker gets; a Worker cannot have a secret and a var of one name",
    ]);
    const elsewhere = twoWorkers(
      { vars: { BASE_URL: "x" } },
      { secrets: [{ ...secret, workers: ["router"] }] },
    );
    expect(elsewhere.success).toBe(true);
  });

  it('needs "service-props" for props on a patched service binding', () => {
    const props = {
      services: [{ binding: "CTX", service: "router", props: { sharingDomain: "{{appUrl}}" } }],
    };
    expect(twoWorkers(props).error?.issues.map((i) => i.message)).toEqual([
      'a config patch gives a service binding props, so requires must list "service-props": a manager that does not know props refuses the binding',
    ]);
    expect(twoWorkers(props, { requires: ["service-props"] }).success).toBe(true);
    expect(twoWorkers(props, { requires: ["config-patch-values"] }).success).toBe(false);
    const badPlaceholder = twoWorkers(
      { services: [{ binding: "CTX", service: "router", props: { at: ["{{AppUrl}}"] } }] },
      { requires: ["service-props"] },
    );
    expect(badPlaceholder.error?.issues[0]?.path).toEqual([
      "install",
      "workers",
      1,
      "configPatch",
      "services",
      0,
      "props",
    ]);
  });

  it('needs "config-patch-values" for var text or an ai binding, not for removals', () => {
    const message =
      'a config patch sets var text or a Workers AI binding (install.workers[1].configPatch.vars.BASE_URL), so requires must list "config-patch-values": a manager that predates them refuses the patch';
    expect(
      twoWorkers({ vars: { BASE_URL: "x" } }, { requires: [] }).error?.issues.map((i) => i.message),
    ).toEqual([message]);
    expect(
      twoWorkers({ ai: { binding: "AI" } }, { requires: [] }).error?.issues[0]?.message,
    ).toContain("install.workers[1].configPatch.ai");
    expect(twoWorkers({ ai: { binding: "AI" } }).success).toBe(true);
    expect(twoWorkers({ vars: { DEBUG: null } }, { requires: [] }).success).toBe(true);
  });

  it("refuses a patched var that a catalog var going to the same Worker would replace", () => {
    const clash = twoWorkers(
      { vars: { BASE_URL: "x" } },
      { vars: [{ name: "BASE_URL", label: "Base", optional: true }] },
    );
    expect(clash.error?.issues.map((i) => i.message)).toEqual([
      "the patch sets the var BASE_URL, which a catalog var of that name going to this Worker would replace; set it in one place, or give the catalog var workers that leave this Worker out",
    ]);
    const elsewhere = twoWorkers(
      { vars: { BASE_URL: "x" } },
      { vars: [{ name: "BASE_URL", label: "Base", optional: true, workers: ["router"] }] },
    );
    expect(elsewhere.success).toBe(true);
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

  it("lets storage lists clear an id that is a placeholder for a deploy script", () => {
    const raw = {
      kv_namespaces: [
        { binding: "A", id: "$KV_ID" },
        { binding: "B", id: "${KV_NAMESPACE_ID}" },
        { binding: "C", id: "{{ kv.id }}" },
        { binding: "D", id: "<your-kv-namespace-id>" },
      ],
      r2_buckets: [{ binding: "FILES", bucket_name: "${BUCKET_NAME}" }],
      d1_databases: [{ binding: "DB", database_name: "app", database_id: "{{D1_ID}}" }],
    };
    expect(
      configPatchProblems(
        raw,
        patch({
          kv_namespaces: [{ binding: "A" }, { binding: "B" }, { binding: "C" }, { binding: "D" }],
          r2_buckets: [{ binding: "FILES" }],
          d1_databases: [{ binding: "DB", database_name: "app" }],
        }),
        none,
      ),
    ).toEqual([]);
  });

  it("refuses clearing an id that is neither empty nor a placeholder", () => {
    for (const id of ["0123abcd", "$", "${}", "{{}}", "<>", "prefix-$KV_ID", "$(cat id)"]) {
      expect(isClearableStorageId(id)).toBe(false);
    }
    expect(isClearableStorageId(3)).toBe(false);
  });

  it("refuses clearing an id that is not empty", () => {
    const raw = { kv_namespaces: [{ binding: "KV", id: "0123abcd" }] };
    expect(
      configPatchProblems(raw, patch({ kv_namespaces: [{ binding: "KV" }] }), none),
    ).toHaveLength(1);
  });

  it("lets ratelimits only add rate limits", () => {
    const kept = { name: "API", namespace_id: "1001", simple: { limit: 100, period: 60 } };
    const lookup = { name: "LOOKUP", namespace_id: "1002", simple: { limit: 10, period: 10 } };
    const raw = { ratelimits: [kept] };
    expect(configPatchProblems(raw, patch({ ratelimits: [kept, lookup] }), none)).toEqual([]);
    expect(configPatchProblems({}, patch({ ratelimits: [lookup] }), none)).toEqual([]);
    expect(configPatchProblems(raw, patch({ ratelimits: [lookup] }), none)).toEqual([
      "ratelimits leaves out the binding API; a patch may only add rate limits, never remove one",
    ]);
    expect(
      configPatchProblems(
        raw,
        patch({ ratelimits: [{ ...kept, simple: { limit: 5, period: 60 } }] }),
        none,
      ),
    ).toEqual([
      "ratelimits changes the binding API; a patch may only add rate limits, keeping the config's as they are",
    ]);
    expect(configPatchProblems({}, patch({ ratelimits: [lookup, lookup] }), none)).toEqual([
      "ratelimits names the binding LOOKUP twice",
    ]);
    expect(issues({ ratelimits: [{ ...lookup, simple: { limit: 10, period: 30 } }] })).toHaveLength(
      1,
    );
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

describe("configPatchProblems: ai", () => {
  it("adds a Workers AI binding only where the config has none, or the same one", () => {
    const ai = patch({ ai: { binding: "WORKERS_AI" } });
    expect(configPatchProblems({}, ai, new Set())).toEqual([]);
    expect(configPatchProblems({ ai: { binding: "WORKERS_AI" } }, ai, new Set())).toEqual([]);
    expect(configPatchProblems({ ai: { binding: "AI" } }, ai, new Set())).toEqual([
      "ai changes the config's own Workers AI binding; a patch may only add one to a config that has none",
    ]);
  });
});

describe("patchWranglerConfig", () => {
  it("sets a var over the config's own and adds new ones", () => {
    const { config, diff } = patchWranglerConfig(
      { name: "gk", vars: { BASE_URL: "http://localhost", KEEP: "x" } },
      patch({ vars: { BASE_URL: "{{appUrl}}/gatekeeper/github", NEW: "y" } }),
      new Set(),
    );
    expect(config.vars).toEqual({
      BASE_URL: "{{appUrl}}/gatekeeper/github",
      KEEP: "x",
      NEW: "y",
    });
    expect(diff).toEqual([
      'vars.BASE_URL: "http://localhost" -> "{{appUrl}}/gatekeeper/github"',
      'vars.NEW: added "y"',
    ]);
  });

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
