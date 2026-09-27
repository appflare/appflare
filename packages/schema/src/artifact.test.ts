import { describe, expect, it } from "vitest";
import {
  artifactFormatFor,
  artifactManifestSchema,
  catalogVarProblems,
  hasDurableObjectExports,
  isJsonVarBinding,
  isSelfServiceBinding,
  isVectorizeBinding,
  queueConsumerProblems,
  sameDurableObjectExports,
  sameWorkerExports,
  serviceBindingProblem,
  workersPaidBindingProblem,
} from "./artifact";

const sha256 = "a".repeat(64);
const assetBlake3 = "c".repeat(32);
const gitSha = "b".repeat(40);

const validArtifact = {
  format: 1,
  app: "cut",
  version: "0.1.0",
  source: { repo: "MendyLanda/cut", sha: gitSha, ref: "v0.1.0" },
  builtAt: "2026-09-22T12:00:00Z",
  builder: "@appflare/pack@0.1.0",
  keyId: "catalog-2026-09",
  worker: {
    name: "cut",
    mainModule: "index.js",
    compatibilityDate: "2024-12-30",
    compatibilityFlags: ["nodejs_compat"],
    modules: [
      { name: "index.js", type: "esm", path: "worker/index.js", size: 1, sha256, offset: 0 },
    ],
    bindings: [{ type: "kv_namespace", name: "CUT_KV" }],
    migrations: [],
    crons: [],
    observability: { enabled: true },
    placement: null,
    limits: null,
  },
  assets: {
    config: {
      html_handling: "auto-trailing-slash",
      not_found_handling: "none",
      run_worker_first: false,
    },
    binding: "ASSETS",
    files: [
      {
        route: "/index.html",
        path: "assets/index.html",
        hash: assetBlake3,
        size: 1,
        sha256,
        offset: 123,
      },
    ],
  },
  d1Migrations: {
    DB: [{ name: "0001_init.sql", path: "d1/DB/0001_init.sql", size: 1, sha256, offset: 456 }],
  },
  catalog: {
    slug: "cut",
    name: "Cut",
    summary: "Self-hosted link shortener on Workers + KV.",
    homepage: "https://github.com/MendyLanda/cut",
    repo: "MendyLanda/cut",
    license: "MIT",
    categories: ["utilities"],
    maintainers: ["MendyLanda"],
    source: { ref: "v0.1.0", sha: gitSha },
    install: {
      tier: "artifact",
      packageManager: "pnpm",
      wranglerConfig: "wrangler.jsonc",
      workerName: "cut",
    },
    plan: "free",
    requires: [],
    secrets: [],
    vars: [],
    postInstall: [],
    tokenPermissions: [],
  },
};

describe("artifactManifestSchema", () => {
  it("accepts a valid artifact manifest that embeds the catalog manifest", () => {
    const parsed = artifactManifestSchema.parse(validArtifact);
    expect(parsed.format).toBe(1);
    expect(parsed.worker.modules[0]?.offset).toBe(0);
    expect(parsed.catalog.slug).toBe("cut");
  });

  it("keeps an observability section that turns on only logs, as wrangler uploads it", () => {
    const withObservability = (observability: unknown) =>
      artifactManifestSchema.safeParse({
        ...validArtifact,
        worker: { ...validArtifact.worker, observability },
      });
    const logsOnly = { logs: { enabled: true, invocation_logs: false } };
    const parsed = withObservability(logsOnly);
    expect(parsed.success).toBe(true);
    // No `enabled` is added: the upload sends the section as the config has it.
    expect(parsed.data?.worker.observability).toEqual(logsOnly);
    expect(withObservability({ enabled: false, head_sampling_rate: 0.1 }).success).toBe(true);
    expect(withObservability(null).success).toBe(true);
    expect(withObservability({ enabled: "yes" }).success).toBe(false);
  });

  it("rejects a manifest with a wrong format literal and a non-hex sha256", () => {
    const invalid = {
      ...validArtifact,
      format: 2,
      worker: {
        ...validArtifact.worker,
        modules: [{ ...validArtifact.worker.modules[0], sha256: "nothex" }],
      },
    };
    const result = artifactManifestSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("requires a 32-hex BLAKE3 asset hash on every asset file", () => {
    const missingHash = {
      ...validArtifact,
      assets: {
        ...validArtifact.assets,
        files: [{ route: "/index.html", path: "assets/index.html", size: 1, sha256, offset: 123 }],
      },
    };
    expect(artifactManifestSchema.safeParse(missingHash).success).toBe(false);

    const badHash = {
      ...validArtifact,
      assets: {
        ...validArtifact.assets,
        files: [{ ...validArtifact.assets.files[0], hash: "a".repeat(64) }],
      },
    };
    expect(artifactManifestSchema.safeParse(badHash).success).toBe(false);
  });

  it("takes optional queue consumers that name queues by binding or by name", () => {
    expect(artifactManifestSchema.parse(validArtifact).worker.queueConsumers).toBeUndefined();
    const queueConsumers = [
      {
        queue: { binding: "JOBS" },
        max_batch_size: 10,
        max_batch_timeout: 2.5,
        max_retries: 5,
        dead_letter_queue: { name: "jobs-dlq" },
        max_concurrency: null,
        retry_delay: 30,
      },
      { queue: { name: "jobs-dlq" } },
    ];
    const parsed = artifactManifestSchema.parse({
      ...validArtifact,
      worker: { ...validArtifact.worker, queueConsumers },
    });
    expect(parsed.worker.queueConsumers).toEqual(queueConsumers);
    for (const consumer of [
      { queue: "jobs" },
      { queue: { binding: "JOBS", name: "jobs" } },
      { queue: { binding: "" } },
      { queue: { binding: "JOBS" }, max_batch_size: 0 },
      { queue: { binding: "JOBS" }, max_retries: 1.5 },
      { queue: { binding: "JOBS" }, dead_letter_queue: "dlq" },
    ]) {
      const result = artifactManifestSchema.safeParse({
        ...validArtifact,
        worker: { ...validArtifact.worker, queueConsumers: [consumer] },
      });
      expect(result.success, JSON.stringify(consumer)).toBe(false);
    }
  });

  it("checks that consumers name the Worker's own queue bindings, once each", () => {
    const bindings = [
      { type: "queue", name: "JOBS" },
      { type: "kv_namespace", name: "CACHE" },
    ];
    expect(
      queueConsumerProblems({
        bindings,
        queueConsumers: [
          { queue: { binding: "JOBS" }, dead_letter_queue: { name: "dlq" } },
          { queue: { name: "dlq" } },
        ],
      }),
    ).toEqual([]);
    expect(queueConsumerProblems({ bindings })).toEqual([]);
    expect(
      queueConsumerProblems({
        bindings,
        queueConsumers: [
          { queue: { binding: "CACHE" } },
          { queue: { binding: "JOBS" }, dead_letter_queue: { binding: "NOPE" } },
          { queue: { binding: "JOBS" } },
        ],
      }),
    ).toEqual([
      "A queue consumer names the queue binding CACHE, but the Worker has no queue binding by that name.",
      "A queue consumer names the queue binding NOPE, but the Worker has no queue binding by that name.",
      "The queue of binding JOBS has more than one consumer.",
    ]);
  });

  it("types a Vectorize binding's dimensions and metric and requires both", () => {
    const withBindings = (bindings: unknown[]) => ({
      ...validArtifact,
      worker: { ...validArtifact.worker, bindings },
    });
    const parsed = artifactManifestSchema.parse(
      withBindings([
        { type: "vectorize", name: "VECTORIZE", dimensions: 384, metric: "cosine" },
        { type: "ai", name: "AI" },
      ]),
    );
    const [vectorize, ai] = parsed.worker.bindings;
    if (vectorize === undefined || !isVectorizeBinding(vectorize)) {
      throw new Error("expected a typed Vectorize binding");
    }
    const shape: { dimensions: number; metric: string } = vectorize;
    expect(shape).toMatchObject({ dimensions: 384, metric: "cosine" });
    expect(ai && isVectorizeBinding(ai)).toBe(false);

    for (const binding of [
      { type: "vectorize", name: "VECTORIZE" },
      { type: "vectorize", name: "VECTORIZE", dimensions: 384 },
      { type: "vectorize", name: "VECTORIZE", dimensions: 2048, metric: "cosine" },
      { type: "vectorize", name: "VECTORIZE", dimensions: 384, metric: "manhattan" },
    ]) {
      const result = artifactManifestSchema.safeParse(withBindings([binding]));
      expect(result.success).toBe(false);
    }
  });
});

describe("json var bindings", () => {
  const withBindings = (bindings: unknown[]) => ({
    ...validArtifact,
    worker: { ...validArtifact.worker, bindings },
  });

  it("parse with any JSON value and are told apart from other bindings", () => {
    for (const json of [[], { a: [1, "x"] }, 3, false, null, "text"]) {
      const parsed = artifactManifestSchema.parse(
        withBindings([{ type: "json", name: "V", json }]),
      );
      const binding = parsed.worker.bindings[0];
      if (binding === undefined) throw new Error("expected one binding");
      expect(isJsonVarBinding(binding)).toBe(true);
      expect(binding).toEqual({ type: "json", name: "V", json });
    }
  });

  it("must carry their value", () => {
    const result = artifactManifestSchema.safeParse(withBindings([{ type: "json", name: "V" }]));
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("must record its value in `json`");
  });

  it("require a catalog default that is JSON text", () => {
    const bindings = [
      { type: "json", name: "EMAIL_ADDRESSES", json: [] },
      { type: "plain_text", name: "GREETING", text: "Hi" },
    ];
    const v = (name: string, value: string) => ({
      name,
      label: name,
      default: value,
      required: false,
    });
    expect(
      catalogVarProblems(bindings, [
        v("EMAIL_ADDRESSES", '["{{workerName}}@example.com"]'),
        v("GREETING", "not json, and it need not be"),
      ]),
    ).toEqual([]);
    expect(catalogVarProblems(bindings, [v("EMAIL_ADDRESSES", "inbox@example.com")])).toEqual([
      expect.stringMatching(/^The default of the var EMAIL_ADDRESSES is not valid JSON/),
    ]);
  });

  it("needs each option of a JSON select var to be JSON text", () => {
    const bindings = [
      { type: "json", name: "EMAIL_ADDRESSES", json: [] },
      { type: "plain_text", name: "GREETING", text: "Hi" },
    ];
    const select = (name: string, values: string[]) => ({
      name,
      label: name,
      required: false,
      type: "select" as const,
      options: values.map((value) => ({ value, label: value })),
    });
    expect(
      catalogVarProblems(bindings, [
        select("EMAIL_ADDRESSES", ['["a@example.com"]', "[]"]),
        select("GREETING", ["Hi", "Hello"]),
      ]),
    ).toEqual([]);
    expect(catalogVarProblems(bindings, [select("EMAIL_ADDRESSES", ["[]", "inbox"])])).toEqual([
      expect.stringMatching(/^The option "inbox" of the var EMAIL_ADDRESSES is not valid JSON/),
    ]);
  });
});

describe("service bindings", () => {
  const withBindings = (bindings: unknown[]) => ({
    ...validArtifact,
    worker: { ...validArtifact.worker, bindings },
  });
  const parseOne = (binding: unknown) => {
    const parsed = artifactManifestSchema.parse(withBindings([binding])).worker.bindings[0];
    if (parsed === undefined) throw new Error("expected one binding");
    return parsed;
  };

  it("type a binding to the app's own Worker, with or without an entrypoint", () => {
    for (const binding of [
      { type: "service", name: "WORKER_SELF_REFERENCE", service: "self" },
      { type: "service", name: "SELF", service: "self", entrypoint: "Jobs" },
    ]) {
      const parsed = parseOne(binding);
      expect(parsed).toEqual(binding);
      expect(isSelfServiceBinding(parsed)).toBe(true);
      expect(serviceBindingProblem(parsed)).toBeNull();
    }
  });

  it("still read when they point at another Worker, and say why no app may have one", () => {
    // Old or hand-edited artifacts keep parsing; the problem is what refuses them.
    for (const binding of [
      { type: "service", name: "SELF", service: "appflare", entrypoint: "JobUnits" },
      { type: "service", name: "API", service: "other-worker" },
      { type: "service", name: "NOWHERE" },
      // Anything beyond an entrypoint makes it something other than a plain self binding.
      { type: "service", name: "ENV", service: "self", environment: "staging" },
    ]) {
      const parsed = parseOne(binding);
      expect(isSelfServiceBinding(parsed)).toBe(false);
      expect(serviceBindingProblem(parsed)).toMatch(
        new RegExp(`^Service binding ${binding.name} points at .*may bind only to its own Worker`),
      );
    }
    expect(serviceBindingProblem(parseOne({ type: "ai", name: "AI" }))).toBeNull();
  });
});

describe("worker.wranglerConfig", () => {
  it("is optional and records the declared and effective config", () => {
    expect(artifactManifestSchema.parse(validArtifact).worker.wranglerConfig).toBeUndefined();
    const wranglerConfig = { declared: "wrangler.jsonc", effective: "build/server/wrangler.json" };
    const parsed = artifactManifestSchema.parse({
      ...validArtifact,
      worker: { ...validArtifact.worker, wranglerConfig },
    });
    expect(parsed.worker.wranglerConfig).toEqual(wranglerConfig);
  });
});

describe("worker.exports and worker.cacheOptions", () => {
  it("are optional, loose, and kept as recorded", () => {
    const plain = artifactManifestSchema.parse(validArtifact);
    expect(plain.worker.exports).toBeUndefined();
    expect(plain.worker.cacheOptions).toBeUndefined();
    const exports = {
      Room: { type: "durable-object", storage: "sqlite" },
      Api: { type: "worker", cache: { enabled: true } },
    };
    const cacheOptions = { enabled: true, cross_version_cache: false };
    const parsed = artifactManifestSchema.parse({
      ...validArtifact,
      format: 3,
      worker: { ...validArtifact.worker, exports, cacheOptions },
    });
    expect(parsed.worker.exports).toEqual(exports);
    expect(parsed.worker.cacheOptions).toEqual(cacheOptions);
    expect(hasDurableObjectExports(parsed.worker.exports)).toBe(true);
    expect(hasDurableObjectExports({ Api: { type: "worker" } })).toBe(false);
  });

  it("need format 3, so a manager that reads only formats 1 and 2 refuses the artifact", () => {
    const room = { Room: { type: "durable-object", storage: "sqlite" } };
    expect(artifactFormatFor({ worker: { exports: room } })).toBe(3);
    expect(artifactFormatFor({ worker: { cacheOptions: { enabled: true } } })).toBe(3);
    expect(artifactFormatFor({ worker: { exports: {} } })).toBe(1);
    expect(artifactFormatFor({ worker: {}, workers: [{ worker: { exports: room } }] })).toBe(3);
    expect(artifactFormatFor({ worker: {}, workers: [{ worker: {} }] })).toBe(2);
    for (const extra of [{ exports: room }, { cacheOptions: { enabled: true } }]) {
      const result = artifactManifestSchema.safeParse({
        ...validArtifact,
        worker: { ...validArtifact.worker, ...extra },
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((i) => i.message)).toEqual([
        expect.stringMatching(/^the artifact needs format 3 for what it carries/),
      ]);
    }
  });

  it("compares exports whatever the key order, with none the same as an empty block", () => {
    expect(
      sameWorkerExports(
        { A: { type: "durable-object", storage: "sqlite" }, B: { type: "worker" } },
        { B: { type: "worker" }, A: { storage: "sqlite", type: "durable-object" } },
      ),
    ).toBe(true);
    expect(sameWorkerExports(undefined, {})).toBe(true);
    // Only the Durable Object entries count as a class change.
    expect(
      sameDurableObjectExports(
        { A: { type: "durable-object", storage: "sqlite" } },
        { A: { type: "durable-object", storage: "sqlite" }, B: { type: "worker" } },
      ),
    ).toBe(true);
    expect(sameDurableObjectExports(undefined, { A: { type: "durable-object" } })).toBe(false);
    expect(sameWorkerExports(undefined, { A: { type: "worker" } })).toBe(false);
    expect(
      sameWorkerExports(
        { A: { type: "durable-object", storage: "sqlite" } },
        { A: { type: "durable-object", state: "deleted" } },
      ),
    ).toBe(false);
  });
});

describe("Worker Loader bindings", () => {
  const withLoader = {
    ...validArtifact,
    worker: {
      ...validArtifact.worker,
      bindings: [...validArtifact.worker.bindings, { type: "worker_loader", name: "LOADER" }],
    },
  };

  it("need the catalog manifest to say plan paid", () => {
    const result = artifactManifestSchema.safeParse(withLoader);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.message)).toEqual([
      expect.stringMatching(
        /Worker Loader \(LOADER\), which Cloudflare offers only on Workers Paid/,
      ),
    ]);
    const paid = { ...withLoader, catalog: { ...withLoader.catalog, plan: "paid" } };
    expect(artifactManifestSchema.parse(paid).worker.bindings).toContainEqual({
      type: "worker_loader",
      name: "LOADER",
    });
  });

  it("are a problem only on the free plan", () => {
    const bindings = [{ type: "worker_loader", name: "LOADER" }];
    expect(workersPaidBindingProblem(bindings, "free")).toMatch(/"plan": "paid"/);
    expect(workersPaidBindingProblem(bindings, "paid")).toBeNull();
    expect(workersPaidBindingProblem([{ type: "ai", name: "AI" }], "free")).toBeNull();
  });
});
