import { describe, expect, it } from "vitest";
import {
  classifyModuleType,
  collectBindings,
  collectQueueConsumers,
  collectWorkerSettings,
  HyperdriveDeclarationError,
  mainModuleName,
  PipelineDeclarationError,
  QueueConsumerError,
  type ResolvedWranglerConfig,
  ServiceBindingError,
  UnsafeBindingError,
  VectorizeDeclarationError,
  withoutSecretVars,
} from "./wrangler-config.ts";

describe("collectBindings", () => {
  it("keeps binding names and types but strips every account-specific id", () => {
    const config = {
      kv_namespaces: [{ binding: "CACHE", id: "kvid123", preview_id: "prev" }],
      d1_databases: [
        { binding: "DB", database_name: "app-db", database_id: "uuid-1", preview_database_id: "p" },
      ],
      r2_buckets: [{ binding: "BUCKET", bucket_name: "real-bucket" }],
      vectorize: [{ binding: "VEC", index_name: "real-index" }],
      queues: { producers: [{ binding: "Q", queue: "real-queue", delivery_delay: 5 }] },
      hyperdrive: [{ binding: "HD", id: "hd-id" }],
      durable_objects: {
        bindings: [{ name: "DO", class_name: "Counter", script_name: "other" }],
      },
      vars: { GREETING: "Hello", COUNT: 3 },
    } as unknown as ResolvedWranglerConfig;

    const bindings = collectBindings(config, {
      vectorize: { VEC: { dimensions: 768, metric: "euclidean" } },
      hyperdrive: [{ binding: "HD", protocol: "postgres" }],
    });
    const serialized = JSON.stringify(bindings);

    // No account-specific identifier survives.
    for (const leak of [
      "kvid123",
      "prev",
      "uuid-1",
      "real-bucket",
      "real-index",
      "real-queue",
      "hd-id",
    ]) {
      expect(serialized).not.toContain(leak);
    }

    expect(bindings).toEqual([
      { type: "kv_namespace", name: "CACHE" },
      { type: "d1", name: "DB" },
      { type: "r2_bucket", name: "BUCKET" },
      { type: "queue", name: "Q", delivery_delay: 5 },
      // The index shape comes from the catalog manifest, never the index name.
      { type: "vectorize", name: "VEC", dimensions: 768, metric: "euclidean" },
      { type: "hyperdrive", name: "HD" },
      // class_name/script_name are code references, kept.
      { type: "durable_object_namespace", name: "DO", class_name: "Counter", script_name: "other" },
      { type: "plain_text", name: "GREETING", text: "Hello" },
      { type: "json", name: "COUNT", json: 3 },
    ]);
  });

  it("records string vars as plain_text and every other value as json, as wrangler uploads them", () => {
    const config = {
      vars: {
        PUBLIC_URL: "{{workerUrl}}",
        EMAIL_ADDRESSES: [],
        LIMITS: { daily: 10, tags: ["a"] },
        ENABLED: false,
        RATIO: 0.5,
        NOTHING: null,
        SINCE: new Date("2026-01-02T03:04:05Z"),
      },
    } as unknown as ResolvedWranglerConfig;

    expect(collectBindings(config)).toEqual([
      // Placeholders are recorded as written; the manager fills them in.
      { type: "plain_text", name: "PUBLIC_URL", text: "{{workerUrl}}" },
      { type: "json", name: "EMAIL_ADDRESSES", json: [] },
      { type: "json", name: "LIMITS", json: { daily: 10, tags: ["a"] } },
      { type: "json", name: "ENABLED", json: false },
      { type: "json", name: "RATIO", json: 0.5 },
      { type: "json", name: "NOTHING", json: null },
      // A TOML date goes up as its ISO string, as in wrangler's upload metadata.
      { type: "json", name: "SINCE", json: "2026-01-02T03:04:05.000Z" },
    ]);
  });

  it("records workflow bindings with their code references and no account ids", () => {
    const config = {
      workflows: [
        {
          binding: "UPDATE",
          name: "my-worker-update",
          class_name: "UpdateWorkflow",
          script_name: "other-worker",
        },
      ],
    } as unknown as ResolvedWranglerConfig;

    expect(collectBindings(config)).toEqual([
      {
        type: "workflow",
        name: "UPDATE",
        workflow_name: "my-worker-update",
        class_name: "UpdateWorkflow",
        script_name: "other-worker",
      },
    ]);
  });

  it("omits an absent workflow script_name (same-script workflow)", () => {
    const config = {
      workflows: [{ binding: "UPDATE", name: "my-worker-update", class_name: "UpdateWorkflow" }],
    } as unknown as ResolvedWranglerConfig;

    const [binding] = collectBindings(config);
    expect(binding).toEqual({
      type: "workflow",
      name: "UPDATE",
      workflow_name: "my-worker-update",
      class_name: "UpdateWorkflow",
    });
    expect(binding && "script_name" in binding).toBe(false);
  });

  it("refuses a Vectorize binding the catalog manifest does not declare, naming the field", () => {
    const config = {
      vectorize: [{ binding: "VECTORIZE", index_name: "second-brain-vectors" }],
    } as unknown as ResolvedWranglerConfig;
    for (const resources of [undefined, {}, { vectorize: {} }]) {
      expect(() => collectBindings(config, resources)).toThrow(VectorizeDeclarationError);
    }
    expect(() => collectBindings(config)).toThrow(
      /binds a Vectorize index as VECTORIZE.*add resources\.vectorize\.VECTORIZE with \{ "dimensions"/,
    );
    // A declaration under another name does not cover it.
    expect(() =>
      collectBindings(config, { vectorize: { VECTORS: { dimensions: 384, metric: "cosine" } } }),
    ).toThrow(/add resources\.vectorize\.VECTORIZE/);
  });

  it("refuses a Vectorize declaration for a binding the wrangler config does not have", () => {
    expect(() =>
      collectBindings({} as ResolvedWranglerConfig, {
        vectorize: { OLD_INDEX: { dimensions: 384, metric: "cosine" } },
      }),
    ).toThrow(
      /declares resources\.vectorize\.OLD_INDEX, but the wrangler config has no Vectorize binding/,
    );
  });

  it("records a Hyperdrive binding by name only, when the catalog manifest declares it", () => {
    const config = {
      hyperdrive: [
        { binding: "HYPERDRIVE", id: "0123abcd", localConnectionString: "postgres://u:p@h/db" },
      ],
    } as unknown as ResolvedWranglerConfig;
    const bindings = collectBindings(config, {
      hyperdrive: [{ binding: "HYPERDRIVE", protocol: "postgres" }],
    });
    expect(bindings).toEqual([{ type: "hyperdrive", name: "HYPERDRIVE" }]);
    expect(JSON.stringify(bindings)).not.toMatch(/0123abcd|postgres:/);
  });

  it("refuses a Hyperdrive binding the catalog manifest does not declare, and the reverse", () => {
    const config = { hyperdrive: [{ binding: "HYPERDRIVE" }] } as unknown as ResolvedWranglerConfig;
    expect(() => collectBindings(config)).toThrow(HyperdriveDeclarationError);
    expect(() => collectBindings(config)).toThrow(
      /binds Hyperdrive as HYPERDRIVE.*add \{ "binding": "HYPERDRIVE", "protocol"/,
    );
    expect(() =>
      collectBindings(config, { hyperdrive: [{ binding: "DB", protocol: "mysql" }] }),
    ).toThrow(/binds Hyperdrive as HYPERDRIVE/);
    expect(() =>
      collectBindings({} as ResolvedWranglerConfig, {
        hyperdrive: [{ binding: "DB", protocol: "mysql" }],
      }),
    ).toThrow(
      /declares the Hyperdrive binding DB in resources\.hyperdrive, but the wrangler config/,
    );
  });

  it("records a Pipelines binding by name only, without the author's stream id", () => {
    const sink = {
      type: "r2_data_catalog" as const,
      bucket: "WAREHOUSE",
      namespace: "traks",
      table: "events",
      tokenSecret: "CATALOG_TOKEN",
    };
    // `stream` since June 2026; `pipeline` is the name before it.
    const config = {
      pipelines: [
        { binding: "EVENTS", stream: "f0ee6ab42aa7462094f374857e996b47" },
        { binding: "LEGACY", pipeline: "old-pipeline-name" },
      ],
    } as unknown as ResolvedWranglerConfig;
    const bindings = collectBindings(config, {
      pipelines: { EVENTS: { sink }, LEGACY: { sink: { ...sink, table: "legacy" } } },
    });
    expect(bindings).toEqual([
      { type: "pipelines", name: "EVENTS" },
      { type: "pipelines", name: "LEGACY" },
    ]);
    expect(JSON.stringify(bindings)).not.toMatch(/f0ee6ab4|old-pipeline-name/);
  });

  it("refuses a Pipelines binding the catalog manifest does not describe, and the reverse", () => {
    const sink = {
      type: "r2_data_catalog" as const,
      bucket: "W",
      namespace: "n",
      table: "t",
      tokenSecret: "T",
    };
    const config = {
      pipelines: [{ binding: "EVENTS", stream: "abc" }],
    } as unknown as ResolvedWranglerConfig;
    expect(() => collectBindings(config)).toThrow(PipelineDeclarationError);
    expect(() => collectBindings(config)).toThrow(
      /binds a Pipelines stream as EVENTS, .*add resources\.pipelines\.EVENTS/,
    );
    expect(() =>
      collectBindings({} as ResolvedWranglerConfig, { pipelines: { CLICKS: { sink } } }),
    ).toThrow(/declares resources\.pipelines\.CLICKS, but the wrangler config has no Pipelines/);
  });

  it("passes the Workers AI binding through with no resource settings", () => {
    const config = { ai: { binding: "AI" } } as unknown as ResolvedWranglerConfig;
    expect(collectBindings(config)).toEqual([{ type: "ai", name: "AI" }]);
  });

  it("keeps a send_email binding's address restrictions, fixed destination first", () => {
    const config: ResolvedWranglerConfig = {
      send_email: [
        {
          name: "TO_ADMIN",
          destination_address: "admin@example.com",
          allowed_destination_addresses: ["ignored@example.com"],
          allowed_sender_addresses: ["app@example.com"],
        },
        { name: "TO_TEAM", allowed_destination_addresses: ["a@example.com", "b@example.com"] },
        { name: "ANY" },
      ],
    };
    expect(collectBindings(config)).toEqual([
      {
        type: "send_email",
        name: "TO_ADMIN",
        destination_address: "admin@example.com",
        allowed_sender_addresses: ["app@example.com"],
      },
      {
        type: "send_email",
        name: "TO_TEAM",
        allowed_destination_addresses: ["a@example.com", "b@example.com"],
      },
      { type: "send_email", name: "ANY" },
    ]);
  });

  it("passes rate limits and Images through with the upload's binding types", () => {
    const config: ResolvedWranglerConfig = {
      ratelimits: [
        { name: "RATE_LIMITER", namespace_id: "1001", simple: { limit: 30, period: 60 } },
      ],
      images: { binding: "IMAGES" },
    };
    expect(collectBindings(config)).toEqual([
      {
        type: "ratelimit",
        name: "RATE_LIMITER",
        namespace_id: "1001",
        simple: { limit: 30, period: 60 },
      },
      { type: "images", name: "IMAGES" },
    ]);
  });

  it("records a service binding to the app's own Worker as service self", () => {
    const config: ResolvedWranglerConfig = {
      name: "mailflare",
      services: [
        // OpenNext's binding for revalidation and caching.
        { binding: "WORKER_SELF_REFERENCE", service: "mailflare" },
        { binding: "JOBS", service: "mailflare", entrypoint: "Jobs" },
      ],
    };
    expect(collectBindings(config)).toEqual([
      { type: "service", name: "WORKER_SELF_REFERENCE", service: "self" },
      { type: "service", name: "JOBS", service: "self", entrypoint: "Jobs" },
    ]);
  });

  it("refuses a service binding to any other Worker, naming the binding", () => {
    for (const [services, message] of [
      [
        [{ binding: "SELF", service: "appflare", entrypoint: "JobUnits" }],
        /service binding SELF points at the Worker "appflare", not at the app's own Worker \("cut"\).*never lets one call another Worker/,
      ],
      [[{ binding: "API" }], /service binding API points at no Worker/],
      [
        [{ binding: "ENV", service: "cut", environment: "staging" }],
        /service binding ENV to the app's own Worker sets environment/,
      ],
      [
        [{ binding: "P", service: "cut", props: { admin: true } }],
        /service binding P to the app's own Worker sets props/,
      ],
    ] as const) {
      const config = { name: "cut", services } as unknown as ResolvedWranglerConfig;
      expect(() => collectBindings(config)).toThrow(ServiceBindingError);
      expect(() => collectBindings(config)).toThrow(message);
    }
  });

  it("returns an empty array when there are no bindings", () => {
    expect(collectBindings({} as ResolvedWranglerConfig)).toEqual([]);
  });

  it("records a rate limit from unsafe.bindings as the ratelimit binding it is", () => {
    const config: ResolvedWranglerConfig = {
      ratelimits: [{ name: "API", namespace_id: "1001", simple: { limit: 30, period: 60 } }],
      unsafe: {
        bindings: [
          {
            name: "LOGIN",
            type: "ratelimit",
            namespace_id: 1002,
            simple: { limit: 5, period: 10 },
          },
        ],
      },
    };
    expect(collectBindings(config)).toEqual([
      { type: "ratelimit", name: "API", namespace_id: "1001", simple: { limit: 30, period: 60 } },
      { type: "ratelimit", name: "LOGIN", namespace_id: "1002", simple: { limit: 5, period: 10 } },
    ]);
  });

  it("refuses every other unsafe binding, and a rate limit it cannot record", () => {
    for (const [binding, message] of [
      [
        { name: "AI_GATEWAY", type: "ai_gateway" },
        /unsafe binding AI_GATEWAY has the type "ai_gateway"; Appflare takes only rate limits/,
      ],
      [
        { name: "LOGIN", type: "ratelimit", namespace_id: "1", simple: { limit: 5, period: 30 } },
        /unsafe rate limit LOGIN needs a name, a namespace_id and "simple"/,
      ],
      [
        { name: "LOGIN", type: "ratelimit", simple: { limit: 5, period: 60 } },
        /unsafe rate limit LOGIN needs/,
      ],
      [{ type: "ratelimit", namespace_id: "1" }, /unsafe rate limit \(unnamed\) needs/],
    ] as const) {
      const config: ResolvedWranglerConfig = { unsafe: { bindings: [binding] } };
      expect(() => collectBindings(config)).toThrow(UnsafeBindingError);
      expect(() => collectBindings(config)).toThrow(message);
    }
  });

  it("refuses unsafe.metadata and unsafe.capnp, which it cannot pass through", () => {
    for (const [unsafe, message] of [
      [{ metadata: { tail_consumers: [] } }, /sets unsafe\.metadata; Appflare installs/],
      [{ capnp: { base_path: ".", source_schemas: ["a.capnp"] } }, /sets unsafe\.capnp/],
    ] as const) {
      expect(() => collectBindings({ unsafe })).toThrow(UnsafeBindingError);
      expect(() => collectBindings({ unsafe })).toThrow(message);
    }
    // Empty, as wrangler may resolve them, is nothing to refuse.
    expect(collectBindings({ unsafe: { metadata: {}, bindings: [] } })).toEqual([]);
  });
});

describe("withoutSecretVars", () => {
  it("leaves out the vars a secret is named after, and nothing else of that name", () => {
    const bindings = collectBindings({
      vars: { PASSWORD: "change-me", LIMITS: { max: 3 }, GREETING: "hi" },
      kv_namespaces: [{ binding: "PASSWORD_KV" }],
    });
    expect(withoutSecretVars(bindings, ["PASSWORD", "LIMITS", "PASSWORD_KV", "UNUSED"])).toEqual({
      bindings: [
        { type: "kv_namespace", name: "PASSWORD_KV" },
        { type: "plain_text", name: "GREETING", text: "hi" },
      ],
      dropped: ["PASSWORD", "LIMITS"],
    });
    expect(withoutSecretVars(bindings, []).dropped).toEqual([]);
  });
});

describe("collectQueueConsumers", () => {
  it("names each consumed queue by its producer binding, else by its upstream name", () => {
    const config: ResolvedWranglerConfig = {
      queues: {
        producers: [
          { binding: "MEMBER_REMOVAL_QUEUE", queue: "flaremo-member-removal" },
          { binding: "EXPORT", queue: "flaremo-data-export" },
          { binding: "EXPORT_AGAIN", queue: "flaremo-data-export" },
        ],
        consumers: [
          {
            queue: "flaremo-member-removal",
            max_batch_size: 10,
            max_retries: 5,
            dead_letter_queue: "flaremo-dlq",
          },
          {
            queue: "flaremo-data-export",
            type: "worker",
            max_batch_timeout: 2,
            max_concurrency: null,
            retry_delay: 30,
          },
          { queue: "flaremo-dlq" },
        ],
      },
    };
    const consumers = collectQueueConsumers(config);
    expect(consumers).toEqual([
      {
        queue: { binding: "MEMBER_REMOVAL_QUEUE" },
        max_batch_size: 10,
        max_retries: 5,
        dead_letter_queue: { name: "flaremo-dlq" },
      },
      {
        queue: { binding: "EXPORT" },
        max_batch_timeout: 2,
        max_concurrency: null,
        retry_delay: 30,
      },
      { queue: { name: "flaremo-dlq" } },
    ]);
  });

  it("returns nothing without consumers", () => {
    expect(collectQueueConsumers({})).toEqual([]);
    expect(
      collectQueueConsumers({ queues: { producers: [{ binding: "Q", queue: "q" }] } }),
    ).toEqual([]);
  });

  it("refuses an HTTP pull consumer and a queue consumed twice", () => {
    expect(() =>
      collectQueueConsumers({ queues: { consumers: [{ queue: "q", type: "http_pull" }] } }),
    ).toThrow(QueueConsumerError);
    expect(() =>
      collectQueueConsumers({ queues: { consumers: [{ queue: "q" }, { queue: "q" }] } }),
    ).toThrow(/two consumers/);
  });
});

describe("classifyModuleType", () => {
  it("classifies the main module and additional modules by wrangler's rules", () => {
    expect(classifyModuleType("index.js", true)).toBe("esm");
    expect(classifyModuleType("worker.py", true)).toBe("python");
    expect(classifyModuleType("chunk.mjs", false)).toBe("esm");
    expect(classifyModuleType("legacy.cjs", false)).toBe("commonjs");
    expect(classifyModuleType("hash.wasm", false)).toBe("compiled-wasm");
    expect(classifyModuleType("template.html", false)).toBe("text");
    expect(classifyModuleType("seed.sql", false)).toBe("text");
    expect(classifyModuleType("blob.bin", false)).toBe("data");
  });
});

describe("mainModuleName", () => {
  it("maps a source entry path to its emitted .js filename", () => {
    expect(mainModuleName("src/index.ts")).toBe("index.js");
    expect(mainModuleName("/abs/src/worker.tsx")).toBe("worker.js");
    expect(mainModuleName("dist/index.js")).toBe("index.js");
    expect(mainModuleName("src/main.py")).toBe("main.py");
    // esbuild names its output .js whatever the entry's extension.
    expect(mainModuleName("dist/entry.mjs")).toBe("entry.js");
    expect(mainModuleName("dist/entry.cjs")).toBe("entry.js");
  });

  it("keeps the entry's own name when wrangler does not bundle it", () => {
    expect(mainModuleName("dist/server/entry.mjs", true)).toBe("entry.mjs");
    expect(mainModuleName("dist/index.js", true)).toBe("index.js");
  });
});

describe("collectWorkerSettings", () => {
  it("keeps the durable-object and worker exports and the cache block as wrangler uploads them", () => {
    const config = {
      exports: {
        Room: { type: "durable-object", storage: "sqlite" },
        Old: { type: "durable-object", state: "deleted" },
        Api: { type: "worker", cache: { enabled: true } },
        Later: { type: "something-new" },
      },
      cache: { enabled: true, cross_version_cache: true },
    } as ResolvedWranglerConfig;
    expect(collectWorkerSettings(config)).toEqual({
      exports: {
        Room: { type: "durable-object", storage: "sqlite" },
        Old: { type: "durable-object", state: "deleted" },
        Api: { type: "worker", cache: { enabled: true } },
      },
      cacheOptions: { enabled: true, cross_version_cache: true },
    });
  });

  it("records neither when the config has no exports and no cache block", () => {
    expect(collectWorkerSettings({ exports: {}, cache: null })).toEqual({});
    expect(collectWorkerSettings({})).toEqual({});
  });

  it("collects worker_loaders as worker_loader bindings", () => {
    const bindings = collectBindings({ worker_loaders: [{ binding: "LOADER" }] });
    expect(bindings).toEqual([{ type: "worker_loader", name: "LOADER" }]);
  });
});
