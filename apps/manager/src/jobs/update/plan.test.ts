import type { PipelineStream } from "@appflare/cf-api";
import type { ArtifactManifest, CatalogPipeline, StreamField } from "@appflare/schema";
import { describe, expect, it } from "vitest";
import { classifyHealthProbe } from "../install/health";
import {
  accessUpdateRefusal,
  activeVersionId,
  appliedDurableObjectTag,
  bookmarksJson,
  boundHyperdriveIds,
  canarySkipReason,
  cronChanges,
  declaredLifecycleOf,
  diffBindings,
  droppedDurableObjectExportsProblem,
  durableObjectMigrationsSince,
  EXPORTS_DEPLOY_REASON,
  FULL_DEPLOY_REASON,
  hyperdriveRollbackRefusal,
  lastDurableObjectTagOf,
  liveStreamChange,
  missingSecrets,
  NO_PREVIEW_REASON,
  newDatabases,
  newStreamTokenSecrets,
  parseBookmarks,
  parseSnapshotHyperdrive,
  pendingDurableObjectMigrations,
  pipelineShapesOf,
  previewUrl,
  type RecordedResource,
  rollbackLifecycleWarnings,
  snapshotRow,
  updatePath,
  updateRefusal,
  vectorizeShapesOf,
  workerExportsOf,
} from "./plan";

const row = (over: Partial<RecordedResource> & Pick<RecordedResource, "kind" | "name">) => ({
  id: `i1:${over.kind}:${over.binding ?? over.name}`,
  binding: null,
  cfId: null,
  ...over,
});

describe("updateRefusal", () => {
  it("allows only the catalog's current version when it is newer", () => {
    expect(
      updateRefusal({ installedVersion: "1.0.0", targetVersion: "1.1.0", indexVersion: "1.1.0" }),
    ).toBeNull();
    expect(
      updateRefusal({
        installedVersion: "0.0.0-20260826.6056400",
        targetVersion: "0.0.0-20260920.abcdef1",
        indexVersion: "0.0.0-20260920.abcdef1",
      }),
    ).toBeNull();
  });

  it("refuses the installed version, a stale target, an older version, and an unlisted app", () => {
    expect(
      updateRefusal({ installedVersion: "1.1.0", targetVersion: "1.1.0", indexVersion: "1.1.0" }),
    ).toBe("version 1.1.0 is already installed");
    expect(
      updateRefusal({ installedVersion: "1.0.0", targetVersion: "1.1.0", indexVersion: "1.2.0" }),
    ).toBe("1.1.0 is not the catalog's current version of the app (1.2.0)");
    expect(
      updateRefusal({ installedVersion: "2.0.0", targetVersion: "1.2.0", indexVersion: "1.2.0" }),
    ).toBe("1.2.0 is older than the installed version 2.0.0");
    expect(
      updateRefusal({ installedVersion: "1.0.0", targetVersion: "1.1.0", indexVersion: undefined }),
    ).toBe("the app is no longer in the catalog");
  });
});

describe("vectorize index shapes on update", () => {
  const recorded: RecordedResource[] = [
    row({ kind: "vectorize", binding: "VECTORIZE", name: "sb-vectorize", cfId: "sb-vectorize" }),
  ];
  const bindings = (dimensions: number, metric: "cosine" | "euclidean") => [
    { type: "vectorize" as const, name: "VECTORIZE", dimensions, metric },
  ];
  const installed = { VECTORIZE: { dimensions: 384, metric: "cosine" as const } };

  it("keeps an index whose shape is unchanged", () => {
    const diff = diffBindings("sb", bindings(384, "cosine"), recorded, installed);
    expect(diff.problems).toEqual([]);
    expect(diff.existing).toEqual([
      { binding: "VECTORIZE", type: "vectorize", name: "sb-vectorize", cfId: "sb-vectorize" },
    ]);
  });

  it("refuses a version that changes a kept index's dimensions or metric", () => {
    const resized = diffBindings("sb", bindings(768, "cosine"), recorded, installed);
    expect(resized.problems).toEqual([
      'Binding VECTORIZE uses the Vectorize index "sb-vectorize", created with 384 dimensions (cosine); this version needs 768 dimensions (cosine). A Vectorize index cannot be reshaped in place, so this version needs a fresh install.',
    ]);
    expect(resized.existing).toEqual([]);
    expect(resized.toCreate).toEqual([]);
    const remetered = diffBindings("sb", bindings(384, "euclidean"), recorded, installed);
    expect(remetered.problems[0]).toMatch(
      /384 dimensions \(cosine\); this version needs 384 dimensions \(euclidean\)/,
    );
  });

  it("reads the installed shapes from a stored manifest, skipping what it cannot read", () => {
    const manifest = JSON.stringify({
      worker: {
        bindings: [
          { type: "kv_namespace", name: "OAUTH_KV" },
          { type: "vectorize", name: "VECTORIZE", dimensions: 384, metric: "cosine" },
          { type: "vectorize", name: "UNSHAPED" },
        ],
      },
    });
    expect(vectorizeShapesOf(manifest)).toEqual(installed);
    expect(vectorizeShapesOf(null)).toEqual({});
    expect(vectorizeShapesOf("not json")).toEqual({});
    expect(vectorizeShapesOf(JSON.stringify({ worker: {} }))).toEqual({});
  });
});

describe("diffBindings", () => {
  const recorded: RecordedResource[] = [
    row({ kind: "kv", binding: "CUT_KV", name: "cut-cut-kv", cfId: "kv-1" }),
    row({ kind: "d1", binding: "OLD_DB", name: "cut-old-db", cfId: "d1-old" }),
    row({ kind: "workflow", binding: "JOBS", name: "cut-jobs" }),
    row({ kind: "worker", name: "cut", cfId: "cut" }),
    row({ kind: "secret", binding: "ADMIN_PASSWORD", name: "ADMIN_PASSWORD" }),
    row({ kind: "cron", name: "*/5 * * * *" }),
  ];

  it("keeps recorded resources, creates new ones, and leaves dropped ones in place", () => {
    const diff = diffBindings(
      "cut",
      [
        { type: "kv_namespace", name: "CUT_KV" },
        { type: "d1", name: "DB" },
        { type: "workflow", name: "JOBS", workflow_name: "jobs", class_name: "JobWorkflow" },
        { type: "workflow", name: "MAIL", workflow_name: "mail", class_name: "MailWorkflow" },
        { type: "durable_object_namespace", name: "ROOMS", class_name: "Room" },
        { type: "plain_text", name: "MODE", text: "prod" },
      ],
      recorded,
    );
    expect(diff.problems).toEqual([]);
    expect(diff.existing).toEqual([
      { binding: "CUT_KV", type: "kv_namespace", name: "cut-cut-kv", cfId: "kv-1" },
    ]);
    expect(diff.toCreate.map((r) => [r.kind, r.binding, r.name])).toEqual([["d1", "DB", "cut-db"]]);
    // The recorded Workflow keeps its name; a new one is named like an install names it.
    expect(diff.workflowNames).toEqual({ JOBS: "cut-jobs", MAIL: "cut-mail" });
    expect(diff.newWorkflows.map((w) => w.name)).toEqual(["cut-mail"]);
    expect(diff.newDurableObjects).toEqual([{ binding: "ROOMS", className: "Room" }]);
    // Secrets, crons, and the Worker are not bindings of this kind; only the dropped D1 is listed.
    expect(diff.leftInPlace.map((r) => r.name)).toEqual(["cut-old-db"]);
  });

  it("keeps the recorded name even when the Worker name would give another one", () => {
    const diff = diffBindings("cut-2", [{ type: "kv_namespace", name: "CUT_KV" }], recorded);
    expect(diff.existing[0]?.name).toBe("cut-cut-kv");
    expect(diff.toCreate).toEqual([]);
  });

  it("refuses a binding whose resource kind changed", () => {
    const changed = diffBindings("cut", [{ type: "d1", name: "CUT_KV" }], recorded);
    expect(changed.problems).toEqual([
      "Binding CUT_KV was a kv resource (cut-cut-kv) and is a d1 resource in this version; Appflare does not replace a resource on update.",
    ]);
    expect(changed.toCreate).toEqual([]);
  });

  it("finishes a resource recorded by name only, under its recorded name", () => {
    // Its name was recorded before its create, and its id never was.
    const noId = diffBindings(
      "cut-2",
      [{ type: "kv_namespace", name: "CUT_KV" }],
      [row({ kind: "kv", binding: "CUT_KV", name: "cut-cut-kv" })],
    );
    expect(noId.problems).toEqual([]);
    expect(noId.existing).toEqual([]);
    expect(noId.toCreate).toEqual([
      expect.objectContaining({ binding: "CUT_KV", kind: "kv", name: "cut-cut-kv" }),
    ]);
  });

  it("carries the binding plan's own problems", () => {
    const diff = diffBindings("cut", [{ type: "mtls_certificate", name: "CERT" }], []);
    expect(diff.problems).toEqual([
      'Binding CERT has type "mtls_certificate", which Appflare cannot install yet.',
    ]);
  });

  it("lists kept indexes and buckets whose settings this version or the installed one declares", () => {
    const metadataIndexes = [{ propertyName: "url", type: "string" as const }];
    const lifecycle = [{ id: "tmp", deleteAfterDays: 1 }];
    const kept = [
      row({ kind: "vectorize", binding: "V", name: "old-v", cfId: "old-v" }),
      row({ kind: "vectorize", binding: "PLAIN_V", name: "old-plain-v", cfId: "old-plain-v" }),
      row({ kind: "r2", binding: "FILES", name: "old-files", cfId: "old-files" }),
      row({ kind: "r2", binding: "DROPPED", name: "old-dropped", cfId: "old-dropped" }),
      row({ kind: "r2", binding: "PLAIN", name: "old-plain", cfId: "old-plain" }),
    ];
    const diff = diffBindings(
      "cut",
      [
        { type: "vectorize", name: "V", dimensions: 3, metric: "cosine", metadataIndexes },
        { type: "vectorize", name: "PLAIN_V", dimensions: 3, metric: "cosine" },
        { type: "vectorize", name: "NEW_V", dimensions: 3, metric: "cosine", metadataIndexes },
        { type: "r2_bucket", name: "FILES", lifecycle },
        { type: "r2_bucket", name: "DROPPED" },
        { type: "r2_bucket", name: "PLAIN" },
      ],
      kept,
      {},
      [],
      {},
      {},
      ["DROPPED", "GONE"],
    );
    expect(diff.problems).toEqual([]);
    // Under the recorded names; a new index gets its settings when it is created.
    expect(
      diff.toConfigure.map(({ res, previouslyDeclared }) => [
        res.binding,
        res.name,
        previouslyDeclared,
      ]),
    ).toEqual([
      ["V", "old-v", false],
      ["FILES", "old-files", false],
      ["DROPPED", "old-dropped", true],
    ]);
    expect(diff.toCreate.map((r) => r.binding)).toEqual(["NEW_V"]);
  });

  it("reads the lifecycle rules a stored manifest declares, each bucket on its own", () => {
    const manifest = (r2: unknown) => JSON.stringify({ catalog: { resources: { r2 } } });
    const tmp = { id: "tmp", deleteAfterDays: 1 };
    // A bucket that does not parse hides only itself, and is named.
    expect(declaredLifecycleOf(manifest({ FILES: { lifecycle: [tmp] }, OTHER: {} }))).toEqual({
      rules: { FILES: [tmp] },
      unreadable: ["OTHER"],
    });
    const none = { rules: {}, unreadable: [] };
    expect(declaredLifecycleOf(JSON.stringify({ catalog: {} }))).toEqual(none);
    expect(declaredLifecycleOf(manifest([]))).toEqual(none);
    expect(declaredLifecycleOf("{not json")).toEqual(none);
    expect(declaredLifecycleOf(null)).toEqual(none);
  });

  it("tells a rollback which rules stay on which bucket", () => {
    const keep = { id: "keep", deleteAfterDays: 7 };
    const warnings = rollbackLifecycleWarnings({
      from: {
        rules: {
          FILES: [keep, { id: "a", deleteAfterDays: 1 }, { id: "b", deleteAfterDays: 2 }],
          CHANGED: [{ id: "keep", deleteAfterDays: 9 }],
          SAME: [keep],
          UNRECORDED: [keep],
        },
        unreadable: [],
      },
      to: { rules: { FILES: [keep], CHANGED: [keep], SAME: [keep] }, unreadable: [] },
      buckets: { FILES: "cut-files", CHANGED: "cut-changed", SAME: "cut-same" },
      toVersion: "1.0.0",
    });
    expect(warnings).toEqual([
      'The lifecycle rules "appflare:a", "appflare:b" on R2 bucket "cut-files" stay: a rollback does not change a bucket\'s rules, and version 1.0.0 does not declare them this way. They go on deleting or moving objects as they say; delete them in the bucket\'s settings if the app should not have them.',
      'The lifecycle rule "appflare:keep" on R2 bucket "cut-changed" stays: a rollback does not change a bucket\'s rules, and version 1.0.0 does not declare it this way. It goes on deleting or moving objects as it says; delete it in the bucket\'s settings if the app should not have it.',
    ]);
  });

  it("binds a recorded Hyperdrive configuration again, and creates one for a new database", () => {
    const databases = [
      { binding: "HD", protocol: "postgres" as const },
      { binding: "NEW_DB", protocol: "mysql" as const },
    ];
    const diff = diffBindings(
      "cut",
      [
        { type: "hyperdrive", name: "HD" },
        { type: "hyperdrive", name: "NEW_DB" },
      ],
      [row({ kind: "hyperdrive", binding: "HD", name: "cut-hd-r01h2x3y4", cfId: "hd-2" })],
      {},
      databases,
    );
    expect(diff.existing).toEqual([
      { binding: "HD", type: "hyperdrive", name: "cut-hd-r01h2x3y4", cfId: "hd-2" },
    ]);
    expect(diff.toCreate).toEqual([
      {
        binding: "NEW_DB",
        type: "hyperdrive",
        kind: "hyperdrive",
        name: "cut-new-db",
        protocol: "mysql",
      },
    ]);
    expect(diff.problems).toEqual([]);
  });

  it("asks for a connection string only for databases the install has no configuration for", () => {
    const databases = [
      { binding: "HD", protocol: "postgres" as const },
      { binding: "NEW_DB", protocol: "mysql" as const },
    ];
    const recorded = [
      row({ kind: "hyperdrive", binding: "HD", name: "cut-hd", cfId: "hd-1" }),
      // A configuration a settings change replaced keeps its binding's name.
      row({ kind: "hyperdrive_superseded", binding: "NEW_DB", name: "x", cfId: "hd-0" }),
    ];
    expect(newDatabases(databases, recorded).map((d) => d.binding)).toEqual(["NEW_DB"]);
    expect(newDatabases(databases, [])).toEqual(databases);
  });

  describe("Pipelines streams", () => {
    const sink = {
      type: "r2_data_catalog" as const,
      bucket: "WAREHOUSE",
      namespace: "cut",
      table: "events",
      tokenSecret: "CATALOG_TOKEN",
    };
    const schema = { fields: [{ name: "ts", type: "timestamp" as const, required: true }] };
    /** A stream an update that failed made with its sink, but without its pipeline. */
    const unfinished = [
      row({ kind: "pipeline_stream", binding: "EVENTS", name: "cut_events_stream", cfId: "s1" }),
      row({ kind: "pipeline_sink", binding: null, name: "cut_events_sink", cfId: "k1" }),
    ];
    const recorded = [
      ...unfinished,
      row({ kind: "pipeline", binding: null, name: "cut_events_pipeline", cfId: "p1" }),
    ];
    const installed = pipelineShapesOf(
      JSON.stringify({ catalog: { resources: { pipelines: { EVENTS: { schema, sink } } } } }),
    );
    const diffWith = (events: CatalogPipeline, extra: Record<string, CatalogPipeline> = {}) =>
      diffBindings(
        "cut",
        [
          { type: "pipelines", name: "EVENTS" },
          ...Object.keys(extra).map((name) => ({ type: "pipelines", name })),
        ],
        recorded,
        {},
        [],
        { EVENTS: events, ...extra },
        installed,
      );

    it("reads the installed version's stream shapes from its stored manifest", () => {
      expect(installed).toEqual({
        EVENTS: { schema, bucket: "WAREHOUSE", namespace: "cut", table: "events" },
      });
      expect(pipelineShapesOf(null)).toEqual({});
      expect(pipelineShapesOf("{not json")).toEqual({});
    });

    it("keeps a recorded stream whose schema and table stay, whatever else of the sink changes", () => {
      const diff = diffWith({ schema, sink: { ...sink, rollIntervalSeconds: 120 } });
      expect(diff.problems).toEqual([]);
      expect(diff.existing).toEqual([
        { binding: "EVENTS", type: "pipelines", name: "cut_events_stream", cfId: "s1" },
      ]);
    });

    it("refuses a version that changes a kept stream's schema or table", () => {
      expect(
        diffWith({ schema: { fields: [{ name: "other", type: "string" }] }, sink }).problems,
      ).toEqual([
        expect.stringMatching(
          /^Binding EVENTS sends events to the Pipelines stream "cut_events_stream"; this version changes its schema\. .* needs a fresh install\.$/,
        ),
      ]);
      expect(diffWith({ schema, sink: { ...sink, table: "events_v2" } }).problems).toEqual([
        expect.stringMatching(
          /changes the table its events land in \(from WAREHOUSE cut\.events to WAREHOUSE cut\.events_v2\)/,
        ),
      ]);
    });

    const complete = [
      ...recorded,
      row({ kind: "r2", binding: null, name: "cut-warehouse", cfId: "cut-warehouse" }),
      row({ kind: "r2_catalog", binding: null, name: "cut-warehouse", cfId: "cat-1" }),
    ];

    it("creates a stream new in this version, on the bucket and catalog the install has", () => {
      const diff = diffBindings(
        "cut",
        [
          { type: "pipelines", name: "EVENTS" },
          { type: "pipelines", name: "CLICKS" },
        ],
        complete,
        {},
        [],
        { EVENTS: { schema, sink }, CLICKS: { sink: { ...sink, table: "clicks" } } },
        installed,
      );
      expect(diff.problems).toEqual([]);
      expect(diff.existing.map((r) => r.binding)).toEqual(["EVENTS"]);
      expect(diff.toCreate).toEqual([
        expect.objectContaining({
          binding: "CLICKS",
          type: "pipelines",
          name: "cut_clicks_stream",
          pipeline: expect.objectContaining({
            sinkName: "cut_clicks_sink",
            pipelineName: "cut_clicks_pipeline",
            bucket: {
              key: "WAREHOUSE",
              name: "cut-warehouse",
              create: false,
              setUpCatalog: false,
              kept: true,
            },
          }),
        }),
      ]);
      expect(
        (diff.toCreate[0] as { pipeline: { made?: unknown } } | undefined)?.pipeline.made,
      ).toBeUndefined();
    });

    it("plans a new stream's own bucket and catalog as an install would when the install has neither", () => {
      const diff = diffBindings("cut", [{ type: "pipelines", name: "EVENTS" }], [], {}, [], {
        EVENTS: { schema, sink },
      });
      expect(diff.toCreate).toEqual([
        expect.objectContaining({
          pipeline: expect.objectContaining({
            bucket: { key: "WAREHOUSE", name: "cut-warehouse", create: true, setUpCatalog: true },
          }),
        }),
      ]);
    });

    it("finishes a stream an update that failed left without its pipeline", () => {
      const diff = diffBindings(
        "cut",
        [{ type: "pipelines", name: "EVENTS" }],
        unfinished,
        {},
        [],
        { EVENTS: { schema, sink } },
      );
      expect(diff.problems).toEqual([]);
      expect(diff.existing).toEqual([]);
      expect(diff.toCreate).toEqual([
        expect.objectContaining({
          binding: "EVENTS",
          pipeline: expect.objectContaining({
            made: { streamId: "s1", sink: true, pipeline: false },
          }),
        }),
      ]);
      expect(diff.leftInPlace).toEqual([]);
    });

    it("makes afresh what a stopped job recorded by name only, never counting it as made", () => {
      const byNameOnly = [
        row({ kind: "r2", name: "cut-warehouse" }),
        row({ kind: "pipeline_stream", binding: "EVENTS", name: "cut_events_stream" }),
      ];
      const fresh = diffBindings(
        "cut",
        [{ type: "pipelines", name: "EVENTS" }],
        byNameOnly,
        {},
        [],
        { EVENTS: { schema, sink } },
      );
      expect(fresh.problems).toEqual([]);
      expect(fresh.existing).toEqual([]);
      expect(fresh.toCreate).toEqual([
        expect.objectContaining({
          binding: "EVENTS",
          name: "cut_events_stream",
          pipeline: expect.objectContaining({
            streamName: "cut_events_stream",
            // Not the bucket of that name: its check refuses one that exists.
            bucket: { key: "WAREHOUSE", name: "cut-warehouse", create: true, setUpCatalog: true },
          }),
        }),
      ]);
      expect(
        (fresh.toCreate[0] as { pipeline: { made?: unknown } } | undefined)?.pipeline.made,
      ).toBeUndefined();
      expect(newStreamTokenSecrets("cut", { EVENTS: { schema, sink } }, byNameOnly)).toEqual([
        "CATALOG_TOKEN",
      ]);

      // A stream with its id, and its sink by name only: the sink is made again.
      const sinkByName = [
        ...unfinished.slice(0, 1),
        row({ kind: "pipeline_sink", name: "cut_events_sink" }),
      ];
      const rest = diffBindings(
        "cut",
        [{ type: "pipelines", name: "EVENTS" }],
        sinkByName,
        {},
        [],
        { EVENTS: { schema, sink } },
      );
      expect(rest.toCreate).toEqual([
        expect.objectContaining({
          pipeline: expect.objectContaining({
            made: { streamId: "s1", sink: false, pipeline: false },
          }),
        }),
      ]);
      expect(newStreamTokenSecrets("cut", { EVENTS: { schema, sink } }, sinkByName)).toEqual([
        "CATALOG_TOKEN",
      ]);
    });

    it("asks for the token of each sink the update makes, not for a missing pipeline alone", () => {
      const streams = {
        EVENTS: { schema, sink },
        CLICKS: { sink: { ...sink, table: "clicks", tokenSecret: "OTHER_TOKEN" } },
      };
      expect(newStreamTokenSecrets("cut", streams, complete)).toEqual(["OTHER_TOKEN"]);
      // The stream and its sink are there; only the pipeline is missing.
      expect(newStreamTokenSecrets("cut", streams, unfinished)).toEqual(["OTHER_TOKEN"]);
      // The stream is there without its sink.
      expect(newStreamTokenSecrets("cut", streams, unfinished.slice(0, 1))).toEqual([
        "CATALOG_TOKEN",
        "OTHER_TOKEN",
      ]);
      expect(newStreamTokenSecrets("cut", undefined, complete)).toEqual([]);
    });

    it("leaves a stream a later version drops in place", () => {
      const diff = diffBindings("cut", [], complete, {}, [], {}, installed);
      expect(diff.problems).toEqual([]);
      expect(diff.leftInPlace.map((r) => [r.kind, r.name])).toEqual([
        ["pipeline_stream", "cut_events_stream"],
      ]);
    });
  });
});

describe("liveStreamChange", () => {
  const sink = {
    type: "r2_data_catalog" as const,
    bucket: "WAREHOUSE",
    namespace: "cut",
    table: "events",
    tokenSecret: "CATALOG_TOKEN",
  };
  const where = { bucket: "cut-warehouse", namespace: "cut", table: "events" };
  /**
   * Every field type and option the manifest allows, and the `schema` of
   * `GET /pipelines/v1/streams/{id}` for a stream made with them, as
   * Cloudflare answered on a live account (2026-10-06): the fields as sent,
   * in order, with `required` and `unit` only where they were sent.
   */
  const fields: StreamField[] = [
    { name: "i32", type: "int32" },
    { name: "i64", type: "int64", required: true },
    { name: "f32", type: "float32", required: false },
    { name: "f64", type: "float64" },
    { name: "flag", type: "bool", required: true },
    { name: "url", type: "string" },
    { name: "blob", type: "binary" },
    { name: "at", type: "timestamp" },
    { name: "at_req", type: "timestamp", required: true },
    { name: "at_s", type: "timestamp", unit: "second" },
    { name: "at_ms", type: "timestamp", unit: "millisecond", required: true },
    { name: "at_us", type: "timestamp", unit: "microsecond", required: false },
    { name: "at_ns", type: "timestamp", unit: "nanosecond" },
    { name: "extra", type: "json" },
  ];
  /** `GET /pipelines/v1/streams/{id}` for that stream (id redacted). */
  const liveStream: PipelineStream = {
    id: "<stream id>",
    name: "appflare_probe_373e3aff",
    schema: {
      fields: [
        { name: "i32", type: "int32" },
        { name: "i64", type: "int64", required: true },
        { name: "f32", type: "float32", required: false },
        { name: "f64", type: "float64" },
        { name: "flag", type: "bool", required: true },
        { name: "url", type: "string" },
        { name: "blob", type: "binary" },
        { name: "at", type: "timestamp" },
        { name: "at_req", type: "timestamp", required: true },
        { name: "at_s", type: "timestamp", unit: "second" },
        { name: "at_ms", type: "timestamp", unit: "millisecond", required: true },
        { name: "at_us", type: "timestamp", unit: "microsecond", required: false },
        { name: "at_ns", type: "timestamp", unit: "nanosecond" },
        { name: "extra", type: "json" },
      ],
    },
  };
  const liveSchema = { fields: liveStream.schema?.fields ?? [] };
  /** The `schema` of the same call for a stream made without one. */
  const liveUnstructured = { fields: [{ name: "value", type: "json", required: true }] };

  it("finds no change in a stream made with the version's own schema", () => {
    expect(
      liveStreamChange(
        { schema: liveSchema.fields, sink: where },
        { declared: { schema: { fields }, sink } },
        "cut-warehouse",
      ),
    ).toBeNull();
  });

  it("finds no change in a stream made without a schema, for a version without one", () => {
    expect(
      liveStreamChange(
        { schema: liveUnstructured.fields, sink: null },
        { declared: { sink } },
        "cut-warehouse",
      ),
    ).toBeNull();
  });

  it("sees a field made optional, a unit, and a schema given or dropped", () => {
    const declared = (f: StreamField[]) => ({ declared: { schema: { fields: f }, sink } });
    const live = { schema: liveSchema.fields, sink: null };
    expect(
      liveStreamChange(live, declared(fields.map((f) => ({ ...f, required: false }))), "b"),
    ).toBe("its schema");
    expect(
      liveStreamChange(
        live,
        declared(fields.map((f) => (f.name === "at" ? { ...f, unit: "second" as const } : f))),
        "b",
      ),
    ).toBe("its schema");
    expect(liveStreamChange(live, declared([...fields].reverse()), "b")).toBe("its schema");
    expect(liveStreamChange(live, { declared: { sink } }, "b")).toBe("its schema");
    expect(
      liveStreamChange({ schema: liveUnstructured.fields, sink: null }, declared(fields), "b"),
    ).toBe("its schema");
  });
});

describe("durableObjectMigrationsSince", () => {
  const migrations = [
    { tag: "v1", new_sqlite_classes: ["Room"] },
    { tag: "v2", renamed_classes: [{ from: "Room", to: "Chat" }] },
    { tag: "v3", deleted_classes: ["Old"] },
  ];

  it("selects only the migrations after the applied tag", () => {
    expect(durableObjectMigrationsSince(migrations, "v1")).toEqual({
      old_tag: "v1",
      new_tag: "v3",
      steps: [{ renamed_classes: [{ from: "Room", to: "Chat" }] }, { deleted_classes: ["Old"] }],
    });
  });

  it("selects nothing when the Worker is up to date or the app has no migrations", () => {
    expect(durableObjectMigrationsSince(migrations, "v3")).toBeUndefined();
    expect(durableObjectMigrationsSince([], null)).toBeUndefined();
    expect(durableObjectMigrationsSince([], "v1")).toBeUndefined();
  });

  it("selects every migration with no applied tag, or one the manifest no longer has", () => {
    expect(durableObjectMigrationsSince(migrations, null)?.steps).toHaveLength(3);
    expect(durableObjectMigrationsSince(migrations, null)?.old_tag).toBeUndefined();
    expect(durableObjectMigrationsSince(migrations, "v0")).toMatchObject({
      old_tag: "v0",
      new_tag: "v3",
    });
  });

  it("reads the applied tag from a stored manifest", () => {
    expect(lastDurableObjectTagOf(JSON.stringify({ worker: { migrations } }))).toBe("v3");
    expect(lastDurableObjectTagOf(JSON.stringify({ worker: { migrations: [] } }))).toBeNull();
    expect(lastDurableObjectTagOf("not json")).toBeNull();
    expect(lastDurableObjectTagOf(null)).toBeNull();
  });
});

describe("updatePath", () => {
  const worker = (fields: Partial<ArtifactManifest["worker"]>) => ({
    worker: {
      name: "cut",
      wranglerConfig: { declared: "wrangler.jsonc", effective: "{}" },
      mainModule: "worker.js",
      compatibilityDate: "2024-12-30",
      compatibilityFlags: [],
      modules: [],
      bindings: [],
      migrations: [],
      crons: [],
      queueConsumers: [],
      observability: null,
      placement: null,
      limits: null,
      ...fields,
    },
  });
  const rooms = { Room: { type: "durable-object", storage: "sqlite" } };

  it("uploads a version when nothing changes the Worker's classes", () => {
    expect(updatePath(worker({ exports: rooms }), null, rooms)).toEqual({
      fullDeploy: null,
      scriptUpload: false,
      skipPreview: NO_PREVIEW_REASON,
    });
    expect(updatePath(worker({}), null, undefined)).toEqual({
      fullDeploy: null,
      scriptUpload: false,
      skipPreview: null,
    });
  });

  it("deploys the whole script when the exports differ from the serving version's", () => {
    const chat = { ...rooms, Chat: { type: "durable-object", storage: "sqlite" } };
    expect(updatePath(worker({ exports: chat }), null, rooms)).toEqual({
      fullDeploy: null,
      scriptUpload: true,
      skipPreview: EXPORTS_DEPLOY_REASON,
    });
    // A serving version without exports (installed before they were recorded).
    expect(updatePath(worker({ exports: rooms }), null, undefined).scriptUpload).toBe(true);
    // Exports removed.
    expect(updatePath(worker({}), null, rooms).scriptUpload).toBe(true);
  });

  it("uploads a version when only entrypoint exports change", () => {
    const api = { Api: { type: "worker", cache: { enabled: true } } };
    expect(updatePath(worker({ exports: { ...rooms, ...api } }), null, rooms)).toEqual({
      fullDeploy: null,
      scriptUpload: false,
      skipPreview: NO_PREVIEW_REASON,
    });
    expect(updatePath(worker({ exports: api }), null, undefined).scriptUpload).toBe(false);
  });

  it("records no applied migration tag when Durable Object exports replace migrations", () => {
    const migrations = [{ tag: "v1", new_sqlite_classes: ["Room"] }];
    expect(appliedDurableObjectTag({ migrations, exports: undefined })).toBe("v1");
    expect(appliedDurableObjectTag({ migrations, exports: rooms })).toBeNull();
    expect(lastDurableObjectTagOf(JSON.stringify({ worker: { migrations } }))).toBe("v1");
    expect(
      lastDurableObjectTagOf(JSON.stringify({ worker: { migrations, exports: rooms } })),
    ).toBeNull();
    // A later version without such exports would send every migration
    // (the update refuses it first when it drops a class the exports declared).
    expect(updatePath(worker({ migrations }), null, rooms).fullDeploy).toEqual({
      new_tag: "v1",
      steps: [{ new_sqlite_classes: ["Room"] }],
    });
  });

  it("applies pending migrations with a script upload, unless exports declare Durable Objects", () => {
    const migrations = [{ tag: "v1", new_sqlite_classes: ["Room"] }];
    expect(updatePath(worker({ migrations }), null, undefined)).toMatchObject({
      fullDeploy: { new_tag: "v1" },
      scriptUpload: true,
      skipPreview: FULL_DEPLOY_REASON,
    });
    expect(pendingDurableObjectMigrations({ migrations, exports: rooms }, null)).toBeNull();
    expect(updatePath(worker({ migrations, exports: rooms }), null, rooms)).toMatchObject({
      fullDeploy: null,
      scriptUpload: false,
    });
  });

  it("reads the serving exports from a stored manifest", () => {
    expect(workerExportsOf(JSON.stringify({ worker: { exports: rooms } }))).toEqual(rooms);
    expect(workerExportsOf(JSON.stringify({ worker: {} }))).toBeUndefined();
    expect(workerExportsOf("not json")).toBeUndefined();
    expect(workerExportsOf(null)).toBeUndefined();
  });
});

describe("droppedDurableObjectExportsProblem", () => {
  const room = { type: "durable-object", storage: "sqlite" };
  const api = { type: "worker" };

  it("refuses a version that leaves out a class the serving exports declare", () => {
    const problem = droppedDurableObjectExportsProblem(undefined, { Room: room });
    expect(problem).toContain('Durable Object class "Room" in its exports');
    expect(problem).toContain("must keep declaring it");
    // Back to migrations, or an entrypoint under the same name, is no declaration.
    expect(droppedDurableObjectExportsProblem({ Room: api }, { Room: room })).not.toBeNull();
    expect(
      droppedDurableObjectExportsProblem({ Room: room }, { Room: room, Chat: room }, "api"),
    ).toContain('class "Chat" of the Worker "api"');
    expect(droppedDurableObjectExportsProblem({}, { Room: room, Chat: room })).toContain(
      'classes "Room" and "Chat"',
    );
  });

  it("allows a version that keeps each class, live or as a tombstone", () => {
    expect(droppedDurableObjectExportsProblem({ Room: room }, { Room: room })).toBeNull();
    const deleted = { Room: { type: "durable-object", state: "deleted" } };
    expect(droppedDurableObjectExportsProblem(deleted, { Room: room })).toBeNull();
    const renamed = {
      Room: { type: "durable-object", state: "renamed", renamed_to: "Hall" },
      Hall: room,
    };
    expect(droppedDurableObjectExportsProblem(renamed, { Room: room })).toBeNull();
  });

  it("does not ask to keep tombstones, entrypoints, or classes from migrations", () => {
    const deleted = { Room: { type: "durable-object", state: "deleted" } };
    expect(droppedDurableObjectExportsProblem(undefined, deleted)).toBeNull();
    expect(droppedDurableObjectExportsProblem(undefined, { Api: api })).toBeNull();
    expect(droppedDurableObjectExportsProblem({ Room: room }, undefined)).toBeNull();
  });
});

describe("activeVersionId", () => {
  it("is the version of the first deployment at 100%", () => {
    expect(
      activeVersionId([
        { id: "d2", versions: [{ version_id: "v2", percentage: 100 }] },
        { id: "d1", versions: [{ version_id: "v1", percentage: 100 }] },
      ]),
    ).toBe("v2");
  });

  it("is null during a gradual deployment or without deployments", () => {
    expect(
      activeVersionId([
        {
          id: "d",
          versions: [
            { version_id: "v2", percentage: 50 },
            { version_id: "v1", percentage: 50 },
          ],
        },
      ]),
    ).toBeNull();
    expect(activeVersionId([])).toBeNull();
  });
});

describe("snapshot shape", () => {
  it("records the serving version, bookmarks by database id, and the state before the update", () => {
    const takenAt = new Date("2026-09-23T10:00:00Z");
    expect(
      snapshotRow({
        id: "job1",
        installId: "i1",
        jobId: "job1",
        workerVersionId: "11111111-2222-3333-4444-555555555555",
        bookmarks: [
          { databaseId: "d1-a", bookmark: "0000001-aaa" },
          { databaseId: "d1-b", bookmark: "0000002-bbb" },
        ],
        takenAt,
        before: {
          catalog_version: "1.0.0",
          manifest_json: '{"version":"1.0.0"}',
          artifact_url: "https://artifacts.test/cut-1.0.0.zip",
          artifact_digest: "a".repeat(64),
          pin_sha: "b".repeat(40),
          config_json: '{"HOME_PAGE":"admin"}',
        },
        doMigrationTag: "v1",
        targetVersion: "1.1.0",
        hyperdrive: { HYPERDRIVE: "hd-1" },
      }),
    ).toEqual({
      id: "job1",
      install_id: "i1",
      job_id: "job1",
      worker_version_id: "11111111-2222-3333-4444-555555555555",
      worker_versions_json: null,
      d1_bookmarks_json: '{"d1-a":"0000001-aaa","d1-b":"0000002-bbb"}',
      taken_at: takenAt,
      catalog_version: "1.0.0",
      manifest_json: '{"version":"1.0.0"}',
      artifact_url: "https://artifacts.test/cut-1.0.0.zip",
      artifact_digest: "a".repeat(64),
      pin_sha: "b".repeat(40),
      do_migration_tag: "v1",
      build_kind: "artifact",
      sandbox_image: null,
      built_at: null,
      origin: "catalog",
      source_url: null,
      source_ref: null,
      target_catalog_version: "1.1.0",
      config_json: '{"HOME_PAGE":"admin"}',
      hyperdrive_json: '{"HYPERDRIVE":"hd-1"}',
      access_aud: null,
    });
  });

  it("records the bound Hyperdrive configurations, and refuses a version that binds a deleted one", () => {
    expect(
      boundHyperdriveIds([
        { kind: "hyperdrive", binding: "DB", cfId: "hd-1" },
        { kind: "hyperdrive_superseded", binding: "DB", cfId: "hd-0" },
        { kind: "hyperdrive", binding: null, cfId: "hd-2" },
        { kind: "kv", binding: "KV", cfId: "kv-1" },
      ]),
    ).toEqual({ DB: "hd-1" });
    expect(parseSnapshotHyperdrive(null)).toBeNull();
    expect(parseSnapshotHyperdrive("not json")).toBeNull();
    expect(parseSnapshotHyperdrive('{"DB":"hd-1"}')).toEqual({ DB: "hd-1" });
    expect(hyperdriveRollbackRefusal("i1", { DB: "hd-1" }, new Set(["hd-1", "hd-0"]))).toBeNull();
    expect(hyperdriveRollbackRefusal("i1", { DB: "hd-0" }, new Set(["hd-1"]))).toMatch(
      /connects DB through a Hyperdrive configuration that has since been deleted.*\[Databases in the app.s settings\]\(\/apps\/i1#databases\)/,
    );
  });

  it("round-trips bookmarks and ignores malformed json", () => {
    const json = bookmarksJson([{ databaseId: "x", bookmark: "y" }]);
    expect(parseBookmarks(json)).toEqual({ x: "y" });
    expect(parseBookmarks("[]")).toEqual({});
    expect(parseBookmarks('{"x":1}')).toEqual({});
    expect(parseBookmarks("nope")).toEqual({});
  });
});

describe("canary", () => {
  it("probes the version's preview URL", () => {
    expect(previewUrl("0a1b2c3d-4e5f-6789-abcd-ef0123456789", "cut", "appflare-dev")).toBe(
      "https://0a1b2c3d-cut.appflare-dev.workers.dev/",
    );
  });

  it("uses the health classifier: 1042 retries, a 5xx fails, anything else passes", () => {
    const at = (status: number, body = "") =>
      classifyHealthProbe({ kind: "response", status, bodyStart: body }, 1, 0, 6);
    expect(at(404, "error code: 1042").verdict).toBe("retry");
    expect(at(404, "Not found").verdict).toBe("healthy");
    expect(at(302).verdict).toBe("healthy");
    expect(classifyHealthProbe({ kind: "response", status: 500, bodyStart: "" }, 6, 0, 6)).toEqual({
      verdict: "unhealthy",
      reason: "the Worker answered HTTP 500",
    });
  });

  it("is skipped when Cloudflare serves no preview for the version", () => {
    expect(canarySkipReason(true, 1)).toBeNull();
    expect(canarySkipReason(null, 0)).toBeNull();
    expect(canarySkipReason(false, 0)).toMatch(/no version preview URL/);
    expect(canarySkipReason(null, 1)).toMatch(/Durable Object/);
  });
});

describe("cronChanges", () => {
  it("lists what to add and remove", () => {
    expect(cronChanges(["a", "b"], ["b", "c"])).toEqual({
      changed: true,
      added: ["c"],
      removed: ["a"],
    });
    expect(cronChanges(["a"], ["a"]).changed).toBe(false);
  });
});

describe("missingSecrets", () => {
  const secret = (name: string, optional?: boolean) => ({
    name,
    label: name,
    ...(optional === undefined ? {} : { optional }),
  });

  it("asks only for required secrets the Worker does not have", () => {
    const declared = [secret("A"), secret("B"), secret("SMTP", true), secret("C", false)];
    expect(missingSecrets(declared, ["A"]).map((s) => s.name)).toEqual(["B", "C"]);
    expect(missingSecrets(declared, ["A", "B", "C"])).toEqual([]);
  });

  it("goes by key, so a recorded secret of the same name for another Worker does not count", () => {
    const declared = [
      { ...secret("CLIENT_ID"), key: "GITHUB_CLIENT_ID" },
      { ...secret("CLIENT_ID"), key: "SLACK_CLIENT_ID" },
    ];
    expect(missingSecrets(declared, ["GITHUB_CLIENT_ID"]).map((s) => s.key)).toEqual([
      "SLACK_CLIENT_ID",
    ]);
  });

  it("never asks for a seed-only secret, which only the install used", () => {
    const declared = [secret("A"), { ...secret("FIRST_ADMIN_PASSWORD"), seedOnly: true }];
    expect(missingSecrets(declared, [])).toEqual([secret("A")]);
  });
});

describe("accessUpdateRefusal", () => {
  it("refuses a version that requires Access for an unprotected install only", () => {
    const required = { access: { mode: "required" } };
    expect(accessUpdateRefusal({ catalog: required, isProtected: false })).toBe(
      "This version must run behind Cloudflare Access. Turn protection on for the app first, then update.",
    );
    expect(accessUpdateRefusal({ catalog: required, isProtected: true })).toBeNull();
    expect(
      accessUpdateRefusal({ catalog: { access: { mode: "recommended" } }, isProtected: false }),
    ).toBeNull();
    expect(accessUpdateRefusal({ catalog: {}, isProtected: false })).toBeNull();
  });
});
