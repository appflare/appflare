import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  catalogManifestSchema,
  requirementSchema,
  strictCatalogManifestSchema,
  WORKERS_FOR_PLATFORMS_REQUIREMENT,
} from "./catalog";
import { indexAppSchema } from "./catalog-index";
import { accountRequirements, isManagerFeatureRequirement } from "./manager-features";
import {
  appSecretSecretName,
  appTokenSecretName,
  SANDBOX_PROTOCOL_VERSION,
  selfManagedOutcomeSchema,
  selfManagedResourceKindSchema,
  selfManagedRunRequestSchema,
} from "./sandbox";
import {
  catalogSelfDeployingSchema,
  fillSelfDeployingCommand,
  MAX_STAGE_LENGTH,
  renderWorkerTemplate,
  SELF_DEPLOYING_TOOLS,
  selfDeployingCommandSchema,
  selfDeployingCommandTemplateSchema,
  selfDeployingStage,
  selfDeployingStageArg,
  selfDeployingStageSchema,
  selfDeployingWorkerTemplateSchema,
} from "./self-deploying";

const PIN = "84e4705503ceaef54d1b284c167de9942563cdae";

const selfDeploying = {
  tool: "alchemy" as const,
  deployCommand: ["pnpm", "alchemy", "deploy", "--yes"],
  destroyCommand: ["pnpm", "alchemy", "destroy", "--yes"],
  workerNames: ["open-seo-{{stage}}", "open-seo-{{stage}}-audit"],
};

const manifest = {
  slug: "open-seo",
  name: "OpenSEO",
  summary: "Self-hosted SEO research.",
  tagline: "An app on Workers",
  homepage: "https://github.com/every-app/open-seo",
  repo: "every-app/open-seo",
  license: "MIT",
  categories: ["marketing"],
  maintainers: ["every-app"],
  source: { ref: "v0.1.9", sha: PIN },
  install: {
    tier: "self-deploying",
    packageManager: "pnpm",
    wranglerConfig: "wrangler.jsonc",
    workerName: "open-seo",
    buildCommand: "pnpm exec vite build --mode selfhost",
    selfDeploying,
  },
  plan: "paid",
  requires: ["r2", "containers"],
  secrets: [{ name: "DATAFORSEO_API_KEY", label: "DataForSEO API key" }],
  vars: [{ name: "ACCESS_ALLOWED_EMAILS", label: "Allowed emails" }],
  postInstall: [],
  tokenPermissions: [
    {
      group: "Workers Scripts",
      scope: "account",
      access: "edit",
      reason: "Deploys the app's Workers.",
    },
  ],
};

function withInstall(install: Record<string, unknown>) {
  return { ...manifest, install: { ...manifest.install, ...install } };
}

describe("install.selfDeploying in the catalog manifest", () => {
  it("accepts a self-deploying entry", () => {
    const parsed = catalogManifestSchema.parse(manifest);
    expect(parsed.install.selfDeploying).toMatchObject({ tool: "alchemy" });
    expect(selfDeployingStageArg(parsed.install.selfDeploying ?? selfDeploying)).toBe("--stage");
  });

  it("is required for the tier and refused for every other tier", () => {
    const { selfDeploying: _omit, ...without } = manifest.install;
    const missing = catalogManifestSchema.safeParse({ ...manifest, install: without });
    expect(missing.success).toBe(false);
    expect(missing.error?.issues[0]?.path).toEqual(["install", "selfDeploying"]);
    for (const tier of ["artifact", "sandbox"]) {
      expect(catalogManifestSchema.safeParse(withInstall({ tier })).success).toBe(false);
    }
  });

  it("refuses install.emailRouting, which only the tiers Appflare deploys itself take", () => {
    const emailRouting = { rules: ["inbox"] };
    const result = catalogManifestSchema.safeParse(withInstall({ emailRouting }));
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ["install", "emailRouting"],
        message:
          "install.emailRouting is not allowed for the self-deploying tier: the app's own installer deploys it, and Appflare sets up no Email Routing for it",
      }),
    ]);
    const { selfDeploying: _omit, ...rest } = manifest.install;
    for (const tier of ["artifact", "sandbox"]) {
      const other = catalogManifestSchema.safeParse({
        ...manifest,
        install: { ...rest, tier, emailRouting },
      });
      expect(other.success, `${tier}: ${JSON.stringify(other.error?.issues)}`).toBe(true);
    }
  });

  it("refuses shell syntax, environment assignments and options first in the commands", () => {
    for (const deployCommand of [
      ["pnpm", "alchemy", "deploy;", "rm"],
      ["CLOUDFLARE_API_TOKEN=x", "alchemy"],
      ["--yes"],
      [],
      ["pnpm", "$(whoami)"],
    ]) {
      expect(
        catalogManifestSchema.safeParse(
          withInstall({ selfDeploying: { ...selfDeploying, deployCommand } }),
        ).success,
      ).toBe(false);
    }
  });

  it("requires exactly one {{stage}} in each Worker template, and a Worker name once filled in", () => {
    for (const workerNames of [
      ["open-seo"],
      ["Open-Seo-{{stage}}"],
      ["open-seo-{{stage}}-{{stage}}"],
      [`${"a".repeat(40)}-{{stage}}`],
      [],
    ]) {
      expect(
        catalogManifestSchema.safeParse(
          withInstall({ selfDeploying: { ...selfDeploying, workerNames } }),
        ).success,
      ).toBe(false);
    }
  });

  it("accepts only known tools, whose own stage option the sandbox Worker appends", () => {
    for (const block of [
      { ...selfDeploying, tool: "terraform" },
      // The sandbox Worker appends the stage; the entry may not name one.
      { ...selfDeploying, deployCommand: ["pnpm", "alchemy", "deploy", "--stage=prod"] },
      { ...selfDeploying, destroyCommand: ["pnpm", "alchemy", "destroy", "--stage", "prod"] },
    ]) {
      expect(catalogManifestSchema.safeParse(withInstall({ selfDeploying: block })).success).toBe(
        false,
      );
    }
  });
});

describe("stages", () => {
  it("derives a stage from the install id that fits Alchemy and Worker names", () => {
    const stage = selfDeployingStage("01J8Z3Q4R5S6T7V8W9X0YZABCD");
    expect(stage).toBe("appflare-x0yzabcd");
    expect(selfDeployingStageSchema.safeParse(stage).success).toBe(true);
    expect(renderWorkerTemplate("open-seo-{{stage}}-audit", stage)).toBe(
      "open-seo-appflare-x0yzabcd-audit",
    );
  });

  it("refuses stages that are not lowercase labels", () => {
    for (const stage of ["", "-a", "a-", "A", "a_b", "a".repeat(25)]) {
      expect(selfDeployingStageSchema.safeParse(stage).success).toBe(false);
    }
  });

  it("refuses repeated dashes, which Void would fold into one", () => {
    for (const stage of ["a--b", "appflare--x", "a---b"]) {
      expect(selfDeployingStageSchema.safeParse(stage).success, stage).toBe(false);
    }
    expect(selfDeployingStageSchema.safeParse("a-b-c").success).toBe(true);
  });
});

describe("the index entry of a self-deploying app", () => {
  const entry = {
    slug: "open-seo",
    name: "OpenSEO",
    summary: "Self-hosted SEO research.",
    tagline: "An app on Workers",
    version: "0.1.9",
    tier: "self-deploying",
    plan: "paid",
    requires: [],
    lastVerified: null,
    maintainers: ["every-app"],
    addedAt: "2026-09-21T10:00:00Z",
    license: "MIT",
    revision: 1,
    services: [],
    authors: [{ name: "every-app", github: "every-app" }],
    categories: ["marketing"],
    build: {
      pin: PIN,
      manifest: "https://appflare.github.io/catalog/apps/open-seo/appflare.json",
      manifestDigest: "a".repeat(64),
      expectedMinutes: 12,
    },
  };

  it("carries a build block instead of artifacts", () => {
    expect(indexAppSchema.parse(entry).build?.pin).toBe(PIN);
    const { build: _b, ...without } = entry;
    expect(indexAppSchema.safeParse(without).success).toBe(false);
  });
});

describe("self-deploying runs in the sandbox protocol", () => {
  const request = {
    protocol: SANDBOX_PROTOCOL_VERSION,
    installId: "01J8Z3Q4R5S6T7V8W9X0YZABCD",
    runId: "deploy-0.1.9",
    accountId: "0123456789abcdef0123456789abcdef",
    tool: "alchemy",
    repo: "every-app/open-seo",
    sha: PIN,
    ref: "v0.1.9",
    packageManager: "pnpm",
    buildCommand: ["pnpm", "exec", "vite", "build", "--mode", "selfhost"],
    command: selfDeploying.deployCommand,
    stage: "appflare-x0yzabcd",
    stageArg: "--stage",
    tokenEnv: [...SELF_DEPLOYING_TOOLS.alchemy.tokenEnv],
    accountIdEnv: [...SELF_DEPLOYING_TOOLS.alchemy.accountIdEnv],
    vars: { ACCESS_ALLOWED_EMAILS: "a@example.com" },
    secretNames: ["DATAFORSEO_API_KEY"],
    expectedWorkers: ["open-seo-appflare-x0yzabcd", "open-seo-appflare-x0yzabcd-audit"],
  };

  it("accepts a deploy request and names the secrets it reads the token from", () => {
    expect(selfManagedRunRequestSchema.parse(request).stage).toBe("appflare-x0yzabcd");
    expect(appTokenSecretName(request.installId)).toBe("APP_TOKEN_01J8Z3Q4R5S6T7V8W9X0YZABCD");
    expect(appSecretSecretName(request.installId, "DATAFORSEO_API_KEY")).toBe(
      "APP_SECRET_01J8Z3Q4R5S6T7V8W9X0YZABCD_DATAFORSEO_API_KEY",
    );
  });

  it("takes one build argv, or a list of them run in order", () => {
    const several = [
      ["pnpm", "run", "build:sphere"],
      ["pnpm", "run", "build"],
    ];
    expect(
      selfManagedRunRequestSchema.parse({ ...request, buildCommand: several }).buildCommand,
    ).toEqual(several);
    for (const buildCommand of [[], [[]], [["pnpm", "build;rm"]], [["CI=1", "pnpm", "build"]]]) {
      expect(selfManagedRunRequestSchema.safeParse({ ...request, buildCommand }).success).toBe(
        false,
      );
    }
  });

  it("refuses install ids that could not name a secret", () => {
    expect(
      selfManagedRunRequestSchema.safeParse({ ...request, installId: "01J8-INSTALL" }).success,
    ).toBe(false);
  });

  it("refuses environment names that collide or reconfigure the container", () => {
    for (const over of [
      { vars: { CLOUDFLARE_API_TOKEN: "x" } },
      { vars: { PATH: "/tmp" } },
      { vars: { NODE_OPTIONS: "--require=/tmp/x.js" } },
      { secretNames: ["npm_config_registry"] },
      { secretNames: ["ACCESS_ALLOWED_EMAILS"] },
      { accountIdEnv: ["CLOUDFLARE_API_TOKEN"] },
      { vars: { BASH_ENV: "/tmp/x" } },
      { vars: { ENV: "/tmp/x" } },
      { vars: { CLOUDFLARE_EMAIL: "a@example.com" } },
      { secretNames: ["ALCHEMY_PROFILE"] },
    ]) {
      expect(selfManagedRunRequestSchema.safeParse({ ...request, ...over }).success).toBe(false);
    }
  });

  it("refuses a command that names the stage itself", () => {
    expect(
      selfManagedRunRequestSchema.safeParse({
        ...request,
        command: ["pnpm", "alchemy", "deploy", "--stage", "prod"],
      }).success,
    ).toBe(false);
    expect(
      selfManagedRunRequestSchema.safeParse({
        ...request,
        command: ["pnpm", "alchemy", "deploy", "--stage=prod"],
      }).success,
    ).toBe(false);
  });

  it("parses each kind of outcome", () => {
    const base = { protocol: 1, sandboxVersion: "0.4.0", minutes: 4.5, logKey: null, log: "" };
    expect(
      selfManagedOutcomeSchema.parse({
        ok: true,
        action: "deploy",
        ...base,
        image: "docker.io/mendylanda/appflare-sandbox:0.4.0",
        installId: request.installId,
        workers: [{ name: request.expectedWorkers[0], url: "https://x.example.workers.dev" }],
        resources: [
          {
            kind: "d1",
            name: "open-seo-db-appflare-x0yzabcd",
            cfId: "uuid",
            worker: request.expectedWorkers[0],
            binding: "DB",
          },
        ],
      }).ok,
    ).toBe(true);
    expect(
      selfManagedOutcomeSchema.parse({
        ok: false,
        action: "destroy",
        ...base,
        step: "token",
        message: "no token",
        retryable: false,
        exitCode: null,
      }).ok,
    ).toBe(false);
  });
});

// The Void Platform, installed with the Void CLI's own `void platform` commands.
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const VOID = ["pnpm", "exec", "void", "platform"];
const voidInstall = [
  ...VOID,
  "install",
  "--yes",
  "--name",
  "{{stage}}",
  "--display-name",
  "Void",
  "--account",
  "{{accountId}}",
  "--workers-dev",
];
const voidBlock = {
  tool: "void" as const,
  discoverCommand: [
    ...VOID,
    "discover",
    "--account",
    "{{accountId}}",
    "--installation",
    "{{stage}}",
  ],
  installCommand: voidInstall,
  resumeCommand: [...voidInstall, "--resume"],
  updateCommand: [...VOID, "upgrade", "{{stage}}", "--yes"],
  destroyCommand: [...VOID, "uninstall", "{{stage}}", "--purge-resources", "--yes"],
  workerNames: [
    "void-{{stage}}-api",
    "void-{{stage}}-proxy",
    "void-{{stage}}-tail",
    "void-{{stage}}-dispatch",
  ],
};

const voidPermission = (group: string, access: "read" | "edit", scope = "account") => ({
  group,
  scope,
  access,
  reason: "The Void CLI needs it.",
});

const voidManifest = {
  slug: "void",
  name: "Void",
  summary: "A platform for deploying apps.",
  tagline: "Your own app platform",
  repo: "appflare/void-installer",
  license: "MIT",
  categories: ["developer-tools"],
  maintainers: ["appflare"],
  source: { ref: "main", sha: PIN },
  install: {
    tier: "self-deploying",
    packageManager: "pnpm",
    workerName: "void",
    selfDeploying: voidBlock,
  },
  plan: "paid",
  requires: ["r2", "containers", "analytics-engine", "workers-for-platforms"],
  secrets: [
    { name: "VOID_PLATFORM_JWT_SECRET", label: "JWT secret", generate: "base64-key-32" },
    {
      name: "VOID_PLATFORM_PROJECT_SECRET_KEY",
      label: "Project secret key",
      generate: "base64-key-32",
    },
    { name: "VOID_PLATFORM_RECOVERY_KEY", label: "Recovery key", generate: "base64-key-32" },
    { name: "VOID_PLATFORM_DATABASE_URL", label: "Postgres connection string" },
    { name: "VOID_PLATFORM_GITHUB_CLIENT_SECRET", label: "GitHub OAuth client secret" },
  ],
  vars: [
    { name: "VOID_PLATFORM_GITHUB_CLIENT_ID", label: "GitHub OAuth client id" },
    { name: "VOID_PLATFORM_ADMIN_GITHUB_LOGIN", label: "Admin GitHub login" },
  ],
  postInstall: [],
  tokenPermissions: [
    voidPermission("Account Settings", "read"),
    voidPermission("Workers Scripts", "edit"),
    voidPermission("Workers Tail", "read"),
    voidPermission("D1", "edit"),
    voidPermission("Workers KV Storage", "edit"),
    voidPermission("Workers R2 Storage", "edit"),
    voidPermission("Queues", "edit"),
    voidPermission("Hyperdrive", "edit"),
    voidPermission("Account Analytics", "read"),
    voidPermission("AI Gateway", "edit"),
    voidPermission("Workers Containers", "edit"),
    voidPermission("Cloudchamber", "edit"),
    voidPermission("Cache Purge", "edit", "zone"),
  ],
};

function withVoid(block: Record<string, unknown>) {
  return {
    ...voidManifest,
    install: { ...voidManifest.install, selfDeploying: { ...voidBlock, ...block } },
  };
}

function issuesOf(result: { error?: z.ZodError | undefined }) {
  return (result.error?.issues ?? []).map((i) => ({ path: i.path, message: i.message }));
}

describe("a void self-deploying entry", () => {
  it("accepts the Void Platform's entry as written, with the CLI's own commands", () => {
    const parsed = strictCatalogManifestSchema.safeParse(voidManifest);
    expect(issuesOf(parsed)).toEqual([]);
    const block = parsed.data?.install.selfDeploying;
    expect(block?.tool).toBe("void");
    if (block?.tool === "void") {
      expect(block.installCommand).toEqual(voidInstall);
      expect(block.resumeCommand.at(-1)).toBe("--resume");
    }
  });

  it("uses the tool's conventions: two token variables, no appended stage option", () => {
    expect(SELF_DEPLOYING_TOOLS.void).toEqual({
      label: "Void",
      tokenEnv: ["CLOUDFLARE_API_TOKEN", "VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN"],
      accountIdEnv: ["CLOUDFLARE_ACCOUNT_ID"],
      stageArg: null,
    });
    expect(selfDeployingStageArg({ tool: "void" })).toBeNull();
    expect(selfDeployingStageArg({ tool: "alchemy" })).toBe("--stage");
  });

  it("requires every one of its five commands", () => {
    for (const key of [
      "discoverCommand",
      "installCommand",
      "resumeCommand",
      "updateCommand",
      "destroyCommand",
    ]) {
      const { [key as keyof typeof voidBlock]: _omit, ...rest } = voidBlock;
      const result = catalogManifestSchema.safeParse({
        ...voidManifest,
        install: { ...voidManifest.install, selfDeploying: rest },
      });
      expect(result.success, key).toBe(false);
      expect(result.error?.issues[0]?.path, key).toEqual(["install", "selfDeploying", key]);
    }
  });

  it("refuses alchemy's deploy command, and alchemy entries refuse void's commands", () => {
    const onVoid = strictCatalogManifestSchema.safeParse(
      withVoid({ deployCommand: ["pnpm", "alchemy", "deploy"] }),
    );
    expect(issuesOf(onVoid)).toEqual([
      {
        path: ["install", "selfDeploying", "deployCommand"],
        message:
          'install.selfDeploying.deployCommand is only for tool "alchemy"; a void entry lists discoverCommand, installCommand, resumeCommand, updateCommand and destroyCommand',
      },
    ]);
    const onAlchemy = strictCatalogManifestSchema.safeParse(
      withInstall({ selfDeploying: { ...selfDeploying, installCommand: voidInstall } }),
    );
    expect(issuesOf(onAlchemy)).toEqual([
      {
        path: ["install", "selfDeploying", "installCommand"],
        message:
          'install.selfDeploying.installCommand is only for tool "void"; an alchemy entry lists deployCommand and destroyCommand',
      },
    ]);
    // A manager reads either leniently: the other tool's field is dropped.
    const lenient = catalogManifestSchema.parse(
      withInstall({ selfDeploying: { ...selfDeploying, installCommand: voidInstall } }),
    );
    expect(lenient.install.selfDeploying).not.toHaveProperty("installCommand");
    // A void block without the void commands is not an alchemy block either.
    expect(
      catalogManifestSchema.safeParse(
        withVoid({
          discoverCommand: undefined,
          installCommand: undefined,
          resumeCommand: undefined,
          updateCommand: undefined,
          deployCommand: ["pnpm", "alchemy", "deploy"],
        }),
      ).success,
    ).toBe(false);
  });

  it("needs {{stage}} in every command, since nothing is appended", () => {
    const result = catalogManifestSchema.safeParse(
      withVoid({ updateCommand: [...VOID, "upgrade", "prod", "--yes"] }),
    );
    expect(issuesOf(result)).toEqual([
      {
        path: ["install", "selfDeploying", "updateCommand"],
        message: "must name the installation with {{stage}}; nothing is appended to a void command",
      },
    ]);
  });

  it('must list "workers-for-platforms" in requires', () => {
    const result = catalogManifestSchema.safeParse({
      ...voidManifest,
      requires: ["r2", "containers", "analytics-engine"],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path)).toEqual([["requires"]]);
    expect(result.error?.issues[0]?.message).toContain('"workers-for-platforms"');
    // An alchemy entry may list it or not.
    for (const requires of [[], [WORKERS_FOR_PLATFORMS_REQUIREMENT]]) {
      expect(catalogManifestSchema.safeParse({ ...manifest, requires }).success).toBe(true);
    }
  });

  it("refuses a secret or var under a name the sandbox Worker hands the token or account in", () => {
    for (const name of [
      "VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_ACCOUNT_ID",
    ]) {
      const secret = catalogManifestSchema.safeParse({
        ...voidManifest,
        secrets: [...voidManifest.secrets, { name, label: "Token" }],
      });
      expect(
        issuesOf(secret).map((i) => i.path),
        name,
      ).toEqual([["secrets", 5, "name"]]);
      const variable = catalogManifestSchema.safeParse({
        ...voidManifest,
        vars: [{ name, label: "Token" }],
      });
      expect(
        issuesOf(variable).map((i) => i.path),
        name,
      ).toEqual([["vars", 0, "name"]]);
    }
  });

  it("keeps the alchemy commands free of placeholders, as before", () => {
    const result = catalogManifestSchema.safeParse(
      withInstall({
        selfDeploying: {
          ...selfDeploying,
          deployCommand: ["pnpm", "alchemy", "deploy", "{{stage}}"],
        },
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["install", "selfDeploying", "deployCommand", 3]);
  });

  it("states the tool's fields and the requirement in the JSON Schema", () => {
    const schema = z.toJSONSchema(catalogSelfDeployingSchema) as {
      oneOf: Array<{
        properties: Record<string, { const?: string }>;
        required: string[];
        additionalProperties: boolean;
      }>;
    };
    const [alchemy, voidOption] = schema.oneOf;
    expect(alchemy?.properties.tool?.const).toBe("alchemy");
    expect(alchemy?.required.sort()).toEqual(
      ["deployCommand", "destroyCommand", "tool", "workerNames"].sort(),
    );
    expect(voidOption?.properties.tool?.const).toBe("void");
    expect(voidOption?.required.sort()).toEqual(
      [
        "destroyCommand",
        "discoverCommand",
        "installCommand",
        "resumeCommand",
        "tool",
        "updateCommand",
        "workerNames",
      ].sort(),
    );
    expect(alchemy?.additionalProperties).toBe(false);
    expect(voidOption?.additionalProperties).toBe(false);
    const manifestSchema = JSON.stringify(z.toJSONSchema(catalogManifestSchema));
    expect(manifestSchema).toContain('"contains":{"const":"workers-for-platforms"}');
  });
});

describe("what a self-deploying entry leaves out", () => {
  it("needs no wrangler config, whichever its tool, as no build reads one", () => {
    expect(issuesOf(strictCatalogManifestSchema.safeParse(voidManifest))).toEqual([]);
    expect(voidManifest.install).not.toHaveProperty("wranglerConfig");
    const { wranglerConfig: _omit, ...alchemyInstall } = manifest.install;
    expect(
      issuesOf(strictCatalogManifestSchema.safeParse({ ...manifest, install: alchemyInstall })),
    ).toEqual([]);
    // Written anyway, it is still taken.
    expect(catalogManifestSchema.parse(manifest).install.wranglerConfig).toBe("wrangler.jsonc");
  });

  it("is still required on the tiers whose build reads it", () => {
    const { selfDeploying: _block, wranglerConfig: _config, ...rest } = manifest.install;
    for (const tier of ["artifact", "sandbox"]) {
      const result = catalogManifestSchema.safeParse({
        ...manifest,
        plan: "paid",
        requires: [],
        install: { ...rest, buildCommand: undefined, tier },
      });
      expect(
        issuesOf(result).filter((i) => i.path.join(".") === "install.wranglerConfig"),
        tier,
      ).toEqual([
        {
          path: ["install", "wranglerConfig"],
          message: `install.wranglerConfig is required for the ${tier} tier, whose build reads it; only a self-deploying entry, whose own installer deploys the app, may leave it out`,
        },
      ]);
    }
  });

  it("says so in the JSON Schema: required unless the tier is self-deploying", () => {
    const install = (
      z.toJSONSchema(catalogManifestSchema) as unknown as {
        properties: { install: { required?: string[]; allOf?: unknown[] } };
      }
    ).properties.install;
    expect(install.required).not.toContain("wranglerConfig");
    expect(install.allOf).toContainEqual({
      anyOf: [
        { required: ["wranglerConfig"] },
        { required: ["tier"], properties: { tier: { const: "self-deploying" } } },
      ],
    });
  });
});

describe("help and notes of a self-deploying entry", () => {
  const callback = "https://void-{{stage}}-api.{{workersDevSubdomain}}.workers.dev/auth/callback";

  it("may name the install's stage and the account's workers.dev subdomain", () => {
    const withCallback = {
      ...voidManifest,
      vars: voidManifest.vars.map((v) =>
        v.name === "VOID_PLATFORM_GITHUB_CLIENT_ID"
          ? { ...v, help: `Create a GitHub OAuth app whose callback URL is ${callback}.` }
          : v,
      ),
      secrets: voidManifest.secrets.map((s) =>
        s.name === "VOID_PLATFORM_GITHUB_CLIENT_SECRET"
          ? { ...s, help: `The secret of the OAuth app with the callback ${callback}.` }
          : s,
      ),
      postInstall: [
        {
          type: "markdown",
          content: `Sign in at https://void-{{stage}}-api.{{workersDevSubdomain}}.workers.dev.`,
        },
      ],
    };
    expect(issuesOf(strictCatalogManifestSchema.safeParse(withCallback))).toEqual([]);
  });

  it("refuses them in other entries, and other placeholders in help", () => {
    const artifact = {
      ...manifest,
      install: { tier: "artifact", packageManager: "pnpm", wranglerConfig: "wrangler.jsonc" },
      plan: "free",
      requires: [],
      vars: [{ name: "X", label: "X", help: `Callback: ${callback}` }],
      postInstall: [{ type: "markdown", content: "Stage {{stage}}." }],
    };
    expect(issuesOf(catalogManifestSchema.safeParse(artifact))).toEqual([
      {
        path: ["vars", 0, "help"],
        message:
          "{{stage}} is filled in only for a self-deploying entry, whose installer names its Workers after the install's stage",
      },
      {
        path: ["vars", 0, "help"],
        message:
          "{{workersDevSubdomain}} is filled in only for a self-deploying entry, whose installer names its Workers after the install's stage",
      },
      {
        path: ["postInstall", 0, "content"],
        message:
          "{{stage}} is filled in only for a self-deploying entry, whose installer names its Workers after the install's stage",
      },
    ]);
    const appUrlInHelp = {
      ...voidManifest,
      secrets: [{ name: "S", label: "S", help: "Opens at {{appUrl}}." }],
    };
    expect(issuesOf(catalogManifestSchema.safeParse(appUrlInHelp))).toEqual([
      {
        path: ["secrets", 0, "help"],
        message:
          "{{appUrl}} is not filled in here; this field takes {{stage}}, {{workersDevSubdomain}}",
      },
    ]);
  });
});

describe("command templates", () => {
  const values = { stage: "appflare-x0yzabcd", accountId: ACCOUNT_ID };

  it("takes {{stage}} and {{accountId}} as a word or inside one, and nothing else in braces", () => {
    for (const word of ["{{stage}}", "--name={{stage}}", "void-{{stage}}", "{{accountId}}"]) {
      expect(selfDeployingCommandTemplateSchema.safeParse(["void", word]).success, word).toBe(true);
    }
    for (const word of [
      "{{ stage }}",
      "{{Stage}}",
      "{{appUrl}}",
      "{{workerName}}",
      "{stage}",
      "{{stage}",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell expansion, which a word must refuse
      "${stage}",
      "{{stage}};rm",
    ]) {
      expect(selfDeployingCommandTemplateSchema.safeParse(["void", word]).success, word).toBe(
        false,
      );
    }
  });

  it("starts with a program written out, never a placeholder or an option", () => {
    for (const argv of [["{{stage}}"], ["{{accountId}}", "x"], ["--yes"], []]) {
      expect(selfDeployingCommandTemplateSchema.safeParse(argv).success).toBe(false);
    }
  });

  it("refuses an environment assignment a placeholder would start", () => {
    expect(selfDeployingCommandTemplateSchema.safeParse(["void", "{{stage}}=1"]).success).toBe(
      false,
    );
    expect(selfDeployingCommandTemplateSchema.safeParse(["void", "{{accountId}}=1"]).success).toBe(
      false,
    );
  });

  it("counts the 256 characters once the longest stage and an account id are filled in", () => {
    // 8 words, joined: the template is 7 shorter than the limit, but each
    // {{stage}} grows by 15 characters filled in.
    const filler = "a".repeat(256 - 7 - "void {{stage}}".length - 1);
    const template = ["void", "{{stage}}", filler];
    expect(template.join(" ").length).toBeLessThan(256);
    const result = selfDeployingCommandTemplateSchema.safeParse(template);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      "must be at most 256 characters in total once {{stage}} and {{accountId}} are filled in",
    );
    expect(
      selfDeployingCommandTemplateSchema.safeParse(["void", "{{stage}}", filler.slice(15)]).success,
    ).toBe(true);
  });

  it("fits every void command within the word and length limits, filled in", () => {
    const longest = { stage: "a".repeat(MAX_STAGE_LENGTH), accountId: ACCOUNT_ID };
    for (const key of [
      "discoverCommand",
      "installCommand",
      "resumeCommand",
      "updateCommand",
      "destroyCommand",
    ] as const) {
      const filled = fillSelfDeployingCommand(voidBlock[key], longest);
      expect(filled.length, key).toBeLessThanOrEqual(32);
      expect(filled.join(" ").length, key).toBeLessThanOrEqual(256);
      expect(selfDeployingCommandSchema.safeParse(filled).success, key).toBe(true);
    }
  });

  it("fills in the stage and the account id, word by word", () => {
    expect(fillSelfDeployingCommand(voidInstall, values)).toEqual([
      ...VOID,
      "install",
      "--yes",
      "--name",
      "appflare-x0yzabcd",
      "--display-name",
      "Void",
      "--account",
      ACCOUNT_ID,
      "--workers-dev",
    ]);
    expect(fillSelfDeployingCommand(["void", "--name={{stage}}-{{stage}}"], values)).toEqual([
      "void",
      "--name=appflare-x0yzabcd-appflare-x0yzabcd",
    ]);
    // A command without placeholders (an alchemy one) comes back as it was.
    expect(fillSelfDeployingCommand(selfDeploying.deployCommand, values)).toEqual(
      selfDeploying.deployCommand,
    );
  });

  it("refuses to fill in anything but a stage and an account id", () => {
    for (const bad of [
      { ...values, stage: "Prod" },
      { ...values, stage: "a; rm -rf /" },
      { ...values, stage: "a".repeat(MAX_STAGE_LENGTH + 1) },
      { ...values, accountId: "not-an-account" },
      { ...values, accountId: ACCOUNT_ID.toUpperCase() },
    ]) {
      expect(() => fillSelfDeployingCommand(voidInstall, bad)).toThrow();
    }
  });
});

describe("stages and names of a void install", () => {
  /** Void's own normalization of an installation name (packages/platform, manifest.ts). */
  function voidSlug(value: string): string {
    const slug = value
      .trim()
      .toLowerCase()
      .replaceAll(/[^a-z0-9-]+/g, "-")
      .replaceAll(/^-+|-+$/g, "")
      .replaceAll(/-{2,}/g, "-");
    if (!slug || slug.length > 40) throw new Error(`not a Void installation name: ${value}`);
    return slug;
  }

  it("passes every stage Appflare derives to Void unchanged", () => {
    for (const installId of [
      "01J8Z3Q4R5S6T7V8W9X0YZABCD",
      "01HZZZZZZZZZZZZZZZZZZZZZZZ",
      "x",
      // Dashes and other separators in an id never reach the stage.
      "install--a--b--c",
      "--------",
      "",
    ]) {
      const stage = selfDeployingStage(installId);
      expect(stage, installId).not.toContain("--");
      expect(selfDeployingStageSchema.safeParse(stage).success, installId).toBe(true);
      expect(voidSlug(stage)).toBe(stage);
    }
    // The longest stage Appflare accepts is well within Void's 40 characters.
    expect(MAX_STAGE_LENGTH).toBeLessThanOrEqual(40);
    expect(voidSlug("a".repeat(MAX_STAGE_LENGTH))).toHaveLength(MAX_STAGE_LENGTH);
  });

  it("fits Void's longest Worker name within 63 characters at the longest stage", () => {
    const template = "void-{{stage}}-email-gateway";
    expect(selfDeployingWorkerTemplateSchema.safeParse(template).success).toBe(true);
    expect(renderWorkerTemplate(template, "a".repeat(MAX_STAGE_LENGTH))).toHaveLength(43);
    for (const name of voidBlock.workerNames) {
      expect(selfDeployingWorkerTemplateSchema.safeParse(name).success, name).toBe(true);
    }
  });
});

describe('the "workers-for-platforms" requirement', () => {
  it("is an account capability, so the manager checks the account for it", () => {
    expect(requirementSchema.safeParse(WORKERS_FOR_PLATFORMS_REQUIREMENT).success).toBe(true);
    expect(isManagerFeatureRequirement(WORKERS_FOR_PLATFORMS_REQUIREMENT)).toBe(false);
    expect(accountRequirements(["r2", WORKERS_FOR_PLATFORMS_REQUIREMENT, "secret-keys"])).toEqual([
      "r2",
      WORKERS_FOR_PLATFORMS_REQUIREMENT,
    ]);
  });
});

describe("resources a void install reports", () => {
  it("takes dispatch namespaces, Hyperdrive configurations and AI Gateways", () => {
    for (const kind of ["dispatch_namespace", "hyperdrive", "ai_gateway"]) {
      expect(selfManagedResourceKindSchema.safeParse(kind).success, kind).toBe(true);
    }
    expect(selfManagedResourceKindSchema.safeParse("dispatch-namespace").success).toBe(false);
  });
});
