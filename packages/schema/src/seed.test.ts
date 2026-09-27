import { describe, expect, it } from "vitest";
import { z } from "zod";
import { artifactFormatFor } from "./artifact";
import { catalogManifestSchema, secretValueProblem } from "./catalog";
import { generateBase64Key32, isBase64Key32 } from "./random-key";
import {
  bcryptInputProblem,
  bcryptSeedSources,
  boundToWorker,
  encodeSeedBytes,
  PBKDF2_MAX_ITERATIONS,
  pbkdf2SeedHash,
  seedStatementParams,
} from "./seed";
import { seedStatementProblems } from "./sql-guard";

const base = {
  slug: "edgechat",
  name: "EdgeChat",
  summary: "Encrypted chat on Workers.",
  homepage: "https://github.com/aozorae/Edgechat",
  repo: "aozorae/Edgechat",
  license: "MIT",
  categories: ["communication"],
  maintainers: ["MendyLanda"],
  source: { ref: "main", sha: "0".repeat(40) },
  install: {
    tier: "artifact",
    packageManager: "npm",
    wranglerConfig: "wrangler.toml",
    workerName: "edgechat",
  },
  plan: "free",
  requires: [],
  postInstall: [],
  tokenPermissions: [],
};

const USERS_INSERT =
  "INSERT OR IGNORE INTO users (username, display_name, password_hash, password_salt, is_admin, is_disabled) VALUES (?, ?, ?, ?, 1, 0)";

/** EdgeChat's entry: a PBKDF2 admin password, a seed-only user name, a generated key. */
const edgechat = {
  ...base,
  secrets: [
    {
      name: "EDGECHAT_ADMIN_PASSWORD",
      label: "Admin password",
      generate: true,
      seedOnly: true,
    },
    { name: "EDGECHAT_ENCRYPTION_KEY_1", label: "Encryption key", generate: "base64-key-32" },
  ],
  vars: [
    {
      name: "EDGECHAT_ADMIN_USERNAME",
      label: "Admin user name",
      required: true,
      seedOnly: true,
    },
    { name: "EDGECHAT_ENCRYPTION_ACTIVE_KEY_ID", label: "Active key", default: "auto-v1" },
  ],
  resources: {
    d1: {
      DB: {
        schema: ["worker/schema.sql"],
        seed: {
          hashes: {
            admin: {
              from: "EDGECHAT_ADMIN_PASSWORD",
              method: "pbkdf2-sha256",
              iterations: 100000,
              saltBytes: 16,
              keyBytes: 32,
              encoding: "base64url",
            },
          },
          statements: [
            {
              sql: USERS_INSERT,
              params: [
                { var: "EDGECHAT_ADMIN_USERNAME" },
                { var: "EDGECHAT_ADMIN_USERNAME" },
                { hash: "admin" },
                { salt: "admin" },
              ],
            },
          ],
        },
      },
    },
  },
};

/** edgeKey's entry: a bcrypt password claiming the `admin` row before the schema file. */
const edgekey = {
  ...base,
  slug: "edgekey",
  secrets: [
    { name: "EDGEKEY_ADMIN_PASSWORD", label: "Admin password", generate: true, seedOnly: true },
  ],
  vars: [],
  resources: {
    d1: {
      DB: {
        schema: ["scripts/seed.sql"],
        seed: {
          hashes: { admin: { from: "EDGEKEY_ADMIN_PASSWORD", method: "bcrypt" } },
          statements: [
            {
              sql: `INSERT INTO "Admin" ("username", "password") VALUES ('admin', ?) ON CONFLICT("username") DO NOTHING`,
              params: [{ hash: "admin" }],
            },
          ],
          beforeSchema: true,
        },
      },
    },
  },
};

type Manifest = typeof edgechat;
const seedOf = (m: Manifest) => m.resources.d1.DB.seed;

/** `edgechat` changed by `edit`, parsed. */
function parseEdited(edit: (m: Manifest) => void) {
  const copy = structuredClone(edgechat);
  edit(copy);
  return catalogManifestSchema.safeParse(copy);
}

function messages(result: { success: boolean; error?: z.ZodError }): string {
  return result.error === undefined ? "" : z.prettifyError(result.error);
}

describe("seed statements in the catalog manifest", () => {
  it("accepts EdgeChat's PBKDF2 seed and edgeKey's bcrypt seed before its schema file", () => {
    const chat = catalogManifestSchema.safeParse(edgechat);
    expect(messages(chat)).toBe("");
    expect(chat.data?.resources?.d1?.DB?.seed?.statements[0]?.params).toHaveLength(4);
    const key = catalogManifestSchema.safeParse(edgekey);
    expect(messages(key)).toBe("");
    expect(key.data?.resources?.d1?.DB?.seed?.beforeSchema).toBe(true);
  });

  it("accepts a seed as the binding's only SQL", () => {
    const parsed = parseEdited((m) => {
      m.resources.d1.DB = { seed: seedOf(m) } as typeof m.resources.d1.DB;
    });
    expect(messages(parsed)).toBe("");
  });

  it("refuses a statement the guard refuses, naming why", () => {
    const cases: Array<[string, string]> = [
      [`${USERS_INSERT}; DELETE FROM users`, "exactly one INSERT"],
      [USERS_INSERT.replace("INSERT OR IGNORE", "INSERT"), "without OR IGNORE"],
      [USERS_INSERT.replace("OR IGNORE", "OR REPLACE"), "INSERT OR REPLACE"],
      [
        `${USERS_INSERT.replace("OR IGNORE ", "")} ON CONFLICT(username) DO UPDATE SET is_admin = 1`,
        "DO UPDATE",
      ],
      [`WITH x AS (SELECT 1) ${USERS_INSERT}`, "starts with WITH"],
      ["INSERT OR IGNORE INTO d1_migrations (name) VALUES (?), (?), (?), (?)", "d1_migrations"],
      ["INSERT OR IGNORE INTO users SELECT ?, ?, ?, ? FROM sqlite_master", "sqlite_master"],
      [USERS_INSERT.replace("(?, ?, ?, ?", "(?1, ?2, ?3, ?4"), "numbered or named"],
      [USERS_INSERT.replace("(?, ?, ?, ?", "(:a, :b, :c, :d"), "numbered or named"],
      [USERS_INSERT.replace("(?, ?, ?, ?", "(?, ?, ?"), "3 ? placeholder(s) and 4 param(s)"],
    ];
    for (const [sql, why] of cases) {
      const parsed = parseEdited((m) => {
        (seedOf(m).statements[0] as { sql: string }).sql = sql;
      });
      expect(parsed.success, sql).toBe(false);
      expect(messages(parsed), sql).toContain(why);
      expect(parsed.error?.issues[0]?.path.slice(0, 7)).toEqual([
        "resources",
        "d1",
        "DB",
        "seed",
        "statements",
        0,
        "sql",
      ]);
    }
  });

  it("refuses more PBKDF2 iterations than Workers derive", () => {
    const parsed = parseEdited((m) => {
      seedOf(m).hashes.admin.iterations = PBKDF2_MAX_ITERATIONS + 1;
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual([
      "resources",
      "d1",
      "DB",
      "seed",
      "hashes",
      "admin",
      "iterations",
    ]);
  });

  it("refuses params naming unknown vars, secrets and hashes, and a param with two keys", () => {
    const unknownVar = parseEdited((m) => {
      seedOf(m).statements[0]?.params.splice(0, 1, { var: "NOPE" });
    });
    expect(messages(unknownVar)).toContain("NOPE is not a var of this manifest");
    const unknownSecret = parseEdited((m) => {
      seedOf(m).statements[0]?.params.splice(0, 1, { secret: "NOPE" } as never);
    });
    expect(messages(unknownSecret)).toContain("NOPE is not a secret of this manifest");
    const unknownHash = parseEdited((m) => {
      seedOf(m).statements[0]?.params.splice(2, 1, { hash: "other" });
    });
    expect(messages(unknownHash)).toContain('the hash "other" is not one of this seed');
    const twoKeys = parseEdited((m) => {
      seedOf(m).statements[0]?.params.splice(0, 1, {
        var: "EDGECHAT_ADMIN_USERNAME",
        value: "x",
      } as never);
    });
    expect(twoKeys.success).toBe(false);
    const unknownSource = parseEdited((m) => {
      seedOf(m).hashes.admin.from = "NOPE";
    });
    expect(messages(unknownSource)).toContain("which is not a secret of this manifest");
  });

  it("refuses the salt of a bcrypt hash and a hash no statement uses", () => {
    const bcryptSalt = catalogManifestSchema.safeParse({
      ...edgekey,
      resources: {
        d1: {
          DB: {
            seed: {
              ...edgekey.resources.d1.DB.seed,
              statements: [
                {
                  sql: `INSERT OR IGNORE INTO "Admin" ("username", "password", "salt") VALUES ('admin', ?, ?)`,
                  params: [{ hash: "admin" }, { salt: "admin" }],
                },
              ],
            },
          },
        },
      },
    });
    expect(messages(bcryptSalt)).toContain("only a pbkdf2-sha256 hash has a salt");
    const unused = parseEdited((m) => {
      const params = seedOf(m).statements[0]?.params ?? [];
      params.splice(2, 2, { value: "x" } as never, { value: "y" } as never);
    });
    expect(messages(unused)).toContain('the hash "admin" is never used');
  });

  it("refuses a var that may be empty and hashes of optional or derived secrets", () => {
    const empty = parseEdited((m) => {
      (m.vars[0] as { required: boolean }).required = false;
    });
    expect(messages(empty)).toContain("EDGECHAT_ADMIN_USERNAME may be left empty");
    const withDefault = parseEdited((m) => {
      (m.vars[0] as { required: boolean; default?: string }).required = false;
      (m.vars[0] as { default?: string }).default = "admin";
    });
    expect(messages(withDefault)).toBe("");
    const optional = parseEdited((m) => {
      (m.secrets[0] as { seedOnly?: boolean; optional?: boolean }).seedOnly = undefined;
      (m.secrets[0] as { optional?: boolean }).optional = true;
    });
    expect(messages(optional)).toContain("which is optional");
    const derived = parseEdited((m) => {
      m.secrets.push({
        name: "HASHED",
        label: "Hashed",
        derive: { from: "EDGECHAT_ENCRYPTION_KEY_1", method: "bcrypt" },
      } as never);
      seedOf(m).hashes.admin.from = "HASHED";
      (m.secrets[0] as { seedOnly?: boolean }).seedOnly = undefined;
    });
    expect(messages(derived)).toContain("which is itself derived");
  });

  it("refuses seed-only values no seed uses, or that are also optional, derived, or sources", () => {
    const unused = parseEdited((m) => {
      m.secrets.push({ name: "SPARE", label: "Spare", seedOnly: true } as never);
    });
    expect(messages(unused)).toContain("SPARE is seed-only, but no seed statement or hash uses it");
    const optional = parseEdited((m) => {
      (m.secrets[0] as { optional?: boolean }).optional = true;
    });
    expect(messages(optional)).toContain("is seed-only; it cannot also be optional");
    const source = parseEdited((m) => {
      m.secrets.push({
        name: "PASSWORD_HASH",
        label: "Hash",
        derive: { from: "EDGECHAT_ADMIN_PASSWORD", method: "bcrypt" },
      } as never);
    });
    expect(messages(source)).toContain("which is seed-only and never kept");
    const derivedVar = parseEdited((m) => {
      (m.vars[0] as { derive?: unknown }).derive = { from: "X", method: "vapid-public-key" };
    });
    expect(derivedVar.success).toBe(false);
  });

  it("refuses seeds and seed-only values on self-deploying entries", () => {
    const parsed = parseEdited((m) => {
      (m as { plan: string }).plan = "paid";
      (m.install as Record<string, unknown>).tier = "self-deploying";
    });
    expect(parsed.success).toBe(false);
    const text = messages(parsed);
    expect(text).toContain("resources.d1 is not allowed for the self-deploying tier");
    expect(text).toContain("seed-only secrets are not allowed for the self-deploying tier");
    expect(text).toContain("seed-only vars are not allowed for the self-deploying tier");
  });

  it("lists bcrypt sources, and keeps seed-only values away from the Worker", () => {
    const parsed = catalogManifestSchema.parse(edgekey);
    expect(bcryptSeedSources(parsed.resources ?? {})).toEqual(["EDGEKEY_ADMIN_PASSWORD"]);
    const chat = catalogManifestSchema.parse(edgechat);
    expect(boundToWorker(chat.secrets).map((s) => s.name)).toEqual(["EDGECHAT_ENCRYPTION_KEY_1"]);
    expect(boundToWorker(chat.vars).map((v) => v.name)).toEqual([
      "EDGECHAT_ENCRYPTION_ACTIVE_KEY_ID",
    ]);
    expect(bcryptInputProblem("Admin password", "a".repeat(72))).toBeNull();
    const long = bcryptInputProblem("Admin password", "é".repeat(37)) ?? "";
    expect(long).toContain("74 bytes");
    expect(long).not.toContain("é");
  });
});

describe("seedStatementProblems", () => {
  it("passes an INSERT OR IGNORE and an ON CONFLICT DO NOTHING with matching params", () => {
    expect(seedStatementProblems(USERS_INSERT, 4)).toEqual([]);
    expect(
      seedStatementProblems(
        `INSERT INTO "Admin" ("username", "password") VALUES ('admin', ?) ON CONFLICT("username") DO NOTHING;`,
        1,
      ),
    ).toEqual([]);
  });

  it("does not count a ? inside a string or a quoted name", () => {
    expect(
      seedStatementProblems(`INSERT OR IGNORE INTO "t?" (a, b) VALUES ('what?', ?) -- ?`, 1),
    ).toEqual([]);
  });

  it("refuses a statement kind other than INSERT, and words from other statements", () => {
    expect(seedStatementProblems("UPDATE users SET is_admin = ?", 1)[0]).toContain(
      "starts with UPDATE",
    );
    expect(
      seedStatementProblems("INSERT OR IGNORE INTO t (a) SELECT ? WHERE (PRAGMA x)", 1).join(),
    ).toContain("PRAGMA");
    expect(
      seedStatementProblems("INSERT OR IGNORE INTO `_cf_KV` (a) VALUES (?)", 1).join(),
    ).toContain("_cf_KV");
    expect(seedStatementProblems("-- only a comment", 0)).toEqual(["it has no SQL statement"]);
  });
});

describe("seed params and hashes", () => {
  it("binds params in placeholder order and never names a value in its errors", () => {
    const statement = catalogManifestSchema.parse(edgechat).resources?.d1?.DB?.seed
      ?.statements[0] as Parameters<typeof seedStatementParams>[0];
    const inputs = {
      vars: { EDGECHAT_ADMIN_USERNAME: "root" },
      secrets: {},
      hashes: { admin: { hash: "H", salt: "S" } },
    };
    expect(seedStatementParams(statement, inputs)).toEqual(["root", "root", "H", "S"]);
    expect(() =>
      seedStatementParams(statement, { ...inputs, hashes: { admin: { hash: "H" } } }),
    ).toThrow('the seed has no value for the salt of "admin"');
    expect(() => seedStatementParams(statement, { ...inputs, vars: {} })).toThrow(
      "the var EDGECHAT_ADMIN_USERNAME",
    );
  });

  it("derives PBKDF2-SHA-256 as RFC 7914's test vectors say", async () => {
    const vector = (password: string, salt: string, iterations: number) =>
      pbkdf2SeedHash(
        {
          from: "P",
          method: "pbkdf2-sha256",
          iterations,
          saltBytes: 16,
          keyBytes: 64,
          encoding: "hex",
        },
        password,
        new TextEncoder().encode(salt),
      );
    expect((await vector("passwd", "salt", 1)).hash).toBe(
      "55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783",
    );
    const slow = await vector("Password", "NaCl", 80000);
    expect(slow.hash).toBe(
      "4ddcd8f60b98be21830cee5ef22701f9641a4418d04c0414aeff08876b34ab56a1d425a1225833549adb841b51c9b3176a272bdebba1d078478f62b397f33c8d",
    );
    expect(slow.salt).toBe("4e61436c");
  });

  it("draws a fresh salt of saltBytes and writes both in the declared encoding", async () => {
    const hash = {
      from: "P",
      method: "pbkdf2-sha256" as const,
      iterations: 1000,
      saltBytes: 16,
      keyBytes: 32,
      encoding: "base64url" as const,
    };
    const a = await pbkdf2SeedHash(hash, "secret");
    const b = await pbkdf2SeedHash(hash, "secret");
    expect(a.salt).not.toBe(b.salt);
    expect(a.salt).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a.hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(encodeSeedBytes(new Uint8Array([0xfb, 0xff]), "base64")).toBe("+/8=");
    expect(encodeSeedBytes(new Uint8Array([0xfb, 0xff]), "base64url")).toBe("-_8");
  });
});

describe("base64-key-32", () => {
  it("generates 32 random bytes as padded base64, and refuses anything else", () => {
    const key = generateBase64Key32();
    expect(key).toHaveLength(44);
    expect(isBase64Key32(key)).toBe(true);
    expect(isBase64Key32(generateBase64Key32().slice(0, 43))).toBe(false);
    expect(isBase64Key32(btoa("x".repeat(31)))).toBe(false);
    const secret = { name: "K", label: "Key", generate: "base64-key-32" as const };
    expect(secretValueProblem(secret, key)).toBeNull();
    expect(secretValueProblem(secret, "not a key")).toContain("32 bytes as padded base64");
  });
});

describe("artifact format", () => {
  it("is 4 for an artifact whose catalog manifest carries a seed, whatever else it carries", () => {
    const catalog = catalogManifestSchema.parse(edgekey);
    expect(artifactFormatFor({ catalog })).toBe(4);
    expect(artifactFormatFor({ catalog, d1Schema: { DB: [{}] }, workers: [{}] })).toBe(4);
    expect(artifactFormatFor({ catalog: { resources: { d1: { DB: {} } } } })).toBe(1);
  });
});
