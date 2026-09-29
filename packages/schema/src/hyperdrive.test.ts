import { describe, expect, it } from "vitest";
import { z } from "zod";
import { catalogManifestSchema, wranglerConfigFromTemplate } from "./catalog";
import {
  connectionStringExample,
  connectionStringProblems,
  hyperdriveDeclarations,
  hyperdriveFieldLabel,
  MAX_HYPERDRIVE_BINDINGS,
  parseConnectionString,
} from "./hyperdrive";
import { appServices, deriveServices } from "./services";

const validManifest = {
  slug: "feedlog",
  name: "Feedlog",
  summary: "Feedback boards on Workers.",
  tagline: "An app on Workers",
  homepage: "https://github.com/linkcraftstudio/feedlog",
  repo: "linkcraftstudio/feedlog",
  license: "MIT",
  categories: ["business"],
  maintainers: ["MendyLanda"],
  source: { ref: "v0.5.0", sha: "0".repeat(40) },
  install: {
    tier: "artifact",
    packageManager: "pnpm",
    wranglerConfig: "wrangler.toml",
    workerName: "feedlog",
  },
  plan: "free",
  requires: [],
  secrets: [],
  vars: [],
  postInstall: [],
  tokenPermissions: [],
};

describe("resources.hyperdrive", () => {
  const withHyperdrive = (hyperdrive: unknown, install: Record<string, unknown> = {}) =>
    catalogManifestSchema.safeParse({
      ...validManifest,
      plan: install.tier === "self-deploying" ? "paid" : validManifest.plan,
      install: { ...validManifest.install, ...install },
      resources: { hyperdrive },
    });

  it("is optional", () => {
    expect(catalogManifestSchema.parse(validManifest).resources).toBeUndefined();
  });

  it("declares each binding by name with its protocol, and an optional label and help", () => {
    const declared = {
      HYPERDRIVE: { protocol: "postgres", label: "Main database", help: "Postgres 15+." },
      LEGACY: { protocol: "mysql" },
    };
    const parsed = withHyperdrive(declared);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.resources?.hyperdrive).toEqual(declared);
    expect(hyperdriveDeclarations(parsed.data?.resources?.hyperdrive)).toEqual([
      {
        binding: "HYPERDRIVE",
        protocol: "postgres",
        label: "Main database",
        help: "Postgres 15+.",
      },
      { binding: "LEGACY", protocol: "mysql" },
    ]);
    expect(hyperdriveDeclarations(undefined)).toEqual([]);
  });

  it("refuses unknown protocols, an empty record, too many bindings, and a list", () => {
    expect(withHyperdrive({ DB: { protocol: "sqlserver" } }).success).toBe(false);
    expect(withHyperdrive({}).success).toBe(false);
    expect(withHyperdrive([{ binding: "DB", protocol: "postgres" }]).success).toBe(false);
    const many = Object.fromEntries(
      Array.from({ length: MAX_HYPERDRIVE_BINDINGS + 1 }, (_, i) => [
        `DB${i}`,
        { protocol: "mysql" },
      ]),
    );
    expect(withHyperdrive(many).success).toBe(false);
  });

  it("is refused on self-deploying entries, whose installer creates its own", () => {
    const refused = withHyperdrive(
      { DB: { protocol: "postgres" } },
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
    expect(refused.error?.issues[0]?.path).toEqual(["resources", "hyperdrive"]);
  });

  it("states the self-deploying rule in the JSON Schema", () => {
    const schema = z.toJSONSchema(catalogManifestSchema);
    expect(JSON.stringify(schema.allOf)).toContain('"not":{"required":["hyperdrive"]}');
  });

  it("makes the app use Hyperdrive, with or without an artifact's Worker", () => {
    expect(deriveServices({ bindings: [{ type: "hyperdrive" }] }).ids).toEqual(["hyperdrive"]);
    expect(
      appServices(
        {
          requires: [],
          tokenPermissions: [],
          install: {},
          resources: { hyperdrive: { DB: { protocol: "postgres" } } },
        },
        null,
      ).ids,
    ).toEqual(["hyperdrive"]);
  });
});

describe("parseConnectionString", () => {
  it("reads a Postgres URL into a Hyperdrive origin, defaulting the port", () => {
    expect(
      parseConnectionString("postgres://app:s3cr%40t@db.example.com/feedlog", "postgres"),
    ).toEqual({
      ok: true,
      origin: {
        scheme: "postgres",
        host: "db.example.com",
        port: 5432,
        database: "feedlog",
        user: "app",
        password: "s3cr@t",
      },
    });
    const withPort = parseConnectionString(
      " postgresql://u:p@db.example.com:6543/app?sslmode=require ",
      "postgres",
    );
    expect(withPort).toMatchObject({ ok: true, origin: { scheme: "postgresql", port: 6543 } });
  });

  it("reads a MySQL URL, defaulting to port 3306", () => {
    expect(parseConnectionString("mysql://root:pw@mysql.example.com/shop", "mysql")).toMatchObject({
      ok: true,
      origin: { scheme: "mysql", port: 3306, database: "shop" },
    });
  });

  it("refuses the wrong protocol and every missing part, never repeating the string", () => {
    const secret = "hunter2-very-secret";
    const cases: Array<[string, RegExp]> = [
      [`mysql://u:${secret}@h/db`, /PostgreSQL database/],
      ["postgres:///db", /no host/],
      [`postgres://u:${secret}@/db`, /not a connection string/],
      [`postgres://:${secret}@h/db`, /no user/],
      ["postgres://u@h/db", /no password/],
      [`postgres://u:${secret}@h`, /no database/],
      [`postgres://u:${secret}@h/db/extra`, /no database/],
      [`not a url ${secret}`, /not a connection string/],
      ["", /Enter the connection string/],
      [`postgres://u:%E0%A4%A@h/db`, /malformed %-escape/],
    ];
    for (const [text, problem] of cases) {
      const result = parseConnectionString(text, "postgres");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.problem).toMatch(problem);
        expect(result.problem).not.toContain(secret);
      }
    }
  });

  it("gives an example per protocol for field descriptions", () => {
    expect(connectionStringExample("postgres")).toBe(
      "postgres://user:password@db.example.com:5432/database",
    );
    expect(connectionStringExample("mysql")).toBe(
      "mysql://user:password@db.example.com:3306/database",
    );
  });
});

describe("connectionStringProblems", () => {
  const declared = [
    { binding: "DB", protocol: "postgres" as const, label: "Main database" },
    { binding: "OLD", protocol: "mysql" as const },
  ];

  it("needs a valid string for every declared binding, and nothing else", () => {
    expect(
      connectionStringProblems(declared, {
        DB: "postgres://u:p@h/db",
        OLD: "mysql://u:p@h/db",
      }),
    ).toEqual([]);
    expect(connectionStringProblems(declared, { DB: "postgres://u:p@h/db", X: "y" })).toEqual([
      "X is not a database connection of this app.",
      "MySQL connection string (OLD) is required.",
    ]);
  });

  it("checks only what was entered when a settings change replaces some", () => {
    expect(connectionStringProblems(declared, {}, { required: false })).toEqual([]);
    expect(
      connectionStringProblems(declared, { DB: "mysql://u:p@h/db" }, { required: false }),
    ).toMatchInlineSnapshot(`
      [
        "Main database (DB): This app needs a PostgreSQL database: the connection string starts with postgres:// or postgresql://.",
      ]
    `);
  });

  it("labels a field by its declaration", () => {
    expect(hyperdriveFieldLabel({ binding: "DB", protocol: "postgres" })).toBe(
      "PostgreSQL connection string (DB)",
    );
  });
});

describe("wranglerConfigFromTemplate", () => {
  it("names the real config of a template kept beside it", () => {
    expect(wranglerConfigFromTemplate("wrangler.toml.example")).toBe("wrangler.toml");
    expect(wranglerConfigFromTemplate("worker/wrangler.jsonc.example")).toBe(
      "worker/wrangler.jsonc",
    );
    expect(wranglerConfigFromTemplate("worker/wrangler.toml.template")).toBe(
      "worker/wrangler.toml",
    );
    expect(wranglerConfigFromTemplate("wrangler.json.EXAMPLE")).toBe("wrangler.json");
  });

  it("leaves real configs, and templates of anything else, alone", () => {
    expect(wranglerConfigFromTemplate("wrangler.jsonc")).toBeNull();
    expect(wranglerConfigFromTemplate("wrangler.toml")).toBeNull();
    expect(wranglerConfigFromTemplate(".dev.vars.example")).toBeNull();
    expect(wranglerConfigFromTemplate("config/.toml.example")).toBeNull();
  });

  it("is accepted as install.wranglerConfig", () => {
    const parsed = catalogManifestSchema.safeParse({
      ...validManifest,
      install: { ...validManifest.install, wranglerConfig: "wrangler.toml.example" },
    });
    expect(parsed.success).toBe(true);
  });
});
