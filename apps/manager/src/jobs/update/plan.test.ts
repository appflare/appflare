import { describe, expect, it } from "vitest";
import { classifyHealthProbe } from "../install/health";
import {
  activeVersionId,
  bookmarksJson,
  canarySkipReason,
  cronChanges,
  diffBindings,
  durableObjectMigrationsSince,
  lastDurableObjectTagOf,
  parseBookmarks,
  previewUrl,
  type RecordedResource,
  snapshotRow,
  updateRefusal,
  vectorizeShapesOf,
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

  it("refuses a binding whose resource kind changed, and one recorded without an id", () => {
    const changed = diffBindings("cut", [{ type: "d1", name: "CUT_KV" }], recorded);
    expect(changed.problems).toEqual([
      "Binding CUT_KV was a kv resource (cut-cut-kv) and is a d1 resource in this version; Appflare does not replace a resource on update.",
    ]);
    expect(changed.toCreate).toEqual([]);

    const noId = diffBindings(
      "cut",
      [{ type: "kv_namespace", name: "CUT_KV" }],
      [row({ kind: "kv", binding: "CUT_KV", name: "cut-cut-kv" })],
    );
    expect(noId.problems[0]).toMatch(/recorded without a Cloudflare id/);
  });

  it("carries the binding plan's own problems", () => {
    const diff = diffBindings("cut", [{ type: "hyperdrive", name: "HD" }], []);
    expect(diff.problems).toEqual([
      'Binding HD has type "hyperdrive", which Appflare cannot install yet.',
    ]);
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
        },
        doMigrationTag: "v1",
        targetVersion: "1.1.0",
      }),
    ).toEqual({
      id: "job1",
      install_id: "i1",
      job_id: "job1",
      worker_version_id: "11111111-2222-3333-4444-555555555555",
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
      target_catalog_version: "1.1.0",
    });
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
