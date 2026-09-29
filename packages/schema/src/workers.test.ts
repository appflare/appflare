import { describe, expect, it } from "vitest";
import {
  type ArtifactManifest,
  artifactManifestSchema,
  isEntryServiceBinding,
  serviceBindingProblem,
} from "./artifact";
import { catalogManifestSchema, MAX_ENTRY_WORKERS, MAX_FREE_PLAN_ENTRY_WORKERS } from "./catalog";
import {
  appWorkerCount,
  appWorkers,
  appWorkersInDeployOrder,
  combinedWorkerFacts,
  entryPlaceholderValues,
  entryScriptName,
  entryScriptNames,
  entryWorkerOnWorkersDev,
  entryWorkerOrder,
  entryWorkerRef,
  entryWorkerRefName,
  secretTargets,
  varTargets,
  workerManifest,
} from "./workers";

const sha256 = "a".repeat(64);
const gitSha = "b".repeat(40);

function worker(name: string, bindings: unknown[] = [], extra: Record<string, unknown> = {}) {
  return {
    name,
    wranglerConfig: { declared: `${name}/wrangler.jsonc`, effective: `${name}/wrangler.jsonc` },
    mainModule: "index.js",
    compatibilityDate: "2026-06-01",
    compatibilityFlags: ["nodejs_compat"],
    modules: [
      {
        name: "index.js",
        type: "esm",
        path: `worker/${name}/index.js`,
        size: 1,
        sha256,
        offset: 0,
      },
    ],
    bindings,
    migrations: [],
    crons: [],
    observability: null,
    placement: null,
    limits: null,
    ...extra,
  };
}

const noAssets = { config: {}, binding: null, files: [] };

function catalog(install: Record<string, unknown> = {}, rest: Record<string, unknown> = {}) {
  return {
    slug: "glance",
    name: "Glance",
    summary: "Share what your agents built.",
    tagline: "Share what your agents built",
    repo: "plivo-labs/glance",
    license: "MIT",
    categories: ["developer-tools"],
    maintainers: ["MendyLanda"],
    source: { ref: "main", sha: gitSha },
    install: {
      tier: "artifact",
      packageManager: "bun",
      wranglerConfig: "packages/api/wrangler.jsonc",
      workerName: "glance",
      workers: [
        { name: "app", wranglerConfig: "packages/api/wrangler.jsonc", primary: true },
        { name: "content", wranglerConfig: "packages/api/wrangler.content.jsonc" },
      ],
      ...install,
    },
    plan: "free",
    requires: [],
    secrets: [],
    vars: [],
    postInstall: [],
    tokenPermissions: [],
    ...rest,
  };
}

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    format: 1,
    app: "glance",
    version: "0.0.0-20260926.bbbbbbb",
    builtAt: "2026-09-26T12:00:00Z",
    builder: "@appflare/pack@0.5.0",
    keyId: "unsigned",
    worker: worker("glance", [
      { type: "d1", name: "GLANCE_DB" },
      { type: "r2_bucket", name: "GLANCE_FILES" },
      { type: "plain_text", name: "APP_URL", text: "https://glance.example.workers.dev" },
    ]),
    assets: noAssets,
    d1: {
      GLANCE_DB: {
        migrations: [
          { name: "0000_init.sql", path: "d1/GLANCE_DB/0000_init.sql", size: 1, sha256, offset: 9 },
        ],
      },
    },
    workers: [
      {
        name: "content",
        worker: worker("glance-content", [
          { type: "d1", name: "GLANCE_DB" },
          { type: "r2_bucket", name: "GLANCE_FILES" },
          { type: "service", name: "APP", service: "{{workerName:app}}" },
        ]),
        assets: noAssets,
      },
    ],
    catalog: catalog(),
    ...overrides,
  };
}

function parsed(input: unknown): ArtifactManifest {
  return artifactManifestSchema.parse(input);
}

describe("install.workers in the catalog manifest", () => {
  it("accepts an entry of several Workers with one primary", () => {
    expect(catalogManifestSchema.safeParse(catalog()).success).toBe(true);
  });

  it(`accepts up to ${MAX_ENTRY_WORKERS} Workers and refuses more`, () => {
    const entry = (count: number) =>
      catalog(
        {
          workers: [
            { name: "app", wranglerConfig: "packages/api/wrangler.jsonc", primary: true },
            ...Array.from({ length: count - 1 }, (_, i) => ({
              name: `gk-${i + 1}`,
              wranglerConfig: `gatekeepers/${i + 1}/wrangler.jsonc`,
            })),
          ],
        },
        { plan: "paid" },
      );
    expect(MAX_ENTRY_WORKERS).toBe(24);
    expect(catalogManifestSchema.safeParse(entry(18)).success).toBe(true);
    expect(catalogManifestSchema.safeParse(entry(MAX_ENTRY_WORKERS)).success).toBe(true);
    expect(JSON.stringify(catalogManifestSchema.safeParse(entry(25)).error?.issues)).toContain(
      "an entry installs at most 24 Workers",
    );
  });

  it(`needs "plan": "paid" for more than ${MAX_FREE_PLAN_ENTRY_WORKERS} Workers`, () => {
    const entry = (count: number, plan: string) =>
      catalog(
        {
          workers: [
            { name: "app", wranglerConfig: "packages/api/wrangler.jsonc", primary: true },
            ...Array.from({ length: count - 1 }, (_, i) => ({
              name: `w-${i + 1}`,
              wranglerConfig: `w/${i + 1}/wrangler.jsonc`,
            })),
          ],
        },
        { plan },
      );
    expect(catalogManifestSchema.safeParse(entry(3, "free")).success).toBe(true);
    const issues = catalogManifestSchema.safeParse(entry(4, "free")).error?.issues;
    expect(issues?.map((i) => i.path)).toEqual([["plan"]]);
    expect(issues?.[0]?.message).toBe(
      'an entry of 4 Workers needs "plan": "paid": on Workers Free one job installs or updates at most 3 Workers, within the 50 subrequests the free plan allows it',
    );
    expect(catalogManifestSchema.safeParse(entry(4, "paid")).success).toBe(true);
  });

  it("needs exactly one primary Worker whose config is install.wranglerConfig", () => {
    const none = catalog({
      workers: [
        { name: "app", wranglerConfig: "packages/api/wrangler.jsonc" },
        { name: "content", wranglerConfig: "packages/api/wrangler.content.jsonc" },
      ],
    });
    expect(JSON.stringify(catalogManifestSchema.safeParse(none).error?.issues)).toContain(
      "exactly one Worker",
    );
    const elsewhere = catalog({ wranglerConfig: "wrangler.jsonc" });
    expect(JSON.stringify(catalogManifestSchema.safeParse(elsewhere).error?.issues)).toContain(
      "primary Worker's wranglerConfig",
    );
  });

  it("refuses duplicate names and configs, bad names, a single Worker and other tiers", () => {
    const dupes = catalog({
      workers: [
        { name: "app", wranglerConfig: "packages/api/wrangler.jsonc", primary: true },
        { name: "app", wranglerConfig: "packages/api/wrangler.jsonc" },
      ],
    });
    const issues = JSON.stringify(catalogManifestSchema.safeParse(dupes).error?.issues);
    expect(issues).toContain('two Workers are named \\"app\\"');
    expect(issues).toContain("two Workers are built from");
    const badName = catalog({
      workers: [
        { name: "App", wranglerConfig: "packages/api/wrangler.jsonc", primary: true },
        { name: "content", wranglerConfig: "b.jsonc" },
      ],
    });
    expect(catalogManifestSchema.safeParse(badName).success).toBe(false);
    const one = catalog({
      workers: [{ name: "app", wranglerConfig: "packages/api/wrangler.jsonc", primary: true }],
    });
    expect(catalogManifestSchema.safeParse(one).success).toBe(false);
    const sandbox = catalog({ tier: "sandbox" });
    expect(JSON.stringify(catalogManifestSchema.safeParse(sandbox).error?.issues)).toContain(
      "only for the artifact tier",
    );
  });

  it("takes a build command or a list of them per Worker", () => {
    const built = catalog({
      workers: [
        {
          name: "app",
          wranglerConfig: "packages/api/wrangler.jsonc",
          primary: true,
          buildCommand: ["bun run build:web"],
        },
        {
          name: "content",
          wranglerConfig: "packages/api/wrangler.content.jsonc",
          buildCommand: "bun run build:annotate",
        },
      ],
    });
    expect(catalogManifestSchema.safeParse(built).success).toBe(true);
    const shell = catalog({
      workers: [
        { name: "app", wranglerConfig: "packages/api/wrangler.jsonc", primary: true },
        {
          name: "content",
          wranglerConfig: "packages/api/wrangler.content.jsonc",
          buildCommand: "bun run a && bun run b",
        },
      ],
    });
    expect(catalogManifestSchema.safeParse(shell).success).toBe(false);
  });

  it("checks the Workers a secret or var names", () => {
    const ok = catalog(
      {},
      {
        secrets: [
          { name: "SESSION_SECRET", label: "Session", generate: "password", workers: ["app"] },
        ],
        vars: [{ name: "APP_URL", label: "App URL", workers: ["app", "content"] }],
      },
    );
    expect(catalogManifestSchema.safeParse(ok).success).toBe(true);
    const unknown = catalog(
      {},
      { secrets: [{ name: "S", label: "S", generate: "password", workers: ["web"] }] },
    );
    expect(JSON.stringify(catalogManifestSchema.safeParse(unknown).error?.issues)).toContain(
      'names the Worker \\"web\\"',
    );
    const single = catalog(
      { workers: undefined },
      { vars: [{ name: "APP_URL", label: "App URL", workers: ["app"] }] },
    );
    expect(JSON.stringify(catalogManifestSchema.safeParse(single).error?.issues)).toContain(
      "only for an entry that installs several Workers",
    );
  });
});

describe("an artifact of several Workers", () => {
  it("parses an artifact of several Workers", () => {
    const manifest = parsed(artifact());
    expect(manifest.format).toBe(1);
    expect(appWorkerCount(manifest)).toBe(2);
    expect(appWorkers(manifest).map((w) => [w.name, w.primary])).toEqual([
      ["app", true],
      ["content", false],
    ]);
  });

  it("refuses an artifact without workers whose catalog manifest declares several Workers", () => {
    const { workers: _w, ...rest } = artifact();
    const result = artifactManifestSchema.safeParse(rest);
    expect(JSON.stringify(result.error?.issues)).toContain(
      "must list every Worker besides the primary one in workers",
    );
  });

  it("refuses an artifact of one Worker with a binding to another Worker of an entry", () => {
    const { workers: _w, ...rest } = artifact();
    const result = artifactManifestSchema.safeParse({
      ...rest,
      catalog: catalog({ workers: undefined }),
      worker: worker("glance", [{ type: "service", name: "C", service: "{{workerName:content}}" }]),
      d1: {},
    });
    expect(JSON.stringify(result.error?.issues)).toContain("names another Worker of the entry");
  });

  it("refuses Workers that do not match the catalog manifest", () => {
    const result = artifactManifestSchema.safeParse(
      artifact({ workers: [{ name: "web", worker: worker("web"), assets: noAssets }] }),
    );
    expect(JSON.stringify(result.error?.issues)).toContain(
      "are not the catalog manifest's Workers",
    );
  });

  it("refuses a binding to a Worker the entry does not have", () => {
    const bad = artifact({
      workers: [
        {
          name: "content",
          worker: worker("glance-content", [
            { type: "service", name: "API", service: "{{workerName:api}}" },
          ]),
          assets: noAssets,
        },
      ],
    });
    expect(JSON.stringify(artifactManifestSchema.safeParse(bad).error?.issues)).toContain(
      'names the Worker \\"api\\", which the entry does not have',
    );
  });

  it("refuses bindings of one name with different types or shapes", () => {
    const bad = artifact({
      workers: [
        {
          name: "content",
          worker: worker("glance-content", [{ type: "kv_namespace", name: "GLANCE_DB" }]),
          assets: noAssets,
        },
      ],
    });
    expect(JSON.stringify(artifactManifestSchema.safeParse(bad).error?.issues)).toContain(
      "must be of one type",
    );
  });

  it("refuses Workers that bind each other in a cycle", () => {
    const bad = artifact({
      worker: worker("glance", [{ type: "service", name: "C", service: "{{workerName:content}}" }]),
      d1: {},
    });
    expect(JSON.stringify(artifactManifestSchema.safeParse(bad).error?.issues)).toContain(
      "name each other in a cycle",
    );
  });

  it("refuses the same Workflow binding in two Workers", () => {
    const wf = { type: "workflow", name: "JOBS", workflow_name: "jobs", class_name: "Jobs" };
    const bad = artifact({
      worker: worker("glance", [wf]),
      d1: {},
      workers: [{ name: "content", worker: worker("glance-content", [wf]), assets: noAssets }],
    });
    expect(JSON.stringify(artifactManifestSchema.safeParse(bad).error?.issues)).toContain(
      "a Workflow belongs to one Worker",
    );
  });

  it("refuses Durable Object bindings of one name with different classes", () => {
    const bad = artifact({
      worker: worker("glance", [
        { type: "durable_object_namespace", name: "ROOM", class_name: "Room" },
      ]),
      d1: {},
      workers: [
        {
          name: "content",
          worker: worker("glance-content", [
            { type: "durable_object_namespace", name: "ROOM", class_name: "Lobby" },
          ]),
          assets: noAssets,
        },
      ],
    });
    expect(JSON.stringify(artifactManifestSchema.safeParse(bad).error?.issues)).toContain(
      "must name one class",
    );
  });

  it("accepts a Durable Object bound from another Worker of the entry", () => {
    const manifest = artifact({
      worker: worker(
        "glance",
        [{ type: "durable_object_namespace", name: "ROOM", class_name: "Room" }],
        {
          migrations: [{ tag: "v1", new_sqlite_classes: ["Room"] }],
        },
      ),
      d1: {},
      workers: [
        {
          name: "content",
          worker: worker("glance-content", [
            {
              type: "durable_object_namespace",
              name: "ROOM",
              class_name: "Room",
              script_name: "{{workerName:app}}",
            },
          ]),
          assets: noAssets,
        },
      ],
    });
    expect(artifactManifestSchema.safeParse(manifest).success).toBe(true);
  });
});

describe("entry service bindings", () => {
  it("are allowed with nothing but a name and an entrypoint", () => {
    const binding = {
      type: "service",
      name: "APP",
      service: "{{workerName:app}}",
      entrypoint: "Api",
    };
    expect(isEntryServiceBinding(binding)).toBe(true);
    expect(serviceBindingProblem(binding)).toBeNull();
    const extra = { ...binding, environment: "production" };
    expect(isEntryServiceBinding(extra)).toBe(false);
    expect(serviceBindingProblem(extra)).toContain("Worker of its own catalog entry");
    expect(serviceBindingProblem({ type: "service", name: "X", service: "other" })).not.toBeNull();
  });

  it("name the entry Worker as a placeholder", () => {
    expect(entryWorkerRef("content")).toBe("{{workerName:content}}");
    expect(entryWorkerRefName("{{workerName:content}}")).toBe("content");
    expect(entryWorkerRefName("{{workerName:content}}x")).toBeNull();
    expect(entryWorkerRefName(7)).toBeNull();
  });
});

describe("deploy order", () => {
  const w = (name: string, primary: boolean, refs: string[] = []) => ({
    name,
    primary,
    worker: {
      bindings: refs.map((r) => ({
        type: "service",
        name: r.toUpperCase(),
        service: `{{workerName:${r}}}`,
      })),
    },
  });

  it("puts Workers without bindings to others first and the primary last", () => {
    expect(
      entryWorkerOrder([w("app", true, ["api"]), w("api", false), w("cron", false)]).order,
    ).toEqual(["api", "cron", "app"]);
  });

  it("deploys the primary before a Worker that binds to it", () => {
    expect(entryWorkerOrder([w("app", true), w("content", false, ["app"])]).order).toEqual([
      "app",
      "content",
    ]);
  });

  it("names the Workers of a cycle", () => {
    expect(entryWorkerOrder([w("app", true, ["b"]), w("b", false, ["app"])]).cycle).toEqual([
      "b",
      "app",
    ]);
  });

  it("orders an artifact's Workers", () => {
    expect(appWorkersInDeployOrder(parsed(artifact())).map((x) => x.name)).toEqual([
      "app",
      "content",
    ]);
  });
});

describe("installed names, targets and placeholders", () => {
  it("names the primary after the install and every other Worker after both", () => {
    expect(entryScriptName("glance", "app", true)).toBe("glance");
    expect(entryScriptName("glance", "content", false)).toBe("glance-content");
    expect(entryScriptNames(parsed(artifact()).catalog, "team")).toEqual({
      app: "team",
      content: "team-content",
    });
  });

  it("sends secrets to their Workers, every Worker by default", () => {
    const manifest = parsed(artifact());
    expect(secretTargets({}, manifest.catalog)).toEqual(["app", "content"]);
    expect(secretTargets({ workers: ["content"] }, manifest.catalog)).toEqual(["content"]);
    expect(secretTargets({}, catalogManifestSchema.parse(catalog({ workers: undefined })))).toEqual(
      [],
    );
  });

  it("sends vars to the Workers that declare them, else every Worker", () => {
    const manifest = parsed(artifact());
    expect(varTargets({ name: "APP_URL" }, manifest)).toEqual(["app"]);
    expect(varTargets({ name: "ELSEWHERE" }, manifest)).toEqual(["app", "content"]);
    expect(varTargets({ name: "APP_URL", workers: ["content"] }, manifest)).toEqual(["content"]);
  });

  it("gives each Worker a manifest of its own with its secrets and vars", () => {
    const manifest = parsed(
      artifact({
        catalog: catalog(
          {},
          {
            secrets: [
              { name: "SESSION", label: "S", generate: "password", workers: ["app"] },
              { name: "SHARED", label: "S", generate: "password" },
            ],
            vars: [{ name: "APP_URL", label: "App URL" }],
          },
        ),
      }),
    );
    const content = appWorkers(manifest)[1];
    if (content === undefined) throw new Error("no content Worker");
    const own = workerManifest(manifest, content);
    expect(own.worker.name).toBe("glance-content");
    expect(own.catalog.secrets.map((s) => s.name)).toEqual(["SHARED"]);
    expect(own.catalog.vars).toEqual([]);
  });

  it("gives each Worker its name, workers.dev URL and address for placeholders", () => {
    const manifest = parsed(artifact());
    expect(entryPlaceholderValues(manifest.catalog, "team", "acme")).toEqual({
      app: {
        workerName: "team",
        workerUrl: "https://team.acme.workers.dev",
        appUrl: "https://team.acme.workers.dev",
      },
      content: {
        workerName: "team-content",
        workerUrl: "https://team-content.acme.workers.dev",
        appUrl: "https://team-content.acme.workers.dev",
      },
    });
    // The primary Worker's address follows its custom domain; its workers.dev URL stays.
    expect(
      entryPlaceholderValues(manifest.catalog, "team", "acme", "https://team.example.com")?.app,
    ).toEqual({
      workerName: "team",
      workerUrl: "https://team.acme.workers.dev",
      appUrl: "https://team.example.com",
    });
    expect(entryPlaceholderValues(manifest.catalog, "team", null)?.content).toEqual({
      workerName: "team-content",
      workerUrl: null,
      appUrl: null,
    });
  });

  it("combines every Worker's bindings for what the app uses", () => {
    const facts = combinedWorkerFacts(parsed(artifact()));
    expect(facts.bindings.filter((b) => b.type === "d1")).toHaveLength(2);
  });
});

describe("a Worker kept off workers.dev", () => {
  const privateWorkers = [
    { name: "app", wranglerConfig: "packages/api/wrangler.jsonc", primary: true },
    {
      name: "content",
      wranglerConfig: "packages/api/wrangler.content.jsonc",
      workersDev: false,
    },
  ];

  it("keeps every Worker on workers.dev unless it says otherwise", () => {
    const manifest = parsed(artifact());
    expect(appWorkers(manifest).map((w) => w.workersDev)).toEqual([true, true]);
    expect(entryWorkerOnWorkersDev(manifest.catalog, "content")).toBe(true);
    expect(entryWorkerOnWorkersDev(manifest.catalog, null)).toBe(true);
  });

  it("reads workersDev: false on a Worker other than the primary", () => {
    const manifest = parsed(artifact({ catalog: catalog({ workers: privateWorkers }) }));
    expect(appWorkers(manifest).map((w) => [w.name, w.workersDev])).toEqual([
      ["app", true],
      ["content", false],
    ]);
  });

  it("refuses workersDev: false on the primary Worker", () => {
    const result = catalogManifestSchema.safeParse(
      catalog({
        workers: [
          {
            name: "app",
            wranglerConfig: "packages/api/wrangler.jsonc",
            primary: true,
            workersDev: false,
          },
          { name: "content", wranglerConfig: "packages/api/wrangler.content.jsonc" },
        ],
      }),
    );
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ["install", "workers", 0, "workersDev"],
        message: expect.stringContaining("the primary Worker cannot turn workersDev off"),
      }),
    ]);
  });

  it("refuses an address placeholder of a Worker without an address", () => {
    const result = catalogManifestSchema.safeParse(
      catalog(
        { workers: privateWorkers },
        {
          vars: [{ name: "CONTENT_URL", label: "Content URL", default: "{{appUrl:content}}" }],
          postInstall: [{ type: "markdown", content: "Files at {{ workerUrl:content }}/f." }],
        },
      ),
    );
    expect(result.error?.issues.map((i) => i.path)).toEqual([
      ["postInstall", 0, "content"],
      ["vars", 0, "default"],
    ]);
    const named = catalogManifestSchema.safeParse(
      catalog(
        { workers: privateWorkers },
        { postInstall: [{ type: "markdown", content: "{{workerName:content}} is private." }] },
      ),
    );
    expect(named.success).toBe(true);
  });

  it("gives such a Worker no URL for placeholders", () => {
    const manifest = parsed(artifact({ catalog: catalog({ workers: privateWorkers }) }));
    expect(entryPlaceholderValues(manifest.catalog, "team", "acme")).toEqual({
      app: {
        workerName: "team",
        workerUrl: "https://team.acme.workers.dev",
        appUrl: "https://team.acme.workers.dev",
      },
      content: { workerName: "team-content", workerUrl: null, appUrl: null },
    });
  });
});
