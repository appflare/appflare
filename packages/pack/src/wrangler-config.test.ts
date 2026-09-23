import { describe, expect, it } from "vitest";
import {
  classifyModuleType,
  collectBindings,
  mainModuleName,
  type ResolvedWranglerConfig,
  VectorizeDeclarationError,
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
      { type: "plain_text", name: "COUNT", text: "3" },
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

  it("passes the Workers AI binding through with no resource settings", () => {
    const config = { ai: { binding: "AI" } } as unknown as ResolvedWranglerConfig;
    expect(collectBindings(config)).toEqual([{ type: "ai", name: "AI" }]);
  });

  it("returns an empty array when there are no bindings", () => {
    expect(collectBindings({} as ResolvedWranglerConfig)).toEqual([]);
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
  });
});
