import { describe, expect, it } from "vitest";
import { z } from "zod";
import { workersPaidBindingProblem } from "./artifact";
import { catalogManifestSchema } from "./catalog";
import {
  appTokenPermissions,
  pipelineDeclarationProblems,
  pipelineTokenPermissions,
} from "./pipelines";
import { appServices, deriveServices } from "./services";

const validManifest = {
  slug: "traks",
  name: "Traks",
  summary: "Privacy-friendly web analytics on Cloudflare.",
  tagline: "An app on Workers",
  homepage: "https://github.com/shivamanupadi/traks",
  repo: "shivamanupadi/traks",
  license: "MIT",
  categories: ["analytics"],
  maintainers: ["MendyLanda"],
  source: { ref: "main", sha: "0".repeat(40) },
  install: {
    tier: "artifact",
    packageManager: "yarn",
    wranglerConfig: "apps/platform/collect/wrangler.toml",
    workerName: "traks",
  },
  plan: "paid",
  requires: [],
  secrets: [{ name: "CATALOG_TOKEN", label: "R2 API token" }],
  vars: [],
  postInstall: [],
  tokenPermissions: [],
};

const events = {
  schema: {
    fields: [
      { name: "ts", type: "timestamp", required: true },
      { name: "site_id", type: "string", required: true },
      { name: "screen_width", type: "int32" },
    ],
  },
  sink: {
    type: "r2_data_catalog",
    bucket: "EVENTS_WAREHOUSE",
    namespace: "traks",
    table: "events",
    tokenSecret: "CATALOG_TOKEN",
    rollIntervalSeconds: 60,
    compression: "zstd",
    compaction: true,
    snapshotExpiration: { maxAge: "30d", minSnapshotsToKeep: 5 },
  },
};

const parse = (over: Record<string, unknown> = {}, pipelines: unknown = { EVENTS: events }) =>
  catalogManifestSchema.safeParse({ ...validManifest, ...over, resources: { pipelines } });

describe("resources.pipelines", () => {
  it("describes each stream with its schema and its R2 Data Catalog sink", () => {
    const parsed = parse();
    expect(parsed.success).toBe(true);
    expect(parsed.data?.resources?.pipelines).toEqual({ EVENTS: events });
  });

  it("allows an unstructured stream and a sink with Cloudflare's defaults", () => {
    const sink = {
      type: "r2_data_catalog",
      bucket: "W",
      namespace: "n",
      table: "t",
      tokenSecret: "CATALOG_TOKEN",
    };
    expect(parse({}, { EVENTS: { sink } }).success).toBe(true);
  });

  it("refuses shapes Cloudflare would refuse", () => {
    const withSink = (sink: Record<string, unknown>) =>
      parse({}, { EVENTS: { ...events, sink: { ...events.sink, ...sink } } }).success;
    expect(withSink({ rollIntervalSeconds: 10 })).toBe(false);
    expect(withSink({ type: "r2" })).toBe(false);
    expect(withSink({ table: "my-table" })).toBe(false);
    expect(withSink({ compression: "brotli" })).toBe(false);
    expect(withSink({ snapshotExpiration: { maxAge: "30 days" } })).toBe(false);
    expect(
      parse({}, { EVENTS: { ...events, schema: { fields: [{ name: "x", type: "decimal" }] } } })
        .success,
    ).toBe(false);
    // A unit belongs to a timestamp.
    expect(
      parse(
        {},
        {
          EVENTS: { ...events, schema: { fields: [{ name: "x", type: "int64", unit: "second" }] } },
        },
      ).success,
    ).toBe(false);
    expect(parse({}, {}).success).toBe(false);
  });

  it("needs Workers Paid, which is the only plan Pipelines is on", () => {
    const refused = parse({ plan: "free" });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues).toContainEqual(
      expect.objectContaining({
        path: ["plan"],
        message: expect.stringMatching(/needs "plan": "paid"/),
      }),
    );
  });

  it("needs a token secret the install form asks for", () => {
    const missing = parse({ secrets: [] });
    expect(missing.error?.issues).toContainEqual(
      expect.objectContaining({
        path: ["resources", "pipelines", "EVENTS", "sink", "tokenSecret"],
        message: "CATALOG_TOKEN is not one of the manifest's secrets",
      }),
    );
    for (const secret of [
      { generate: "password" },
      { optional: true },
      { seedOnly: true },
      { derive: { from: "OTHER", method: "bcrypt" } },
    ]) {
      const parsed = parse({
        secrets: [
          { name: "OTHER", label: "Other" },
          { name: "CATALOG_TOKEN", label: "R2 API token", ...secret },
        ],
      });
      expect(parsed.success).toBe(false);
      expect(JSON.stringify(parsed.error?.issues)).toContain(
        "holds the sink's Cloudflare API token",
      );
    }
  });

  it("is refused on self-deploying entries, whose installer creates its own", () => {
    const refused = parse({
      install: {
        ...validManifest.install,
        tier: "self-deploying",
        selfDeploying: {
          tool: "alchemy",
          deployCommand: ["pnpm", "alchemy", "deploy", "--yes"],
          destroyCommand: ["pnpm", "alchemy", "destroy", "--yes"],
          workerNames: ["app-{{stage}}"],
        },
      },
    });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues.map((i) => i.path)).toContainEqual(["resources", "pipelines"]);
  });

  it("states the plan and tier rules in the JSON Schema", () => {
    const allOf = JSON.stringify(z.toJSONSchema(catalogManifestSchema).allOf);
    expect(allOf).toContain('{"properties":{"plan":{"const":"paid"}}}');
    expect(allOf).toContain('"not":{"required":["pipelines"]}');
  });

  it("matches a Worker's Pipelines bindings one to one", () => {
    const bindings = [
      { type: "pipelines", name: "EVENTS" },
      { type: "pipelines", name: "CLICKS" },
      { type: "kv_namespace", name: "KV" },
    ];
    expect(pipelineDeclarationProblems(bindings, { EVENTS: events, LOGS: events })).toEqual([
      "Pipelines binding CLICKS is not declared in the catalog manifest's resources.pipelines, so Appflare does not know which stream to create for it.",
      "The catalog manifest's resources.pipelines declares LOGS, but the Worker has no Pipelines binding by that name.",
    ]);
    expect(pipelineDeclarationProblems(bindings.slice(0, 1), { EVENTS: events })).toEqual([]);
  });

  it("makes a Worker with a stream a Workers Paid app", () => {
    const bindings = [{ type: "pipelines", name: "EVENTS" }];
    expect(workersPaidBindingProblem(bindings, "free")).toMatch(
      /^the Worker binds a Pipelines stream \(EVENTS\), which Cloudflare offers only on Workers Paid/,
    );
    expect(workersPaidBindingProblem(bindings, "paid")).toBeNull();
  });

  it("lists each sink token's permissions with the app's own, once per secret", () => {
    const pipelines = parse({}, { EVENTS: events, CLICKS: events }).data?.resources?.pipelines;
    const own = {
      group: "DNS",
      scope: "zone",
      access: "edit",
      reason: "Its own DNS records.",
    } as const;
    const storageRead = {
      group: "Workers R2 Storage",
      scope: "account",
      access: "read",
      reason: "Reads its bucket.",
    } as const;
    const listed = appTokenPermissions({
      tokenPermissions: [own, storageRead],
      resources: { pipelines },
    });
    expect(listed.map((p) => `${p.scope}: ${p.group}: ${p.access}`)).toEqual([
      "zone: DNS: edit",
      // The sink needs edit, which covers the app's own read.
      "account: Workers R2 Storage: edit",
      "account: Workers R2 Data Catalog: edit",
      "account: Workers R2 SQL: read",
    ]);
    expect(listed[1]?.reason).toBe("Reads its bucket.");
    expect(pipelineTokenPermissions(pipelines)).toHaveLength(3);
    expect(pipelineTokenPermissions(pipelines)[1]?.reason).toMatch(/^In CATALOG_TOKEN: /);
    expect(appTokenPermissions({ tokenPermissions: [own] })).toEqual([own]);
  });

  it("makes the app use Pipelines and R2, with or without an artifact's Worker", () => {
    expect(deriveServices({ bindings: [{ type: "pipelines" }] }).ids).toEqual(["pipelines"]);
    const pipelines = parse().data?.resources?.pipelines;
    expect(pipelines).toBeDefined();
    expect(
      appServices(
        { requires: [], tokenPermissions: [], install: {}, resources: { pipelines } },
        null,
      ).ids,
    ).toEqual(["r2", "pipelines"]);
  });
});
