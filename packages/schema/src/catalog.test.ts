import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  appHealthMode,
  appHealthPath,
  catalogManifestSchema,
  EMAIL_ROUTING_MAX_RULES,
  hasFixedWorkerName,
  hasPlaceholder,
  renderJsonPlaceholders,
  renderPlaceholders,
  semverSchema,
} from "./catalog";

const validManifest = {
  $schema: "https://appflare.github.io/catalog/schema/v1.json",
  slug: "cut",
  name: "Cut",
  summary: "Self-hosted link shortener on Workers + KV.",
  homepage: "https://github.com/MendyLanda/cut",
  repo: "MendyLanda/cut",
  license: "MIT",
  categories: ["utilities"],
  maintainers: ["MendyLanda"],
  source: { ref: "v0.1.0", sha: "0".repeat(40) },
  install: {
    tier: "artifact",
    packageManager: "pnpm",
    wranglerConfig: "wrangler.jsonc",
    workerName: "cut",
  },
  plan: "free",
  requires: [],
  secrets: [
    {
      name: "ADMIN_PASSWORD",
      label: "Admin password",
      help: "Sign in to the admin UI.",
      generate: true,
    },
  ],
  vars: [],
  postInstall: [{ type: "markdown", content: "Open {{workerUrl}} and sign in." }],
  tokenPermissions: [],
};

describe("catalogManifestSchema", () => {
  it("accepts a valid manifest", () => {
    const parsed = catalogManifestSchema.parse(validManifest);
    expect(parsed.slug).toBe("cut");
    expect(parsed.install.tier).toBe("artifact");
    // `generate` defaults to false when omitted.
    expect(parsed.secrets[0]?.generate).toBe(true);
  });

  it("requires an https homepage", () => {
    for (const homepage of ["http://example.com", "javascript:alert(1)", "ftp://example.com"]) {
      expect(catalogManifestSchema.safeParse({ ...validManifest, homepage }).success).toBe(false);
    }
  });

  it("rejects an invalid manifest (bad plan enum and short sha)", () => {
    const invalid = {
      ...validManifest,
      plan: "enterprise",
      source: { ref: "v0.1.0", sha: "abc" },
    };
    const result = catalogManifestSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("treats fixedWorkerName as optional and false when omitted", () => {
    const omitted = catalogManifestSchema.parse(validManifest);
    expect(omitted.install.fixedWorkerName).toBeUndefined();
    expect(hasFixedWorkerName(omitted.install)).toBe(false);

    const fixed = catalogManifestSchema.parse({
      ...validManifest,
      install: { ...validManifest.install, fixedWorkerName: true },
    });
    expect(hasFixedWorkerName(fixed.install)).toBe(true);

    const notFixed = catalogManifestSchema.parse({
      ...validManifest,
      install: { ...validManifest.install, fixedWorkerName: false },
    });
    expect(hasFixedWorkerName(notFixed.install)).toBe(false);
  });

  it("takes an optional healthPath, defaulting to /", () => {
    const omitted = catalogManifestSchema.parse(validManifest);
    expect(omitted.install.healthPath).toBeUndefined();
    expect(appHealthPath(omitted.install)).toBe("/");
    const set = catalogManifestSchema.parse({
      ...validManifest,
      install: { ...validManifest.install, healthPath: "/api/health" },
    });
    expect(appHealthPath(set.install)).toBe("/api/health");
    for (const healthPath of ["api/health", "/a b", "/x?y=1", ""]) {
      const result = catalogManifestSchema.safeParse({
        ...validManifest,
        install: { ...validManifest.install, healthPath },
      });
      expect(result.success).toBe(false);
    }
  });

  it("takes an optional semver install.version without a leading v", () => {
    expect(catalogManifestSchema.parse(validManifest).install.version).toBeUndefined();
    for (const version of ["1.1.10", "0.0.1", "2.0.0-rc.1", "1.0.0+build.5"]) {
      const parsed = catalogManifestSchema.parse({
        ...validManifest,
        install: { ...validManifest.install, version },
      });
      expect(parsed.install.version).toBe(version);
    }
    for (const version of ["v1.1.10", "1.1", "01.2.3", "1.2.3-", "latest", "", 1]) {
      const result = catalogManifestSchema.safeParse({
        ...validManifest,
        install: { ...validManifest.install, version },
      });
      expect(result.success).toBe(false);
    }
  });

  it("takes optional Vectorize index settings keyed by binding", () => {
    expect(catalogManifestSchema.parse(validManifest).resources).toBeUndefined();
    const parsed = catalogManifestSchema.parse({
      ...validManifest,
      resources: { vectorize: { VECTORIZE: { dimensions: 384, metric: "cosine" } } },
    });
    expect(parsed.resources?.vectorize?.VECTORIZE).toEqual({ dimensions: 384, metric: "cosine" });
    for (const metric of ["euclidean", "dot-product"]) {
      const ok = catalogManifestSchema.safeParse({
        ...validManifest,
        resources: { vectorize: { V: { dimensions: 1536, metric } } },
      });
      expect(ok.success).toBe(true);
    }
    for (const index of [
      { dimensions: 0, metric: "cosine" },
      { dimensions: 1537, metric: "cosine" },
      { dimensions: 384.5, metric: "cosine" },
      { dimensions: 384, metric: "dot" },
      { dimensions: 384 },
      { metric: "cosine" },
    ]) {
      const result = catalogManifestSchema.safeParse({
        ...validManifest,
        resources: { vectorize: { V: index } },
      });
      expect(result.success).toBe(false);
    }
  });

  it("takes optional bump settings with a boolean autoMerge", () => {
    expect(catalogManifestSchema.parse(validManifest).bump).toBeUndefined();
    for (const autoMerge of [true, false]) {
      const parsed = catalogManifestSchema.parse({ ...validManifest, bump: { autoMerge } });
      expect(parsed.bump).toEqual({ autoMerge });
    }
    for (const bump of [{}, { autoMerge: "yes" }, { autoMerge: 1 }, { autoMerge: null }, true]) {
      expect(catalogManifestSchema.safeParse({ ...validManifest, bump }).success).toBe(false);
    }
  });

  it("takes an optional healthMode, defaulting to default", () => {
    const omitted = catalogManifestSchema.parse(validManifest);
    expect(omitted.install.healthMode).toBeUndefined();
    expect(appHealthMode(omitted.install)).toBe("default");
    for (const healthMode of ["default", "status-only"] as const) {
      const parsed = catalogManifestSchema.parse({
        ...validManifest,
        install: { ...validManifest.install, healthMode },
      });
      expect(appHealthMode(parsed.install)).toBe(healthMode);
    }
    for (const healthMode of ["status", "any", "", null, true]) {
      const result = catalogManifestSchema.safeParse({
        ...validManifest,
        install: { ...validManifest.install, healthMode },
      });
      expect(result.success).toBe(false);
    }
  });

  it("takes an optional buildCommand that runs without a shell", () => {
    expect(catalogManifestSchema.parse(validManifest).install.buildCommand).toBeUndefined();
    for (const buildCommand of [
      "pnpm --filter @mail2telegram/web build",
      "npx opennextjs-cloudflare build",
      "pnpm run build:worker --mode=selfhost",
    ]) {
      const parsed = catalogManifestSchema.parse({
        ...validManifest,
        install: { ...validManifest.install, buildCommand },
      });
      expect(parsed.install.buildCommand).toBe(buildCommand);
    }
    const refused: Array<[unknown, string]> = [
      ["pnpm build && rm -rf /", '"&"'],
      ["pnpm build | tee log", '"|"'],
      ["pnpm build > out.txt", '">"'],
      ["NODE_ENV=production pnpm build", "environment"],
      ["pnpm build; curl x", '";"'],
      ['pnpm "build"', '"'],
      ["pnpm build $HOME", '"$"'],
      ["pnpm\tbuild", "U+0009"],
      ["", "letters"],
      ["   ", "empty"],
      [`pnpm ${"x".repeat(260)}`, "256"],
      [42, ""],
    ];
    for (const [buildCommand, why] of refused) {
      const result = catalogManifestSchema.safeParse({
        ...validManifest,
        install: { ...validManifest.install, buildCommand },
      });
      expect(result.success, String(buildCommand)).toBe(false);
      expect(result.error?.issues.map((i) => i.message).join(" ")).toContain(why);
    }
  });

  it("rejects a non-boolean fixedWorkerName", () => {
    for (const fixedWorkerName of ["yes", 1, null]) {
      const result = catalogManifestSchema.safeParse({
        ...validManifest,
        install: { ...validManifest.install, fixedWorkerName },
      });
      expect(result.success).toBe(false);
    }
  });
});

describe("install.emailRouting", () => {
  const withRouting = (emailRouting: unknown) =>
    catalogManifestSchema.safeParse({
      ...validManifest,
      install: { ...validManifest.install, emailRouting },
    });

  it("is optional, so manifests without it keep their parsed shape", () => {
    const parsed = catalogManifestSchema.parse(validManifest);
    expect(parsed.install.emailRouting).toBeUndefined();
    expect("emailRouting" in parsed.install).toBe(false);
  });

  it("accepts a catch-all, local parts, and full addresses", () => {
    expect(withRouting({ catchAll: true }).success).toBe(true);
    expect(withRouting({ rules: ["inbox", "bills+2026", "a.b_c-d"] }).success).toBe(true);
    expect(withRouting({ rules: ["inbox@example.com", "x@mail.example.co.uk"] }).success).toBe(
      true,
    );
    expect(withRouting({ catchAll: true, rules: ["inbox"] }).success).toBe(true);
  });

  it("needs a catch-all or at least one address", () => {
    for (const value of [{}, { catchAll: false }, { rules: [] }, { catchAll: false, rules: [] }]) {
      expect(withRouting(value).success, JSON.stringify(value)).toBe(false);
    }
  });

  it("refuses malformed, uppercase, or duplicate addresses", () => {
    for (const rule of [
      "",
      "Inbox",
      "-inbox",
      "inbox.",
      ".inbox",
      "a..b",
      "a.-b",
      "a..b@example.com",
      "a".repeat(65),
      "in box",
      "a@b",
      "a@",
      "@example.com",
      "a@@b.com",
      "a@-x.com",
    ]) {
      expect(withRouting({ rules: [rule] }).success, rule).toBe(false);
    }
    expect(withRouting({ rules: ["inbox", "inbox"] }).success).toBe(false);
    expect(withRouting({ rules: ["a".repeat(64)] }).success).toBe(true);
  });

  it("states both rules in the JSON Schema, so editors refuse {} and repeats", () => {
    const install = z.toJSONSchema(catalogManifestSchema).properties?.install;
    const routing = typeof install === "object" ? install.properties?.emailRouting : undefined;
    expect(routing).toMatchObject({
      anyOf: [
        { required: ["catchAll"], properties: { catchAll: { const: true } } },
        { required: ["rules"], properties: { rules: { minItems: 1 } } },
      ],
      properties: { rules: { uniqueItems: true, maxItems: EMAIL_ROUTING_MAX_RULES } },
    });
    expect(typeof routing === "object" && routing.description).toContain("Email Routing");
  });

  it("caps the number of addresses", () => {
    const rules = Array.from({ length: EMAIL_ROUTING_MAX_RULES + 1 }, (_, i) => `box${i}`);
    expect(withRouting({ rules }).success).toBe(false);
    expect(withRouting({ rules: rules.slice(1) }).success).toBe(true);
  });
});

describe("semverSchema", () => {
  it("accepts semver without a leading v and nothing else", () => {
    expect(semverSchema.safeParse("11.0.0").success).toBe(true);
    expect(semverSchema.safeParse("1.2.3-beta.1+sha.abc").success).toBe(true);
    expect(semverSchema.safeParse("v11.0.0").success).toBe(false);
    expect(semverSchema.safeParse(" 1.2.3").success).toBe(false);
  });
});

describe("install placeholders", () => {
  const values = { workerUrl: "https://inbox.acme.workers.dev", workerName: "inbox" };

  it("fill in the Worker URL and name, with or without spaces inside the braces", () => {
    expect(renderPlaceholders("{{workerUrl}}/api and {{ workerName }}", values)).toBe(
      "https://inbox.acme.workers.dev/api and inbox",
    );
    expect(renderPlaceholders("{{other}} stays", values)).toBe("{{other}} stays");
    expect(hasPlaceholder("x {{ workerUrl }}")).toBe(true);
    expect(hasPlaceholder("{{other}}")).toBe(false);
  });

  it("keep {{workerUrl}} while the URL is unknown", () => {
    expect(renderPlaceholders("{{workerUrl}} {{workerName}}", { ...values, workerUrl: null })).toBe(
      "{{workerUrl}} inbox",
    );
  });

  it("fill in strings inside JSON values, never keys", () => {
    expect(
      renderJsonPlaceholders(
        { "{{workerName}}": ["{{workerUrl}}", 1, true, null, { u: "{{workerName}}" }] },
        values,
      ),
    ).toEqual({
      "{{workerName}}": ["https://inbox.acme.workers.dev", 1, true, null, { u: "inbox" }],
    });
    expect(renderJsonPlaceholders(3, values)).toBe(3);
  });

  it("keep a __proto__ key as an own property", () => {
    const parsed = JSON.parse('{"__proto__":{"u":"{{workerName}}"},"a":1}');
    const rendered = renderJsonPlaceholders(parsed, values);
    expect(JSON.stringify(rendered)).toBe('{"__proto__":{"u":"inbox"},"a":1}');
    expect(Object.getPrototypeOf(rendered)).toBe(Object.prototype);
  });
});
