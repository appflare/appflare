import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  appHealthMode,
  appHealthPath,
  authorsFromRepo,
  BCRYPT_COST,
  buildCommandList,
  buildCommandText,
  CATALOG_TOOLCHAINS,
  catalogAuthors,
  catalogManifestSchema,
  catalogVarOptions,
  DEFAULT_EXPECTED_BUILD_MINUTES,
  DEFAULT_SANDBOX_INSTANCE_TYPE,
  derivedSecretProblems,
  derivedVarProblems,
  EMAIL_ROUTING_MAX_RULES,
  enteredSecrets,
  hasFixedWorkerName,
  hasPlaceholder,
  INSTALL_PLACEHOLDERS,
  installTierSchema,
  installToolchains,
  isDerivedSecret,
  isDerivedVar,
  isOptionalSecret,
  MAX_BUILD_COMMANDS,
  MAX_VAR_OPTIONS,
  renderJsonPlaceholders,
  renderPlaceholders,
  runsInSandbox,
  SANDBOX_RUN_TIERS,
  sandboxBuildSettings,
  secretValueProblem,
  semverSchema,
} from "./catalog";
import { generateVapidPrivateKey } from "./vapid";

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

  it("takes a list of build commands, run in order, each under the same rules", () => {
    const buildCommand = ["pnpm run build:sphere", "pnpm run build"];
    const parsed = catalogManifestSchema.parse({
      ...validManifest,
      install: { ...validManifest.install, buildCommand },
    });
    expect(parsed.install.buildCommand).toEqual(buildCommand);
    expect(buildCommandList(parsed.install.buildCommand)).toEqual(buildCommand);
    expect(buildCommandList("pnpm build")).toEqual(["pnpm build"]);
    expect(buildCommandList(undefined)).toEqual([]);
    expect(buildCommandText(buildCommand)).toBe("pnpm run build:sphere && pnpm run build");
    const refused: Array<[unknown, string]> = [
      [[], "1"],
      [["pnpm build", "pnpm build && rm -rf /"], '"&"'],
      [["pnpm build", "CI=1 pnpm test"], "environment"],
      [
        Array.from({ length: MAX_BUILD_COMMANDS + 1 }, () => "pnpm build"),
        String(MAX_BUILD_COMMANDS),
      ],
      [[["pnpm", "build"]], ""],
    ];
    for (const [value, why] of refused) {
      const result = catalogManifestSchema.safeParse({
        ...validManifest,
        install: { ...validManifest.install, buildCommand: value },
      });
      expect(result.success, JSON.stringify(value)).toBe(false);
      if (result.error !== undefined) expect(z.prettifyError(result.error)).toContain(why);
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

describe("install.sandbox", () => {
  const withSandbox = (sandbox: unknown, tier = "sandbox") =>
    catalogManifestSchema.safeParse({
      ...validManifest,
      plan: "paid",
      install: { ...validManifest.install, tier, sandbox },
    });

  it("is optional, so manifests without it keep their parsed shape", () => {
    const parsed = catalogManifestSchema.parse({
      ...validManifest,
      install: { ...validManifest.install, tier: "sandbox" },
    });
    expect("sandbox" in parsed.install).toBe(false);
    expect(sandboxBuildSettings(parsed.install)).toEqual({
      expectedMinutes: DEFAULT_EXPECTED_BUILD_MINUTES,
      instanceType: DEFAULT_SANDBOX_INSTANCE_TYPE,
    });
  });

  it("takes expected minutes and a container size, each optional", () => {
    for (const sandbox of [
      {},
      { expectedMinutes: 1 },
      { expectedMinutes: 120 },
      { instanceType: "standard-1" },
      { expectedMinutes: 25, instanceType: "standard-2" },
    ]) {
      const result = withSandbox(sandbox);
      expect(result.success, JSON.stringify(sandbox)).toBe(true);
      expect(result.data?.install.sandbox).toEqual(sandbox);
    }
    const parsed = withSandbox({ expectedMinutes: 25 });
    expect(parsed.data && sandboxBuildSettings(parsed.data.install)).toEqual({
      expectedMinutes: 25,
      instanceType: "standard-1",
    });
  });

  it("refuses minutes that are not a whole number from 1 to 120, and unknown sizes", () => {
    for (const sandbox of [
      { expectedMinutes: 0 },
      { expectedMinutes: -5 },
      { expectedMinutes: 2.5 },
      { expectedMinutes: 121 },
      { expectedMinutes: "10" },
      { instanceType: "basic" },
      { instanceType: "standard-4" },
    ]) {
      expect(withSandbox(sandbox).success, JSON.stringify(sandbox)).toBe(false);
    }
  });

  it("is taken on self-deploying entries, whose installer runs in the sandbox Worker", () => {
    const parsed = catalogManifestSchema.safeParse({
      ...validManifest,
      plan: "paid",
      install: {
        ...validManifest.install,
        tier: "self-deploying",
        sandbox: { expectedMinutes: 15, instanceType: "standard-2" },
        selfDeploying: {
          tool: "alchemy",
          deployCommand: ["pnpm", "alchemy", "deploy", "--yes"],
          destroyCommand: ["pnpm", "alchemy", "destroy", "--yes"],
          stateStore: "cloudflare",
          workers: ["app-{{stage}}"],
        },
      },
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.data && sandboxBuildSettings(parsed.data.install)).toEqual({
      expectedMinutes: 15,
      instanceType: "standard-2",
    });
  });

  it("is refused on artifact entries, which never run in the user's account", () => {
    const result = withSandbox({ expectedMinutes: 10 }, "artifact");
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ["install", "sandbox"],
        message:
          "install.sandbox is only for the sandbox and self-deploying tiers, which run in the sandbox Worker; this entry's tier is artifact",
      }),
    ]);
  });

  it("names the tiers that run in the sandbox Worker", () => {
    expect(SANDBOX_RUN_TIERS).toEqual(["sandbox", "self-deploying"]);
    expect(installTierSchema.options.filter(runsInSandbox)).toEqual(["sandbox", "self-deploying"]);
  });

  it("states the tier rule in the JSON Schema, so editors refuse it on artifact entries", () => {
    const install = z.toJSONSchema(catalogManifestSchema).properties?.install;
    expect(install).toMatchObject({
      allOf: [
        {
          anyOf: [
            { not: { required: ["sandbox"] } },
            { properties: { tier: { enum: ["sandbox", "self-deploying"] } } },
          ],
        },
        // The self-deploying tier's rule (see self-deploying.test.ts).
        expect.anything(),
        // No Email Routing on a self-deploying entry.
        {
          anyOf: [
            { not: { required: ["emailRouting"] } },
            { properties: { tier: { not: { const: "self-deploying" } } } },
          ],
        },
        // No install directories on a self-deploying entry.
        {
          anyOf: [
            { not: { required: ["installDirs"] } },
            { properties: { tier: { not: { const: "self-deploying" } } } },
          ],
        },
        // Several Workers only on the artifact tier.
        {
          anyOf: [
            { not: { required: ["workers"] } },
            { properties: { tier: { const: "artifact" } } },
          ],
        },
        // A config patch neither beside several Workers nor on a self-deploying entry.
        {
          anyOf: [
            { not: { required: ["configPatch"] } },
            {
              not: { required: ["workers"] },
              properties: { tier: { not: { const: "self-deploying" } } },
            },
          ],
        },
        // Toolchains only on the artifact tier.
        {
          anyOf: [
            { not: { required: ["toolchains"] } },
            { properties: { tier: { const: "artifact" } } },
          ],
        },
      ],
      properties: {
        sandbox: {
          additionalProperties: false,
          properties: {
            expectedMinutes: { type: "integer", minimum: 1, maximum: 120 },
            instanceType: { enum: ["standard-1", "standard-2"] },
          },
        },
      },
    });
    const sandbox = typeof install === "object" ? install.properties?.sandbox : undefined;
    expect(typeof sandbox === "object" && sandbox.description).toContain("cost");
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

  it("list the account id", () => {
    expect(INSTALL_PLACEHOLDERS).toEqual(["workerUrl", "workerName", "accountId"]);
  });

  it("fill in the account id, and keep {{accountId}} while it is unknown", () => {
    const account = "0123456789abcdef0123456789abcdef";
    expect(
      renderPlaceholders("id={{accountId}} {{ accountId }}", { ...values, accountId: account }),
    ).toBe(`id=${account} ${account}`);
    expect(renderPlaceholders("{{accountId}}", values)).toBe("{{accountId}}");
    expect(renderPlaceholders("{{accountId}}", { ...values, accountId: null })).toBe(
      "{{accountId}}",
    );
    expect(hasPlaceholder("{{ accountId }}")).toBe(true);
    expect(
      renderJsonPlaceholders({ a: ["{{accountId}}"] }, { ...values, accountId: account }),
    ).toEqual({
      a: [account],
    });
  });

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

describe("authors", () => {
  const authors = [
    { name: "Ben Senescu", github: "bensenescu", x: "bensenescu" },
    { name: "Every App", url: "https://everyapp.dev/", github: "every-app" },
  ];

  it("are optional and kept as listed", () => {
    expect(catalogManifestSchema.parse(validManifest).authors).toBeUndefined();
    expect(catalogManifestSchema.parse({ ...validManifest, authors }).authors).toEqual(authors);
  });

  it("need at least one entry, each with a name", () => {
    expect(catalogManifestSchema.safeParse({ ...validManifest, authors: [] }).success).toBe(false);
    expect(
      catalogManifestSchema.safeParse({ ...validManifest, authors: [{ name: "" }] }).success,
    ).toBe(false);
    expect(
      catalogManifestSchema.safeParse({ ...validManifest, authors: [{ github: "octocat" }] })
        .success,
    ).toBe(false);
  });

  it("refuse links that are not https, and handles written with @", () => {
    for (const author of [
      { name: "A", url: "http://example.com" },
      { name: "A", url: "javascript:alert(1)" },
      { name: "A", github: "@octocat" },
      { name: "A", github: "octo--cat" },
      { name: "A", github: "-octocat" },
      { name: "A", github: "a".repeat(40) },
      { name: "A", x: "@octocat" },
      { name: "A", x: "a".repeat(16) },
      { name: "A", x: "octo-cat" },
    ]) {
      expect(
        catalogManifestSchema.safeParse({ ...validManifest, authors: [author] }).success,
        JSON.stringify(author),
      ).toBe(false);
    }
    expect(
      catalogManifestSchema.safeParse({
        ...validManifest,
        authors: [{ name: "A", url: "https://a.example", github: "a-b-c", x: "a_b" }],
      }).success,
    ).toBe(true);
  });

  it("default to the owner of the repository", () => {
    expect(catalogAuthors({ repo: "willswire/unifi-ddns" })).toEqual([
      { name: "willswire", github: "willswire" },
    ]);
    expect(catalogAuthors({ repo: "willswire/unifi-ddns", authors })).toEqual(authors);
  });

  it("derive no GitHub link from an owner GitHub would not accept", () => {
    expect(authorsFromRepo("not_a.login/repo")).toEqual([{ name: "not_a.login" }]);
    expect(authorsFromRepo("/repo")).toEqual([]);
  });
});

describe("secrets[].optional", () => {
  const selfDeploying = {
    tier: "self-deploying",
    selfDeploying: {
      tool: "alchemy",
      deployCommand: ["pnpm", "alchemy", "deploy", "--yes"],
      destroyCommand: ["pnpm", "alchemy", "destroy", "--yes"],
      stateStore: "cloudflare",
      workers: ["app-{{stage}}"],
    },
  };
  const withSecret = (secret: Record<string, unknown>, install: Record<string, unknown> = {}) =>
    catalogManifestSchema.safeParse({
      ...validManifest,
      plan: install.tier === "self-deploying" ? "paid" : validManifest.plan,
      install: { ...validManifest.install, ...install },
      secrets: [{ name: "SMTP_PASSWORD", label: "SMTP password", ...secret }],
    });

  it("is optional, so manifests without it keep their parsed shape", () => {
    const parsed = catalogManifestSchema.parse(validManifest);
    expect("optional" in (parsed.secrets[0] ?? {})).toBe(false);
    expect(isOptionalSecret(parsed.secrets[0] ?? {})).toBe(false);
  });

  it("marks a secret the app works without", () => {
    const parsed = withSecret({ optional: true });
    expect(parsed.success).toBe(true);
    expect(isOptionalSecret(parsed.data?.secrets[0] ?? {})).toBe(true);
    expect(withSecret({ optional: "yes" }).success).toBe(false);
  });

  it("is refused on self-deploying entries, whose installer expects every secret", () => {
    const refused = withSecret({ optional: true }, selfDeploying);
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.path).toEqual(["secrets", 0, "optional"]);
    expect(withSecret({ optional: false }, selfDeploying).success).toBe(true);
    expect(withSecret({}, selfDeploying).success).toBe(true);
  });

  it("states the self-deploying rule in the JSON Schema", () => {
    const schema = z.toJSONSchema(catalogManifestSchema);
    expect(JSON.stringify(schema.allOf)).toContain('"optional":{"const":true}');
    const secrets = schema.properties?.secrets;
    const items = typeof secrets === "object" ? secrets.items : undefined;
    expect(items).toMatchObject({ properties: { optional: { type: "boolean" } } });
  });
});

describe("vars[].type select", () => {
  const withVar = (v: Record<string, unknown>) =>
    catalogManifestSchema.safeParse({
      ...validManifest,
      vars: [{ name: "HOME_PAGE", label: "Home page", ...v }],
    });
  const options = [
    { value: "default", label: "Landing page" },
    { value: "404", label: "Not found" },
    { value: "admin", label: "Admin sign-in" },
  ];

  it("is optional, so vars without it keep their parsed shape", () => {
    const parsed = withVar({});
    expect(parsed.success).toBe(true);
    const v = parsed.data?.vars[0] ?? {};
    expect("type" in v || "options" in v).toBe(false);
    expect(catalogVarOptions(parsed.data?.vars[0] ?? {})).toBeNull();
  });

  it("takes options and a default that is one of them", () => {
    const parsed = withVar({ type: "select", options, default: "404" });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(catalogVarOptions(parsed.data?.vars[0] ?? {})).toEqual(options);
    expect(withVar({ type: "text", default: "anything" }).success).toBe(true);
  });

  it("needs options for select, and allows them only there", () => {
    expect(withVar({ type: "select" }).error?.issues[0]?.message).toMatch(/needs options/);
    expect(withVar({ options }).error?.issues[0]?.message).toMatch(/only allowed with/);
    expect(withVar({ type: "text", options }).success).toBe(false);
  });

  it("refuses a default outside the options, repeated values, and too few or too many", () => {
    const outside = withVar({ type: "select", options, default: "home" });
    expect(outside.error?.issues[0]?.path).toEqual(["vars", 0, "default"]);
    const repeated = withVar({
      type: "select",
      options: [...options, { value: "404", label: "Again" }],
    });
    expect(repeated.error?.issues[0]?.path).toEqual(["vars", 0, "options", 3, "value"]);
    expect(withVar({ type: "select", options: options.slice(0, 1) }).success).toBe(false);
    const many = Array.from({ length: MAX_VAR_OPTIONS + 1 }, (_, i) => ({
      value: `v${i}`,
      label: `V ${i}`,
    }));
    expect(withVar({ type: "select", options: many }).success).toBe(false);
    expect(withVar({ type: "select", options: many.slice(1) }).success).toBe(true);
    const empty = [...options, { value: "", label: "Empty" }];
    expect(withVar({ type: "select", options: empty }).success).toBe(false);
  });

  it("states the pairing of select and options in the JSON Schema", () => {
    const vars = z.toJSONSchema(catalogManifestSchema).properties?.vars;
    const items = typeof vars === "object" ? vars.items : undefined;
    expect(items).toMatchObject({
      allOf: [
        {
          anyOf: [
            { required: ["type", "options"], properties: { type: { const: "select" } } },
            { not: { required: ["options"] } },
          ],
        },
        // A derived var has no default, type or options, and is not required.
        {
          anyOf: [
            { not: { required: ["derive"] } },
            { properties: { required: { const: false } } },
          ],
        },
      ],
      properties: {
        type: { enum: ["text", "select"] },
        options: { minItems: 2, maxItems: MAX_VAR_OPTIONS },
      },
    });
  });
});

describe("derived secrets", () => {
  const counterscale = {
    ...validManifest,
    secrets: [
      { name: "CF_PASSWORD", label: "Admin password" },
      {
        name: "CF_PASSWORD_HASH",
        label: "Admin password hash",
        derive: { from: "CF_PASSWORD", method: "bcrypt" },
      },
      { name: "CF_JWT_SECRET", label: "Session key", generate: true },
    ],
  };

  it("take a source secret and a method, and leave the form to the others", () => {
    const parsed = catalogManifestSchema.parse(counterscale);
    const hash = parsed.secrets[1];
    expect(hash?.derive).toEqual({ from: "CF_PASSWORD", method: "bcrypt" });
    expect(hash !== undefined && isDerivedSecret(hash)).toBe(true);
    expect(enteredSecrets(parsed.secrets).map((s) => s.name)).toEqual([
      "CF_PASSWORD",
      "CF_JWT_SECRET",
    ]);
    expect(BCRYPT_COST).toBe(10);
    // Secrets without `derive` keep their parsed shape.
    expect(parsed.secrets[0]).toEqual({
      name: "CF_PASSWORD",
      label: "Admin password",
      generate: false,
    });
  });

  it("refuse a source that is missing, derived, optional or the secret itself", () => {
    const cases: Array<[Array<Record<string, unknown>>, string]> = [
      [
        [{ name: "H", label: "H", derive: { from: "P", method: "bcrypt" } }],
        "not a secret of this manifest",
      ],
      [[{ name: "H", label: "H", derive: { from: "H", method: "bcrypt" } }], "itself"],
      [
        [
          { name: "P", label: "P" },
          { name: "H", label: "H", derive: { from: "P", method: "bcrypt" } },
          { name: "H2", label: "H2", derive: { from: "H", method: "bcrypt" } },
        ],
        "itself derived",
      ],
      [
        [
          { name: "P", label: "P", optional: true },
          { name: "H", label: "H", derive: { from: "P", method: "bcrypt" } },
        ],
        "optional",
      ],
      [
        [
          { name: "P", label: "P" },
          { name: "H", label: "H", generate: true, derive: { from: "P", method: "bcrypt" } },
        ],
        "generated",
      ],
      [
        [
          { name: "P", label: "P" },
          { name: "H", label: "H", optional: true, derive: { from: "P", method: "bcrypt" } },
        ],
        "cannot be optional",
      ],
      [
        [
          { name: "P", label: "P" },
          { name: "H", label: "H", derive: { from: "P", method: "sha256" } },
        ],
        "bcrypt",
      ],
    ];
    for (const [secrets, why] of cases) {
      const result = catalogManifestSchema.safeParse({ ...validManifest, secrets });
      expect(result.success, why).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toContain(why);
    }
  });

  it("name the secret each problem is about", () => {
    expect(
      derivedSecretProblems([
        { name: "P", generate: false },
        { name: "H", generate: false, derive: { from: "Q", method: "bcrypt" } },
      ]),
    ).toEqual([
      {
        path: [1, "derive", "from"],
        message: "H derives from Q, which is not a secret of this manifest",
      },
    ]);
  });

  it("state their per-secret rule in the JSON Schema", () => {
    const text = JSON.stringify(z.toJSONSchema(catalogManifestSchema));
    expect(text).toContain('{"not":{"required":["derive"]}}');
    expect(text).toContain('{"required":["derive"]}');
  });

  it("are refused on self-deploying entries", () => {
    const result = catalogManifestSchema.safeParse({
      ...counterscale,
      plan: "paid",
      install: {
        ...validManifest.install,
        tier: "self-deploying",
        selfDeploying: {
          tool: "alchemy",
          deployCommand: ["pnpm", "alchemy", "deploy", "--yes"],
          destroyCommand: ["pnpm", "alchemy", "destroy", "--yes"],
          stateStore: "cloudflare",
          workers: ["cut-{{stage}}"],
        },
      },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("derived secrets are not allowed");
  });
});

describe("VAPID keys", () => {
  const push = {
    ...validManifest,
    secrets: [
      { name: "VAPID_PRIVATE_KEY", label: "Push signing key", generate: "vapid-private-key" },
    ],
    vars: [
      {
        name: "VAPID_PUBLIC_KEY",
        label: "Push public key",
        derive: { from: "VAPID_PRIVATE_KEY", method: "vapid-public-key" },
      },
    ],
  };

  it("generate a private key secret and derive a public key var from it", () => {
    const parsed = catalogManifestSchema.parse(push);
    expect(parsed.secrets[0]?.generate).toBe("vapid-private-key");
    const publicKey = parsed.vars[0];
    expect(publicKey?.derive).toEqual({ from: "VAPID_PRIVATE_KEY", method: "vapid-public-key" });
    expect(publicKey !== undefined && isDerivedVar(publicKey)).toBe(true);
    // A var without `derive` keeps its parsed shape.
    const plain = catalogManifestSchema.parse({
      ...push,
      vars: [{ name: "HOME", label: "Home" }],
    });
    expect(plain.vars[0]).toEqual({ name: "HOME", label: "Home", required: false });
  });

  it("derive a public key secret too", () => {
    const result = catalogManifestSchema.safeParse({
      ...push,
      secrets: [
        ...push.secrets,
        {
          name: "VAPID_PUBLIC_KEY",
          label: "Push public key",
          derive: { from: "VAPID_PRIVATE_KEY", method: "vapid-public-key" },
        },
      ],
      vars: [],
    });
    expect(result.success).toBe(true);
  });

  it("refuse a var derived from anything but an ordinary VAPID private key secret", () => {
    const derived = (from: string, extra: Record<string, unknown> = {}) => ({
      name: "PUB",
      label: "Public key",
      derive: { from, method: "vapid-public-key" },
      ...extra,
    });
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ vars: [derived("NOPE")] }, "not a secret of this manifest"],
      [{ vars: [{ name: "K", label: "K" }, derived("K")] }, "not a secret of this manifest"],
      [
        { secrets: [{ name: "K", label: "K", generate: true }], vars: [derived("K")] },
        'must then be generate: \\"vapid-private-key\\"',
      ],
      [
        {
          secrets: [{ name: "K", label: "K", generate: "vapid-private-key", optional: true }],
          vars: [derived("K")],
        },
        "optional",
      ],
      [{ vars: [derived("VAPID_PRIVATE_KEY", { default: "x" })] }, "cannot also have default"],
      [{ vars: [derived("VAPID_PRIVATE_KEY", { required: true })] }, "cannot be required"],
      [
        {
          vars: [
            derived("VAPID_PRIVATE_KEY", {
              type: "select",
              options: [
                { value: "a", label: "A" },
                { value: "b", label: "B" },
              ],
            }),
          ],
        },
        "cannot also have type",
      ],
      [
        {
          vars: [
            {
              ...derived("VAPID_PRIVATE_KEY"),
              derive: { from: "VAPID_PRIVATE_KEY", method: "bcrypt" },
            },
          ],
        },
        "vapid-public-key",
      ],
      [
        {
          secrets: [
            { name: "P", label: "P" },
            { name: "H", label: "H", derive: { from: "P", method: "vapid-public-key" } },
          ],
          vars: [],
        },
        'must then be generate: \\"vapid-private-key\\"',
      ],
      [{ secrets: [{ name: "K", label: "K", generate: "rsa-key" }], vars: [] }, "generate"],
    ];
    for (const [patch, why] of cases) {
      const result = catalogManifestSchema.safeParse({ ...push, ...patch });
      expect(result.success, why).toBe(false);
      expect(JSON.stringify(result.error?.issues), why).toContain(why);
    }
  });

  it("name the var each problem is about", () => {
    expect(
      derivedVarProblems(
        [{ name: "K", generate: true }],
        [{ name: "PUB", derive: { from: "K", method: "vapid-public-key" } }],
      ),
    ).toEqual([
      {
        path: [0, "derive", "method"],
        message:
          'PUB is the vapid-public-key of K, which must then be generate: "vapid-private-key"',
      },
    ]);
  });

  it("check a VAPID private key's value, never repeating it", () => {
    const secret = { name: "K", label: "Key", generate: "vapid-private-key" } as const;
    expect(secretValueProblem(secret, generateVapidPrivateKey())).toBeNull();
    const problem = secretValueProblem(secret, "hunter2");
    expect(problem).toContain("Key (K) must be a VAPID private key");
    expect(problem).not.toContain("hunter2");
    expect(secretValueProblem({ name: "P", label: "P", generate: true }, "x")).toBeNull();
  });

  it("state the derived var rules in the JSON Schema", () => {
    const text = JSON.stringify(z.toJSONSchema(catalogManifestSchema));
    expect(text).toContain('"vapid-private-key"');
    expect(text).toContain('"vapid-public-key"');
    expect(text).toContain('"vars":{"items":{"not":{"required":["derive"]}}}');
  });

  it("are refused on self-deploying entries as derived vars", () => {
    const result = catalogManifestSchema.safeParse({
      ...push,
      plan: "paid",
      install: {
        ...validManifest.install,
        tier: "self-deploying",
        selfDeploying: {
          tool: "alchemy",
          deployCommand: ["pnpm", "alchemy", "deploy", "--yes"],
          destroyCommand: ["pnpm", "alchemy", "destroy", "--yes"],
          stateStore: "cloudflare",
          workers: ["cut-{{stage}}"],
        },
      },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("derived vars are not allowed");
  });
});

describe("install.toolchains", () => {
  const withToolchains = (tier: string, toolchains: unknown) => ({
    ...validManifest,
    install: { ...validManifest.install, tier, toolchains },
    ...(tier === "sandbox" ? { plan: "paid", requires: ["containers"] } : {}),
  });

  it("records rust for an artifact entry, and none when omitted", () => {
    const parsed = catalogManifestSchema.parse(withToolchains("artifact", ["rust"]));
    expect(parsed.install.toolchains).toEqual(["rust"]);
    expect(installToolchains(parsed.install)).toEqual(["rust"]);
    expect(installToolchains(catalogManifestSchema.parse(validManifest).install)).toEqual([]);
    expect(CATALOG_TOOLCHAINS).toEqual(["rust"]);
  });

  it("refuses an unknown, repeated or empty list", () => {
    for (const toolchains of [["go"], ["rust", "rust"], []]) {
      expect(catalogManifestSchema.safeParse(withToolchains("artifact", toolchains)).success).toBe(
        false,
      );
    }
  });

  it("refuses them on a tier built in the sandbox image, which has no Rust", () => {
    const result = catalogManifestSchema.safeParse(withToolchains("sandbox", ["rust"]));
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ["install", "toolchains"],
        message:
          "install.toolchains (rust) is only for the artifact tier, which catalog CI builds with those toolchains installed; the sandbox image that builds sandbox entries in an account has no rust toolchain",
      }),
    ]);
  });
});

describe("a name that is both a secret and a var", () => {
  it("is refused, naming the var", () => {
    const result = catalogManifestSchema.safeParse({
      ...validManifest,
      vars: [{ name: "ADMIN_PASSWORD", label: "Admin password", required: false }],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ["vars", 0, "name"],
        message:
          "ADMIN_PASSWORD is declared both as a secret and as a var; a Worker cannot have a secret and a var of one name, so keep one of them",
      }),
    ]);
  });
});
