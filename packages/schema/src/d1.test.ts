import { describe, expect, it } from "vitest";
import { z } from "zod";
import { artifactD1Files, artifactD1Problems, artifactManifestSchema } from "./artifact";
import { catalogManifestSchema } from "./catalog";
import {
  checkoutRelativePathSchema,
  compareMigrationNames,
  migrationsGlobBase,
  migrationsGlobProblem,
} from "./d1";

describe("compareMigrationNames", () => {
  it("orders migrations as wrangler does: leading numbers first, then text, segment by segment", () => {
    const names = [
      "10_c.sql",
      "9_b.sql",
      "0001_a.sql",
      "notes.sql",
      "2_x/migration.sql",
      "2_x",
      "20240101_init/migration.sql",
      "1_a.sql",
    ];
    expect([...names].sort(compareMigrationNames)).toEqual([
      "0001_a.sql",
      "1_a.sql",
      "2_x",
      "2_x/migration.sql",
      "9_b.sql",
      "10_c.sql",
      "20240101_init/migration.sql",
      "notes.sql",
    ]);
  });
});

const validManifest = {
  slug: "tempik",
  name: "Tempik",
  summary: "Disposable inboxes on Workers.",
  tagline: "Disposable inboxes",
  repo: "hirotomasato/tempik",
  license: "MIT",
  categories: ["email"],
  maintainers: ["MendyLanda"],
  source: { ref: "main", sha: "0".repeat(40) },
  install: {
    tier: "artifact",
    packageManager: "pnpm",
    wranglerConfig: "wrangler.toml",
    workerName: "tempik",
  },
  plan: "free",
  requires: [],
  secrets: [],
  vars: [],
  postInstall: [],
  tokenPermissions: [],
};

const withD1 = (d1: unknown, install: Record<string, unknown> = {}) =>
  catalogManifestSchema.safeParse({
    ...validManifest,
    plan: install.tier === "self-deploying" ? "paid" : validManifest.plan,
    install: { ...validManifest.install, ...install },
    resources: { d1 },
  });

describe("resources.d1", () => {
  it("is optional", () => {
    expect(catalogManifestSchema.parse(validManifest).resources).toBeUndefined();
  });

  it("takes a migrations folder or glob, schema files, and a post-deploy folder per binding", () => {
    const d1 = {
      DB: {
        migrationsGlob: "prisma/migrations/*/migration.sql",
        schema: ["src/db/schema.sql", "src/db/indexes.sql"],
        postDeployMigrationsDir: "migrations-after-deploy",
      },
      LOGS: { migrationsDir: "worker/migrations" },
    };
    const parsed = withD1(d1);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.resources?.d1).toEqual(d1);
  });

  it("refuses both a folder and a glob, an empty entry, and a schema file listed twice", () => {
    const both = withD1({ DB: { migrationsDir: "migrations", migrationsGlob: "db/*.sql" } });
    expect(both.success).toBe(false);
    expect(both.error?.issues[0]?.path).toEqual(["resources", "d1", "DB", "migrationsGlob"]);
    expect(withD1({ DB: {} }).success).toBe(false);
    const twice = withD1({ DB: { schema: ["schema.sql", "schema.sql"] } });
    expect(twice.success).toBe(false);
    expect(twice.error?.issues[0]?.path).toEqual(["resources", "d1", "DB", "schema", 1]);
    expect(withD1({ DB: { schema: [] } }).success).toBe(false);
  });

  it("takes a baseline beside migrations, but not beside schema files", () => {
    const d1 = { DB: { baseline: "db/schema.sql", migrationsDir: "db/migrations" } };
    expect(withD1(d1).data?.resources?.d1).toEqual(d1);
    expect(withD1({ DB: { baseline: "schema.sql" } }).success).toBe(true);
    const both = withD1({ DB: { baseline: "schema.sql", schema: ["schema.sql"] } });
    expect(both.success).toBe(false);
    expect(both.error?.issues[0]?.path).toEqual(["resources", "d1", "DB", "baseline"]);
    expect(withD1({ DB: { baseline: "../schema.sql" } }).success).toBe(false);
    const json = JSON.stringify(z.toJSONSchema(catalogManifestSchema));
    expect(json).toContain('{"not":{"required":["baseline","schema"]}}');
  });

  it("refuses paths that leave the checkout or are not relative", () => {
    for (const path of [
      "../schema.sql",
      "db/../../schema.sql",
      "./schema.sql",
      "db/./schema.sql",
      "/etc/schema.sql",
      "db//schema.sql",
      "db/",
      "db\\schema.sql",
      "",
      "..",
      ".",
    ]) {
      expect(checkoutRelativePathSchema.safeParse(path).success, path).toBe(false);
      expect(withD1({ DB: { schema: [path] } }).success, path).toBe(false);
      expect(withD1({ DB: { migrationsDir: path } }).success, path).toBe(false);
      expect(withD1({ DB: { postDeployMigrationsDir: path } }).success, path).toBe(false);
    }
    for (const path of ["schema.sql", ".sql/schema.sql", "db/v1.2/schema@x.sql", "..x/y"]) {
      expect(checkoutRelativePathSchema.safeParse(path).success, path).toBe(true);
    }
  });

  it("takes a glob with a * that matches .sql files, relative to the folder before the *", () => {
    for (const [glob, base] of [
      ["prisma/migrations/*/migration.sql", "prisma/migrations"],
      ["db/*.sql", "db"],
      ["db/*_up.sql", "db"],
      ["db/**/*.sql", "db"],
    ]) {
      expect(migrationsGlobProblem(glob as string), glob).toBeNull();
      expect(migrationsGlobBase(glob as string)).toBe(base);
      expect(withD1({ DB: { migrationsGlob: glob } }).success, glob).toBe(true);
    }
    for (const glob of [
      "prisma/migrations/migration.sql",
      "*/*/migration.sql",
      "*.sql",
      "db/*",
      "db/v*/up.SQL",
      "../db/*.sql",
      "db/?.sql",
      "/db/*.sql",
    ]) {
      expect(migrationsGlobProblem(glob), glob).not.toBeNull();
      expect(withD1({ DB: { migrationsGlob: glob } }).success, glob).toBe(false);
    }
  });

  it("is refused on self-deploying entries, and says so in the JSON Schema", () => {
    const refused = withD1(
      { DB: { schema: ["schema.sql"] } },
      {
        tier: "self-deploying",
        selfDeploying: {
          tool: "alchemy",
          deployCommand: ["pnpm", "alchemy", "deploy", "--yes"],
          destroyCommand: ["pnpm", "alchemy", "destroy", "--yes"],
          workerNames: ["app-{{stage}}"],
        },
      },
    );
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.path).toEqual(["resources", "d1"]);
    const schema = z.toJSONSchema(catalogManifestSchema);
    expect(JSON.stringify(schema.allOf)).toContain('"not":{"required":["d1"]}');
  });
});

const sha256 = "a".repeat(64);
const file = (dir: string, binding: string, name: string, offset = 0) => ({
  name,
  path: `${dir}/${binding}/${name}`,
  size: 1,
  sha256,
  offset,
});

const artifact = (
  sql: Record<string, unknown>,
  d1?: unknown,
  install: Record<string, unknown> = {},
) => ({
  format: 1,
  app: "tempik",
  version: "0.0.0-20260927.0000000",
  builtAt: "2026-09-27T12:00:00Z",
  builder: "@appflare/pack@0.1.0",
  keyId: "unsigned",
  worker: {
    name: "tempik",
    wranglerConfig: { declared: "wrangler.toml", effective: "wrangler.toml" },
    mainModule: "index.js",
    compatibilityDate: "2024-12-30",
    compatibilityFlags: [],
    modules: [
      { name: "index.js", type: "esm", path: "worker/index.js", size: 1, sha256, offset: 0 },
    ],
    bindings: [{ type: "d1", name: "DB" }],
    migrations: [],
    crons: [],
    observability: null,
    placement: null,
    limits: null,
  },
  assets: { config: {}, binding: null, files: [] },
  d1: { DB: { migrations: [file("d1", "DB", "0001_init.sql")], ...sql } },
  catalog: {
    ...validManifest,
    install: { ...validManifest.install, ...install },
    ...(d1 === undefined ? {} : { resources: { d1 } }),
  },
});

/** The problems of an artifact as the check reads it, defaults filled in. */
const problems = (sql: Record<string, unknown>, d1?: unknown) => {
  const raw = artifact(sql, d1);
  return artifactD1Problems({
    d1: { DB: { schema: [], postDeploy: [], ...raw.d1.DB } },
    catalog: catalogManifestSchema.parse(raw.catalog),
  } as Parameters<typeof artifactD1Problems>[0]);
};

describe("artifact D1 SQL", () => {
  const layout = { DB: { schema: ["src/db/schema.sql"], postDeployMigrationsDir: "after" } };

  it("records each binding's SQL together, and lists every D1 file", () => {
    const parsed = artifactManifestSchema.parse(artifact({}));
    expect(parsed.d1.DB).toEqual({
      migrations: [file("d1", "DB", "0001_init.sql")],
      schema: [],
      postDeploy: [],
    });
    expect(artifactD1Files(parsed).map((f) => f.name)).toEqual(["0001_init.sql"]);
  });

  it("takes schema files and post-deploy migrations the catalog manifest declares", () => {
    const parsed = artifactManifestSchema.parse(
      artifact(
        {
          schema: [file("d1-schema", "DB", "src/db/schema.sql")],
          postDeploy: [file("d1-post-deploy", "DB", "0001_finalize.sql")],
        },
        layout,
      ),
    );
    expect(artifactD1Files(parsed).map((f) => f.path)).toEqual([
      "d1/DB/0001_init.sql",
      "d1-schema/DB/src/db/schema.sql",
      "d1-post-deploy/DB/0001_finalize.sql",
    ]);
  });

  it("refuses lists the catalog manifest does not declare, or declares differently", () => {
    expect(problems({ schema: [file("d1-schema", "DB", "schema.sql")] })).toEqual([
      "D1 schema files are recorded for DB, but the catalog manifest declares none in resources.d1.DB.schema.",
    ]);
    expect(problems({ schema: [file("d1-schema", "DB", "other.sql")] }, layout)).toEqual([
      "The D1 schema files recorded for DB are not the ones resources.d1.DB.schema lists, in its order.",
    ]);
    expect(problems({}, { DB: { schema: ["schema.sql"] } })).toEqual([
      "resources.d1.DB.schema lists schema files, but the artifact records none for DB.",
    ]);
    expect(problems({ postDeploy: [file("d1-post-deploy", "DB", "0002.sql")] })).toEqual([
      "Post-deploy D1 migrations are recorded for DB, but the catalog manifest declares no resources.d1.DB.postDeployMigrationsDir.",
    ]);
  });

  it("takes the one baseline the catalog manifest names, and refuses any other", () => {
    const baselineLayout = { DB: { baseline: "db/schema.sql" } };
    const baseline = file("d1-baseline", "DB", "db/schema.sql");
    const parsed = artifactManifestSchema.parse(artifact({ baseline }, baselineLayout));
    expect(artifactD1Files(parsed).map((f) => f.path)).toEqual([
      "d1/DB/0001_init.sql",
      "d1-baseline/DB/db/schema.sql",
    ]);
    expect(problems({ baseline })).toEqual([
      "A D1 baseline is recorded for DB, but the catalog manifest declares no resources.d1.DB.baseline.",
    ]);
    expect(problems({ baseline: file("d1-baseline", "DB", "other.sql") }, baselineLayout)).toEqual([
      "The D1 baseline recorded for DB is not the file resources.d1.DB.baseline names.",
    ]);
    expect(problems({}, baselineLayout)).toEqual([
      "resources.d1.DB.baseline names a baseline, but the artifact records none for DB.",
    ]);
  });

  it("refuses a post-deploy migration named like a migration, since both are tracked by name", () => {
    const result = artifactManifestSchema.safeParse(
      artifact(
        {
          schema: [file("d1-schema", "DB", "src/db/schema.sql")],
          postDeploy: [file("d1-post-deploy", "DB", "0001_init.sql")],
        },
        layout,
      ),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["d1"]);
    expect(result.error?.issues[0]?.message).toMatch(
      /0001_init\.sql of DB is both a migration and a post-deploy migration/,
    );
  });

  it("holds an artifact of one Worker to the one-Worker rules", () => {
    const result = artifactManifestSchema.safeParse(
      artifact({}, undefined, {
        workers: [
          { name: "app", wranglerConfig: "wrangler.toml", primary: true },
          { name: "api", wranglerConfig: "api/wrangler.jsonc" },
        ],
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(
      /must list every Worker besides the primary one in workers/,
    );
  });
});
