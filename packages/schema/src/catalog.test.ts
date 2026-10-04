import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  authorsFromRepo,
  BCRYPT_COST,
  buildCommandList,
  buildCommandText,
  CATALOG_TOOLCHAINS,
  catalogAuthors,
  catalogHomepage,
  catalogManifestSchema,
  catalogVarOptions,
  catalogWorkerName,
  cloudflareTokenProblems,
  cloudflareTokenSecret,
  DEFAULT_EXPECTED_BUILD_MINUTES,
  DEFAULT_SANDBOX_INSTANCE_TYPE,
  derivedSecretProblems,
  derivedVarProblems,
  EMAIL_ROUTING_MAX_RULES,
  enteredSecrets,
  installTierSchema,
  installToolchains,
  isDerivedSecret,
  isDerivedVar,
  isMultilineSecret,
  isOptionalSecret,
  MAX_BUILD_COMMANDS,
  MAX_VAR_OPTIONS,
  multilineSecretProblems,
  needsWildcardHostname,
  runsInSandbox,
  SANDBOX_RUN_TIERS,
  SECRET_GENERATE_KINDS,
  sandboxBuildSettings,
  secretValueProblem,
  semverSchema,
  strictCatalogManifestSchema,
  strictRepositoryBuildManifestSchema,
  WILDCARD_REASON_MAX_LENGTH,
} from "./catalog";
import { generateVapidPrivateKey } from "./vapid";

/** A manifest that states only what has no default. */
const validManifest = {
  $schema: "https://appflare.github.io/catalog/schema/v1.json",
  slug: "cut",
  name: "Cut",
  summary: "Self-hosted link shortener on Workers + KV.",
  tagline: "Short links on your own domain",
  repo: "MendyLanda/cut",
  license: "MIT",
  categories: ["utilities"],
  maintainers: ["MendyLanda"],
  source: { ref: "v0.1.0", sha: "0".repeat(40) },
  install: {
    packageManager: "pnpm",
    wranglerConfig: "wrangler.jsonc",
  },
  plan: "free",
  secrets: [
    {
      name: "ADMIN_PASSWORD",
      label: "Admin password",
      help: "Sign in to the admin UI.",
      generate: "password",
    },
  ],
  postInstall: [{ type: "markdown", content: "Open {{appUrl}} and sign in." }],
};

const selfDeployingInstall = {
  tier: "self-deploying",
  selfDeploying: {
    tool: "alchemy",
    deployCommand: ["pnpm", "alchemy", "deploy", "--yes"],
    destroyCommand: ["pnpm", "alchemy", "destroy", "--yes"],
    workerNames: ["app-{{stage}}"],
  },
};

describe("catalogManifestSchema", () => {
  it("accepts a manifest that states only what has no default, and fills in the defaults", () => {
    const parsed = catalogManifestSchema.parse(validManifest);
    expect(parsed.slug).toBe("cut");
    expect(parsed.install).toEqual({
      tier: "artifact",
      packageManager: "pnpm",
      wranglerConfig: "wrangler.jsonc",
      fixedWorkerName: false,
      health: { path: "/", mode: "no-server-errors" },
    });
    expect(parsed.requires).toEqual([]);
    expect(parsed.vars).toEqual([]);
    expect(parsed.tokenPermissions).toEqual([]);
    expect(parsed.bump).toEqual({ autoMerge: false });
    expect(parsed.revision).toBe(1);
    expect(parsed.secrets[0]).toEqual({
      name: "ADMIN_PASSWORD",
      label: "Admin password",
      help: "Sign in to the admin UI.",
      generate: "password",
      optional: false,
      seedOnly: false,
      multiline: false,
      cloudflareToken: false,
    });
    expect(catalogManifestSchema.parse({ ...validManifest, secrets: undefined }).secrets).toEqual(
      [],
    );
    const { maintainers: _, postInstall: __, ...withoutLists } = validManifest;
    const bare = strictCatalogManifestSchema.parse(withoutLists);
    expect(bare.maintainers).toEqual([]);
    expect(bare.postInstall).toEqual([]);
  });

  it("requires a tagline", () => {
    const { tagline: _, ...rest } = validManifest;
    const result = catalogManifestSchema.safeParse(rest);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["tagline"]);
  });

  it("defaults the homepage to the repository, and requires https when set", () => {
    const parsed = catalogManifestSchema.parse(validManifest);
    expect(parsed.homepage).toBeUndefined();
    expect(catalogHomepage(parsed)).toBe("https://github.com/MendyLanda/cut");
    const set = catalogManifestSchema.parse({ ...validManifest, homepage: "https://cut.dev" });
    expect(catalogHomepage(set)).toBe("https://cut.dev");
    for (const homepage of ["http://example.com", "javascript:alert(1)", "ftp://example.com"]) {
      expect(catalogManifestSchema.safeParse({ ...validManifest, homepage }).success).toBe(false);
    }
  });

  it("defaults the Worker name to the slug", () => {
    const parsed = catalogManifestSchema.parse(validManifest);
    expect(parsed.install.workerName).toBeUndefined();
    expect(catalogWorkerName(parsed)).toBe("cut");
    const named = catalogManifestSchema.parse({
      ...validManifest,
      install: { ...validManifest.install, workerName: "cut-links" },
    });
    expect(catalogWorkerName(named)).toBe("cut-links");
  });

  it("rejects an invalid manifest (bad plan enum and short sha)", () => {
    const invalid = {
      ...validManifest,
      plan: "enterprise",
      source: { ref: "v0.1.0", sha: "abc" },
    };
    expect(catalogManifestSchema.safeParse(invalid).success).toBe(false);
  });

  it("takes fixedWorkerName, false by default", () => {
    const fixed = catalogManifestSchema.parse({
      ...validManifest,
      install: { ...validManifest.install, fixedWorkerName: true },
    });
    expect(fixed.install.fixedWorkerName).toBe(true);
    for (const fixedWorkerName of ["yes", 1, null]) {
      const result = catalogManifestSchema.safeParse({
        ...validManifest,
        install: { ...validManifest.install, fixedWorkerName },
      });
      expect(result.success).toBe(false);
    }
  });

  it("takes install.health with a path and a mode, each defaulted", () => {
    const withHealth = (health: unknown) =>
      catalogManifestSchema.safeParse({
        ...validManifest,
        install: { ...validManifest.install, health },
      });
    expect(withHealth({ path: "/api/health" }).data?.install.health).toEqual({
      path: "/api/health",
      mode: "no-server-errors",
    });
    expect(withHealth({ mode: "any-response" }).data?.install.health).toEqual({
      path: "/",
      mode: "any-response",
    });
    for (const health of [
      { path: "api/health" },
      { path: "/a b" },
      { path: "/x?y=1" },
      { path: "" },
      { mode: "status" },
      { mode: "status-only" },
      { mode: "default" },
      { mode: null },
      "/health",
    ]) {
      expect(withHealth(health).success, JSON.stringify(health)).toBe(false);
    }
  });

  it("takes an optional semver source.version without a leading v", () => {
    expect(catalogManifestSchema.parse(validManifest).source.version).toBeUndefined();
    for (const version of ["1.1.10", "0.0.1", "2.0.0-rc.1", "1.0.0+build.5"]) {
      const parsed = catalogManifestSchema.parse({
        ...validManifest,
        source: { ...validManifest.source, version },
      });
      expect(parsed.source.version).toBe(version);
    }
    for (const version of ["v1.1.10", "1.1", "01.2.3", "1.2.3-", "latest", "", 1]) {
      const result = catalogManifestSchema.safeParse({
        ...validManifest,
        source: { ...validManifest.source, version },
      });
      expect(result.success).toBe(false);
    }
  });

  it("takes one to three categories of any name, so a later category never breaks a manager", () => {
    const withCategories = (categories: unknown) =>
      catalogManifestSchema.safeParse({ ...validManifest, categories });
    for (const categories of [["cms", "ai", "notes"], ["gardening"], ["ai", "robots"]]) {
      expect(withCategories(categories).success, JSON.stringify(categories)).toBe(true);
    }
    for (const categories of [[], [""], ["ai", "chat", "notes", "sync"], "utilities"]) {
      expect(withCategories(categories).success, JSON.stringify(categories)).toBe(false);
    }
  });

  it("takes a token permission of any group, so a later group never breaks a manager", () => {
    const parsed = catalogManifestSchema.safeParse({
      ...validManifest,
      secrets: [{ name: "CF_API_TOKEN", label: "API token", cloudflareToken: true }],
      tokenPermissions: [
        { group: "Workers AI", scope: "account", access: "read", reason: "Runs models." },
      ],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.tokenPermissions[0]?.group).toBe("Workers AI");
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

  it("takes bump settings with a boolean autoMerge, false by default", () => {
    for (const autoMerge of [true, false]) {
      const parsed = catalogManifestSchema.parse({ ...validManifest, bump: { autoMerge } });
      expect(parsed.bump).toEqual({ autoMerge });
    }
    expect(catalogManifestSchema.parse({ ...validManifest, bump: {} }).bump).toEqual({
      autoMerge: false,
    });
    for (const bump of [{ autoMerge: "yes" }, { autoMerge: 1 }, { autoMerge: null }, true]) {
      expect(catalogManifestSchema.safeParse({ ...validManifest, bump }).success).toBe(false);
    }
    // A misspelt opt-out would otherwise be dropped and the bumps merge themselves.
    expect(
      strictCatalogManifestSchema.safeParse({ ...validManifest, bump: { automerge: false } })
        .success,
    ).toBe(false);
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

  it("does not require a field that has a default in the JSON Schema", () => {
    const schema = z.toJSONSchema(catalogManifestSchema);
    expect(schema.required).toContain("tagline");
    expect(schema.required).not.toContain("homepage");
  });
});

describe("install.wildcardHostname", () => {
  const reason = "Each tunnel gets its own address under this hostname.";
  const withWildcard = (install: Record<string, unknown>) =>
    catalogManifestSchema.safeParse({
      ...validManifest,
      install: { ...validManifest.install, ...install },
    });

  it("is off when omitted", () => {
    const parsed = catalogManifestSchema.parse(validManifest);
    expect("wildcardHostname" in parsed.install).toBe(false);
    expect(needsWildcardHostname(parsed.install)).toBe(false);
  });

  it("takes a reason, trimmed", () => {
    const parsed = withWildcard({ wildcardHostname: { reason: ` ${reason} ` } });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.install.wildcardHostname).toEqual({ reason });
    expect(parsed.data !== undefined && needsWildcardHostname(parsed.data.install)).toBe(true);
  });

  it("needs a reason of at most the maximum length", () => {
    for (const wildcardHostname of [
      true,
      {},
      { reason: "  " },
      { reason: "x".repeat(WILDCARD_REASON_MAX_LENGTH + 1) },
    ]) {
      expect(withWildcard({ wildcardHostname }).success, JSON.stringify(wildcardHostname)).toBe(
        false,
      );
    }
  });

  it("is refused on a self-deploying entry, whose installer decides where it answers", () => {
    const result = catalogManifestSchema.safeParse({
      ...validManifest,
      plan: "paid",
      install: { ...validManifest.install, ...selfDeployingInstall, wildcardHostname: { reason } },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.message).join("\n")).toContain(
      "install.wildcardHostname is not allowed for the self-deploying tier",
    );
  });

  it("states the rule in the JSON Schema, so editors refuse the same manifests", () => {
    const install = z.toJSONSchema(catalogManifestSchema).properties?.install;
    const allOf = typeof install === "object" ? (install.allOf ?? []) : [];
    expect(allOf).toContainEqual({
      anyOf: [
        { not: { required: ["wildcardHostname"] } },
        { properties: { tier: { not: { const: "self-deploying" } } } },
      ],
    });
    const properties = typeof install === "object" ? install.properties : undefined;
    expect(properties?.wildcardHostname).toMatchObject({
      type: "object",
      required: ["reason"],
      properties: { reason: { type: "string", maxLength: WILDCARD_REASON_MAX_LENGTH } },
    });
  });
});

describe("install.emailRouting", () => {
  const withRouting = (emailRouting: unknown) =>
    catalogManifestSchema.safeParse({
      ...validManifest,
      install: { ...validManifest.install, emailRouting },
    });

  it("is optional", () => {
    const parsed = catalogManifestSchema.parse(validManifest);
    expect("emailRouting" in parsed.install).toBe(false);
  });

  it("accepts a catch-all, local parts, and full addresses, with defaults for the other", () => {
    expect(withRouting({ catchAll: true }).data?.install.emailRouting).toEqual({
      catchAll: true,
      rules: [],
    });
    expect(withRouting({ rules: ["inbox"] }).data?.install.emailRouting).toEqual({
      catchAll: false,
      rules: ["inbox"],
    });
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

describe("install.container", () => {
  const withContainer = (container: unknown, tier = "sandbox") =>
    catalogManifestSchema.safeParse({
      ...validManifest,
      plan: "paid",
      install: { ...validManifest.install, tier, container },
    });

  it("is optional, and the defaults apply when it is omitted", () => {
    const parsed = catalogManifestSchema.parse({
      ...validManifest,
      install: { ...validManifest.install, tier: "sandbox" },
    });
    expect("container" in parsed.install).toBe(false);
    expect(sandboxBuildSettings(parsed.install)).toEqual({
      expectedMinutes: DEFAULT_EXPECTED_BUILD_MINUTES,
      instanceType: DEFAULT_SANDBOX_INSTANCE_TYPE,
    });
  });

  it("takes expected minutes and a container size, each defaulted", () => {
    const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{}, { expectedMinutes: 10, instanceType: "standard-1" }],
      [{ expectedMinutes: 1 }, { expectedMinutes: 1, instanceType: "standard-1" }],
      [{ expectedMinutes: 120 }, { expectedMinutes: 120, instanceType: "standard-1" }],
      [{ instanceType: "standard-2" }, { expectedMinutes: 10, instanceType: "standard-2" }],
    ];
    for (const [container, parsed] of cases) {
      const result = withContainer(container);
      expect(result.success, JSON.stringify(container)).toBe(true);
      expect(result.data?.install.container).toEqual(parsed);
    }
  });

  it("refuses minutes that are not a whole number from 1 to 120, and unknown sizes", () => {
    for (const container of [
      { expectedMinutes: 0 },
      { expectedMinutes: -5 },
      { expectedMinutes: 2.5 },
      { expectedMinutes: 121 },
      { expectedMinutes: "10" },
      { instanceType: "basic" },
      { instanceType: "standard-4" },
    ]) {
      expect(withContainer(container).success, JSON.stringify(container)).toBe(false);
    }
  });

  it("is taken on self-deploying entries, whose installer runs in the sandbox Worker", () => {
    const parsed = catalogManifestSchema.safeParse({
      ...validManifest,
      plan: "paid",
      install: {
        ...validManifest.install,
        ...selfDeployingInstall,
        container: { expectedMinutes: 15, instanceType: "standard-2" },
      },
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.data && sandboxBuildSettings(parsed.data.install)).toEqual({
      expectedMinutes: 15,
      instanceType: "standard-2",
    });
  });

  it("is refused on artifact entries, which never run in the user's account", () => {
    const result = withContainer({ expectedMinutes: 10 }, "artifact");
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ["install", "container"],
        message:
          "install.container is only for the sandbox and self-deploying tiers, which run in the sandbox Worker; this entry's tier is artifact",
      }),
    ]);
    // The tier defaults to artifact.
    const defaulted = catalogManifestSchema.safeParse({
      ...validManifest,
      install: { ...validManifest.install, container: {} },
    });
    expect(defaulted.success).toBe(false);
  });

  it("names the tiers that run in the sandbox Worker", () => {
    expect(SANDBOX_RUN_TIERS).toEqual(["sandbox", "self-deploying"]);
    expect(installTierSchema.options.filter(runsInSandbox)).toEqual(["sandbox", "self-deploying"]);
  });

  it("states the tier rules in the JSON Schema, so editors refuse the same manifests", () => {
    const install = z.toJSONSchema(catalogManifestSchema).properties?.install;
    expect(install).toMatchObject({
      allOf: [
        {
          anyOf: [
            { not: { required: ["container"] } },
            { required: ["tier"], properties: { tier: { enum: ["sandbox", "self-deploying"] } } },
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
        // An inline wrangler config beside neither several Workers nor a config patch,
        // nor on a self-deploying entry.
        {
          anyOf: [
            { not: { required: ["wranglerConfigInline"] } },
            {
              not: { anyOf: [{ required: ["workers"] }, { required: ["configPatch"] }] },
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
        // The wildcard hostname rule (see the install.wildcardHostname tests).
        expect.anything(),
        // No build-time constants on a self-deploying entry.
        {
          anyOf: [
            { not: { required: ["buildEnv"] } },
            { properties: { tier: { not: { const: "self-deploying" } } } },
          ],
        },
      ],
      properties: {
        container: {
          additionalProperties: false,
          properties: {
            expectedMinutes: { type: "integer", minimum: 1, maximum: 120 },
            instanceType: { enum: ["standard-1", "standard-2"] },
          },
        },
      },
    });
    const container = typeof install === "object" ? install.properties?.container : undefined;
    expect(typeof container === "object" && container.description).toContain("cost");
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

describe("placeholders in a manifest", () => {
  const withTexts = (content: string, varDefault: string, install: Record<string, unknown> = {}) =>
    catalogManifestSchema.safeParse({
      ...validManifest,
      install: { ...validManifest.install, ...install },
      postInstall: [{ type: "markdown", content }],
      vars: [{ name: "BASE_URL", label: "Address", default: varDefault }],
    });

  it("accept every address form in post-install notes and var defaults", () => {
    const result = withTexts(
      "Open {{appUrl}} ({{ appHostname }}) or {{workerUrl}} on {{workerHostname}}.",
      "{{appUrl}}/api?account={{accountId}}&host={{wildcardHostname}}&w={{workerName}}",
    );
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it("refuse {{stage}}, a known name in the wrong case, and per-Worker forms on one Worker", () => {
    const cases: Array<[string, string, string]> = [
      ["{{stage}}", "x", "is not filled in here"],
      ["x", "{{appURL}}", "write {{appUrl}}"],
      ["{{workerUrl:api}}", "x", "installs one Worker"],
    ];
    for (const [content, varDefault, why] of cases) {
      const result = withTexts(content, varDefault);
      expect(result.success, why).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toContain(why);
    }
  });

  it("leave other double-brace text alone, for apps that use the syntax themselves", () => {
    expect(withTexts("Hello {{name}}", "{{ user.name }}").success).toBe(true);
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

describe("secrets[].generate", () => {
  const withGenerate = (generate: unknown) =>
    catalogManifestSchema.safeParse({
      ...validManifest,
      secrets: [{ name: "KEY", label: "Key", generate }],
    });

  it("names the kind of value to generate", () => {
    expect(SECRET_GENERATE_KINDS).toEqual(["password", "vapid-private-key", "base64-key-32"]);
    for (const generate of SECRET_GENERATE_KINDS) {
      expect(withGenerate(generate).data?.secrets[0]?.generate).toBe(generate);
    }
  });

  it("refuses a boolean", () => {
    for (const generate of [true, false, "rsa-key"]) {
      expect(withGenerate(generate).success, String(generate)).toBe(false);
    }
  });
});

describe("secrets[].optional", () => {
  const withSecret = (secret: Record<string, unknown>, install: Record<string, unknown> = {}) =>
    catalogManifestSchema.safeParse({
      ...validManifest,
      plan: install.tier === "self-deploying" ? "paid" : validManifest.plan,
      install: { ...validManifest.install, ...install },
      secrets: [{ name: "SMTP_PASSWORD", label: "SMTP password", ...secret }],
    });

  it("is false by default", () => {
    const parsed = catalogManifestSchema.parse(validManifest);
    expect(parsed.secrets[0]?.optional).toBe(false);
    expect(isOptionalSecret(parsed.secrets[0] ?? {})).toBe(false);
  });

  it("marks a secret the app works without", () => {
    const parsed = withSecret({ optional: true });
    expect(parsed.success).toBe(true);
    expect(isOptionalSecret(parsed.data?.secrets[0] ?? {})).toBe(true);
    expect(withSecret({ optional: "yes" }).success).toBe(false);
  });

  it("is refused on self-deploying entries, whose installer expects every secret", () => {
    const refused = withSecret({ optional: true }, selfDeployingInstall);
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.path).toEqual(["secrets", 0, "optional"]);
    expect(withSecret({ optional: false }, selfDeployingInstall).success).toBe(true);
    expect(withSecret({}, selfDeployingInstall).success).toBe(true);
  });

  it("states the self-deploying rule in the JSON Schema", () => {
    const schema = z.toJSONSchema(catalogManifestSchema);
    expect(JSON.stringify(schema.allOf)).toContain('"optional":{"const":true}');
    const secrets = schema.properties?.secrets;
    const items = typeof secrets === "object" ? secrets.items : undefined;
    expect(items).toMatchObject({ properties: { optional: { type: "boolean" } } });
  });
});

describe("secrets[].cloudflareToken", () => {
  const permission = {
    group: "Account Analytics",
    scope: "account",
    access: "read",
    reason: "Reads visits through the Analytics Engine SQL API.",
  };
  const withToken = (secrets: Array<Record<string, unknown>>, tokenPermissions = [permission]) =>
    catalogManifestSchema.safeParse({ ...validManifest, secrets, tokenPermissions });

  it("marks the secret that takes the app's own token", () => {
    const result = withToken([
      { name: "ADMIN_PASSWORD", label: "Admin password", generate: "password" },
      { name: "CF_API_TOKEN", label: "Cloudflare API token", cloudflareToken: true },
    ]);
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    expect(result.data && cloudflareTokenSecret(result.data.secrets)?.name).toBe("CF_API_TOKEN");
    expect(cloudflareTokenSecret(catalogManifestSchema.parse(validManifest).secrets)).toBeNull();
  });

  it("allows one per entry, entered by the admin, with permissions listed", () => {
    const cases: Array<[Array<Record<string, unknown>>, unknown[], string]> = [
      [
        [
          { name: "A", label: "A", cloudflareToken: true },
          { name: "B", label: "B", cloudflareToken: true },
        ],
        [permission],
        "only one secret takes",
      ],
      [
        [{ name: "A", label: "A", cloudflareToken: true, generate: "password" }],
        [permission],
        "cannot be generated, derived or seed-only",
      ],
      [[{ name: "A", label: "A", cloudflareToken: true }], [], "lists no permission"],
    ];
    for (const [secrets, tokenPermissions, why] of cases) {
      const result = withToken(secrets, tokenPermissions as (typeof permission)[]);
      expect(result.success, why).toBe(false);
      expect(JSON.stringify(result.error?.issues), why).toContain(why);
    }
  });

  it("counts a Pipelines sink's token permissions as listed", () => {
    expect(
      cloudflareTokenProblems({
        secrets: [{ name: "R2_TOKEN", cloudflareToken: true }],
        tokenPermissions: [],
        resources: {
          pipelines: {
            EVENTS: {
              stream: { fields: [{ name: "at", type: "timestamp" }] },
              sink: {
                type: "r2-data-catalog",
                bucket: "events",
                namespace: "default",
                table: "events",
                tokenSecret: "R2_TOKEN",
              },
            },
          },
        },
      } as unknown as Parameters<typeof cloudflareTokenProblems>[0]),
    ).toEqual([]);
  });
});

describe("vars[].optional", () => {
  it("is false by default and replaces required", () => {
    const parsed = catalogManifestSchema.parse({
      ...validManifest,
      vars: [
        { name: "A", label: "A" },
        { name: "B", label: "B", optional: true },
      ],
    });
    expect(parsed.vars.map((v) => v.optional)).toEqual([false, true]);
    expect(parsed.vars[0]).toEqual({
      name: "A",
      label: "A",
      optional: false,
      type: "text",
      seedOnly: false,
    });
  });

  it("ignores the removed required field outside the strict schema, and the strict one refuses it", () => {
    const manifest = { ...validManifest, vars: [{ name: "A", label: "A", required: true }] };
    expect(catalogManifestSchema.safeParse(manifest).success).toBe(true);
    const strict = strictCatalogManifestSchema.safeParse(manifest);
    expect(strict.success).toBe(false);
    expect(strict.error?.issues[0]?.path).toEqual(["vars", 0, "required"]);
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

  it("is text by default", () => {
    const parsed = withVar({});
    expect(parsed.success).toBe(true);
    expect(parsed.data?.vars[0]?.type).toBe("text");
    expect(catalogVarOptions(parsed.data?.vars[0] ?? { type: "text" })).toBeNull();
  });

  it("takes options and a default that is one of them", () => {
    const parsed = withVar({ type: "select", options, default: "404" });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(catalogVarOptions(parsed.data?.vars[0] ?? { type: "text" })).toEqual(options);
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
        // A derived var has no default or options, is not a select, and is not optional.
        {
          anyOf: [
            { not: { required: ["derive"] } },
            {
              properties: {
                type: { not: { const: "select" } },
                optional: { not: { const: true } },
              },
            },
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
      { name: "CF_JWT_SECRET", label: "Session key", generate: "password" },
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
          { name: "H", label: "H", generate: "password", derive: { from: "P", method: "bcrypt" } },
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
        { name: "P" },
        { name: "H", derive: { from: "Q", method: "bcrypt" } },
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
      install: { ...validManifest.install, ...selfDeployingInstall },
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
        { secrets: [{ name: "K", label: "K", generate: "password" }], vars: [derived("K")] },
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
      [{ vars: [derived("VAPID_PRIVATE_KEY", { optional: true })] }, "cannot be optional"],
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
        "cannot also be a select",
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
        [{ name: "K", generate: "password" }],
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
    expect(secretValueProblem({ name: "P", label: "P", generate: "password" }, "x")).toBeNull();
  });

  it("state the derived var rules in the JSON Schema", () => {
    const text = JSON.stringify(z.toJSONSchema(catalogManifestSchema));
    expect(text).toContain('"vapid-private-key"');
    expect(text).toContain('"vapid-public-key"');
    expect(text).toContain('"vars":{"items":{"not":{"anyOf":[{"required":["derive"]}');
  });

  it("are refused on self-deploying entries as derived vars", () => {
    const result = catalogManifestSchema.safeParse({
      ...push,
      plan: "paid",
      install: { ...validManifest.install, ...selfDeployingInstall },
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
      vars: [{ name: "ADMIN_PASSWORD", label: "Admin password", optional: true }],
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

describe("multiline secrets", () => {
  const pem = { name: "GITHUB_APP_PRIVATE_KEY", label: "GitHub App private key", multiline: true };

  it("parse, false by default", () => {
    const parsed = catalogManifestSchema.parse({
      ...validManifest,
      secrets: [...validManifest.secrets, pem, { ...pem, name: "SPARE_KEY", optional: true }],
    });
    const [first, key, spare] = parsed.secrets;
    expect(first?.multiline).toBe(false);
    expect(key !== undefined && isMultilineSecret(key)).toBe(true);
    expect(spare !== undefined && isOptionalSecret(spare) && isMultilineSecret(spare)).toBe(true);
    expect(isMultilineSecret({})).toBe(false);
  });

  it("refuse generate and derive", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...pem, generate: "password" }, "cannot also be generated"],
      [{ ...pem, generate: "base64-key-32" }, "cannot also be generated"],
      [{ ...pem, derive: { from: "ADMIN_PASSWORD", method: "bcrypt" } }, "cannot be multiline"],
    ];
    for (const [secret, why] of cases) {
      const result = catalogManifestSchema.safeParse({
        ...validManifest,
        secrets: [{ name: "ADMIN_PASSWORD", label: "Admin password" }, secret],
      });
      expect(result.success, why).toBe(false);
      expect(result.error?.issues).toContainEqual(
        expect.objectContaining({ path: ["secrets", 1, "multiline"] }),
      );
      expect(JSON.stringify(result.error?.issues)).toContain(why);
    }
    expect(
      multilineSecretProblems([{ name: "K", generate: "password", multiline: true }, { ...pem }]),
    ).toEqual([
      {
        path: [0, "multiline"],
        message: "K is multiline; it cannot also be generated, since a generated value is one line",
      },
    ]);
  });

  it("state the same rule in the JSON Schema", () => {
    const text = JSON.stringify(z.toJSONSchema(catalogManifestSchema));
    expect(text).toContain(
      '{"anyOf":[{"not":{"required":["multiline"],"properties":{"multiline":{"const":true}}}},{"not":{"anyOf":[{"required":["derive"]},{"required":["generate"]}]}}]}',
    );
  });
});

describe("slug", () => {
  it("takes lowercase letters, digits and dashes, starting with a letter or digit", () => {
    for (const slug of ["cut", "2fa", "open-seo", "a".repeat(63)]) {
      expect(catalogManifestSchema.safeParse({ ...validManifest, slug }).success).toBe(true);
      expect(strictCatalogManifestSchema.safeParse({ ...validManifest, slug }).success).toBe(true);
    }
  });

  it("refuses any other slug in the lenient and the strict schema", () => {
    for (const slug of ["", "My_App", "Cut", "-cut", "cut.app", "a b", "a".repeat(64)]) {
      expect(catalogManifestSchema.safeParse({ ...validManifest, slug }).success).toBe(false);
      expect(strictCatalogManifestSchema.safeParse({ ...validManifest, slug }).success).toBe(false);
    }
  });
});

describe("strictCatalogManifestSchema", () => {
  it("parses what the lenient schema parses, to the same value", () => {
    expect(strictCatalogManifestSchema.parse(validManifest)).toEqual(
      catalogManifestSchema.parse(validManifest),
    );
  });

  it("refuses a misspelled field anywhere, naming its path", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...validManifest, instal: {} }, "instal"],
      [
        { ...validManifest, install: { ...validManifest.install, healthpath: "/" } },
        "install.healthpath",
      ],
      [
        { ...validManifest, secrets: [{ name: "A", label: "A", optinal: true }] },
        "secrets[0].optinal",
      ],
      [
        {
          ...validManifest,
          resources: { vectorize: { V: { dimensions: 3, metric: "cosine", metadata: [] } } },
        },
        "resources.vectorize.V.metadata",
      ],
    ];
    for (const [manifest, path] of cases) {
      expect(catalogManifestSchema.safeParse(manifest).success, path).toBe(true);
      const result = strictCatalogManifestSchema.safeParse(manifest);
      expect(result.success, path).toBe(false);
      expect(result.error?.issues.map((i) => i.message)).toContain(
        `${path} is not a field here; check its spelling`,
      );
    }
  });

  it("reports an unknown key beside the other problems", () => {
    const result = strictCatalogManifestSchema.safeParse({
      ...validManifest,
      plan: "enterprise",
      tagliné: "x",
    });
    expect(result.error?.issues.map((i) => i.path.join("."))).toEqual(
      expect.arrayContaining(["tagliné", "plan"]),
    );
  });

  it("holds the license to the SPDX list, where the lenient schema checks only its shape", () => {
    const cases: Array<[string, boolean, string]> = [
      ["AGPL-3.0", false, "AGPL-3.0-only or AGPL-3.0-or-later"],
      ["NOASSERTION", false, "only an app built from a repository"],
      ["SEE LICENSE IN LICENSE.md", false, "only an app built from a repository"],
      ["Made-Up-1.0", false, "not an id of the SPDX License List"],
      ["LicenseRef-Acme-Source-Available", true, ""],
      ["NONE", true, ""],
      ["MIT OR Apache-2.0", true, ""],
    ];
    for (const [license, ok, why] of cases) {
      expect(catalogManifestSchema.safeParse({ ...validManifest, license }).success, license).toBe(
        true,
      );
      const strict = strictCatalogManifestSchema.safeParse({ ...validManifest, license });
      expect(strict.success, license).toBe(ok);
      if (!ok) expect(JSON.stringify(strict.error?.issues), license).toContain(why);
    }
  });

  it("holds categories to the fixed list, each once", () => {
    const cases: Array<[unknown, number, string]> = [
      [["blogging"], 0, '"blogging" is not a category'],
      [["utilities", "utilities"], 1, 'the category "utilities" is listed twice'],
    ];
    for (const [categories, at, why] of cases) {
      const strict = strictCatalogManifestSchema.safeParse({ ...validManifest, categories });
      expect(strict.success, why).toBe(false);
      expect(strict.error?.issues[0]?.path).toEqual(["categories", at]);
      expect(strict.error?.issues[0]?.message).toContain(why);
    }
  });

  it("holds each token permission group to its scope's list", () => {
    const withGroup = (group: string, scope: string) =>
      strictCatalogManifestSchema.safeParse({
        ...validManifest,
        secrets: [{ name: "CF_API_TOKEN", label: "API token", cloudflareToken: true }],
        tokenPermissions: [{ group, scope, access: "edit", reason: "Needs it." }],
      });
    expect(withGroup("DNS", "zone").success).toBe(true);
    for (const [group, scope, why] of [
      ["Zone.DNS:Edit", "zone", "is not a permission group Appflare can select"],
      ["DNS", "account", "is not a account permission group"],
    ] as const) {
      const result = withGroup(group, scope);
      expect(result.success, group).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(["tokenPermissions", 0, "group"]);
      expect(result.error?.issues[0]?.message).toContain(why);
    }
  });

  it("names where a field of the older shape went", () => {
    const install = validManifest.install;
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [
        { ...validManifest, vars: [{ name: "A", label: "A", required: true }] },
        "vars.0.required",
        'unless it sets "optional": true',
      ],
      [
        { ...validManifest, install: { ...install, healthPath: "/up" } },
        "install.healthPath",
        "is now install.health.path",
      ],
      [
        { ...validManifest, install: { ...install, healthMode: "status-only" } },
        "install.healthMode",
        '"status-only" became "any-response"',
      ],
      [
        {
          ...validManifest,
          install: { ...install, wildcardHostname: { reason: "x" }, wildcardReason: "x" },
        },
        "install.wildcardReason",
        "is now install.wildcardHostname",
      ],
      [
        { ...validManifest, install: { ...install, sandbox: {} } },
        "install.sandbox",
        "is now install.container",
      ],
      [
        { ...validManifest, install: { ...install, version: "1.0.0" } },
        "install.version",
        "is now source.version",
      ],
      [
        {
          ...validManifest,
          resources: { d1: { DB: { migrations: "prisma/migrations/*/migration.sql" } } },
        },
        "resources.d1.DB.migrations",
        "is now migrationsGlob",
      ],
      [
        {
          ...validManifest,
          install: {
            ...install,
            ...selfDeployingInstall,
            selfDeploying: {
              ...selfDeployingInstall.selfDeploying,
              workers: ["x"],
              stateStore: "account",
              stageArg: "--stage",
            },
          },
        },
        "install.selfDeploying.workers",
        "is now install.selfDeploying.workerNames",
      ],
      [
        {
          ...validManifest,
          tokenPermissions: [
            { group: "DNS", scope: "zone", access: "edit", reason: "x", description: "x" },
          ],
        },
        "tokenPermissions.0.description",
        "is now reason",
      ],
      [
        { ...validManifest, tokenPermissions: [{ name: "Zone.DNS:Edit" }] },
        "tokenPermissions.0.name",
        "was replaced by group, scope and access",
      ],
    ];
    for (const [manifest, path, why] of cases) {
      const result = strictCatalogManifestSchema.safeParse(manifest);
      const issue = result.error?.issues.find((i) => i.path.join(".") === path);
      expect(issue?.message, path).toContain(why);
    }
    const selfDeploying = strictCatalogManifestSchema.safeParse(cases[7]?.[0]);
    const messages = selfDeploying.error?.issues.map((i) => i.message) ?? [];
    expect(messages).toContainEqual(expect.stringContaining("stateStore was removed"));
    expect(messages).toContainEqual(expect.stringContaining("stageArg was removed"));
  });
});

describe("strictRepositoryBuildManifestSchema", () => {
  it("also takes NOASSERTION and SEE LICENSE IN, and checks everything else strictly", () => {
    for (const license of ["NOASSERTION", "SEE LICENSE IN LICENSE.md", "MIT"]) {
      expect(
        strictRepositoryBuildManifestSchema.safeParse({ ...validManifest, license }).success,
        license,
      ).toBe(true);
    }
    for (const manifest of [
      { ...validManifest, license: "GPL-3.0" },
      { ...validManifest, categories: ["gardening"] },
      { ...validManifest, instal: {} },
    ]) {
      expect(strictRepositoryBuildManifestSchema.safeParse(manifest).success).toBe(false);
    }
  });
});
