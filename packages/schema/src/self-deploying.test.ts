import { describe, expect, it } from "vitest";
import { catalogManifestSchema } from "./catalog";
import { indexAppSchema } from "./catalog-index";
import {
  appSecretSecretName,
  appTokenSecretName,
  SANDBOX_PROTOCOL_VERSION,
  selfManagedOutcomeSchema,
  selfManagedRunRequestSchema,
} from "./sandbox";
import {
  renderWorkerTemplate,
  SELF_DEPLOYING_TOOLS,
  selfDeployingStage,
  selfDeployingStageArg,
  selfDeployingStageSchema,
} from "./self-deploying";

const PIN = "84e4705503ceaef54d1b284c167de9942563cdae";

const selfDeploying = {
  tool: "alchemy" as const,
  deployCommand: ["pnpm", "alchemy", "deploy", "--yes"],
  destroyCommand: ["pnpm", "alchemy", "destroy", "--yes"],
  stateStore: "cloudflare",
  workers: ["open-seo-{{stage}}", "open-seo-{{stage}}-audit"],
};

const manifest = {
  slug: "open-seo",
  name: "OpenSEO",
  summary: "Self-hosted SEO research.",
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
  vars: [{ name: "ACCESS_ALLOWED_EMAILS", label: "Allowed emails", required: true }],
  postInstall: [],
  tokenPermissions: [{ name: "Workers Scripts", scope: "account" }],
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
    for (const workers of [
      ["open-seo"],
      ["Open-Seo-{{stage}}"],
      ["open-seo-{{stage}}-{{stage}}"],
      [`${"a".repeat(40)}-{{stage}}`],
      [],
    ]) {
      expect(
        catalogManifestSchema.safeParse(
          withInstall({ selfDeploying: { ...selfDeploying, workers } }),
        ).success,
      ).toBe(false);
    }
  });

  it("accepts only the Cloudflare state store and known tools", () => {
    for (const block of [
      { ...selfDeploying, stateStore: "local" },
      { ...selfDeploying, tool: "terraform" },
      { ...selfDeploying, stageArg: "stage" },
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
});

describe("the index entry of a self-deploying app", () => {
  const entry = {
    slug: "open-seo",
    name: "OpenSEO",
    summary: "Self-hosted SEO research.",
    version: "0.1.9",
    tier: "self-deploying",
    plan: "paid",
    requires: [],
    lastVerified: null,
    maintainers: ["every-app"],
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
        image: "docker.io/appflare/sandbox:0.4.0",
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
