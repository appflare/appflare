import { z } from "zod";
import { STAGE_PLACEHOLDER } from "./placeholders.ts";

/**
 * The catalog manifest's `install.selfDeploying` block, for apps of the
 * `self-deploying` tier: apps that ship their own installer (for example an
 * Alchemy stack) instead of a wrangler project Appflare can pack. The
 * account's sandbox Worker checks the pinned commit out, installs its
 * dependencies with install scripts disabled, runs the entry's
 * `install.buildCommand` (if any) without credentials, then runs the
 * installer's deploy command with the app's own Cloudflare API token. An
 * update runs the deploy command again at the new pin; an uninstall runs the
 * destroy command. Appflare records what the installer created and never
 * deletes any of it itself.
 *
 * The installer keeps its state in the account itself (for Alchemy, its
 * `alchemy-state-store` Worker, which the first deploy creates), so every
 * run in a fresh container sees what earlier runs deployed.
 *
 * This module imports nothing but zod and placeholders: `catalog.ts` imports
 * it, and the JSON Schema export runs `catalog.ts` directly under Node's type
 * stripping.
 */

/** Installers Appflare knows how to run. */
export const selfDeployingToolSchema = z.enum(["alchemy"]);
export type SelfDeployingTool = z.infer<typeof selfDeployingToolSchema>;

/** How Appflare hands credentials and the stage to one installer. */
export interface SelfDeployingToolConventions {
  /** Shown in the manager ("Deployed with Alchemy"). */
  label: string;
  /** Environment variables the installer reads the app's Cloudflare API token from. */
  tokenEnv: readonly string[];
  /** Environment variables the installer reads the Cloudflare account id from. */
  accountIdEnv: readonly string[];
  /** The option the sandbox Worker appends to both commands, before the install's stage. */
  stageArg: string;
}

/**
 * Alchemy (2.x): with `CI` set, it reads `CLOUDFLARE_API_TOKEN` and
 * `CLOUDFLARE_ACCOUNT_ID` from the environment instead of a login profile,
 * and `alchemy deploy|destroy --stage <name>` picks the stage. Without
 * `--env-file`, the settings the stack reads through Effect `Config` come
 * from a `.env` in the working directory first and the process environment
 * second, so the sandbox Worker deletes any `.env` in the checkout before the
 * installer runs, and the app's settings and secrets reach it as environment
 * variables.
 */
export const SELF_DEPLOYING_TOOLS: Record<SelfDeployingTool, SelfDeployingToolConventions> = {
  alchemy: {
    label: "Alchemy",
    tokenEnv: ["CLOUDFLARE_API_TOKEN"],
    accountIdEnv: ["CLOUDFLARE_ACCOUNT_ID"],
    stageArg: "--stage",
  },
};

/**
 * One word of an installer command. The sandbox Worker runs it without a
 * shell's help, so only characters no shell interprets are allowed.
 */
export const selfDeployingArgWordSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9@%+,./:=_-]+$/, "may contain only letters, digits, and @ % + , . / : = _ -");

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * An installer command as argv: the program first, then its arguments. Not
 * one string like `install.buildCommand`: the sandbox Worker appends the
 * stage option and the stage as words of their own, and the words run
 * exactly as listed, so a list says precisely what runs with the app's
 * Cloudflare API token in its environment.
 */
export const selfDeployingCommandSchema = z
  .array(selfDeployingArgWordSchema)
  .min(1)
  .max(32)
  .refine((argv) => argv.join(" ").length <= 256, "must be at most 256 characters in total")
  .refine(
    (argv) => !argv.some((word) => ENV_ASSIGNMENT.test(word)),
    "must not set environment variables; the command runs in a fixed environment",
  )
  .refine((argv) => !(argv[0] ?? "").startsWith("-"), "must start with a program, not an option");
export type SelfDeployingCommand = z.infer<typeof selfDeployingCommandSchema>;

/** The longest stage Appflare passes (see {@link selfDeployingStageSchema}). */
export const MAX_STAGE_LENGTH = 24;

/**
 * A Worker the installer creates, named with {@link STAGE_PLACEHOLDER} for the
 * stage, for example `open-seo-{{stage}}`. Filled in, it must be a Worker name
 * (lowercase letters, digits and dashes, at most 63 characters, with the
 * longest stage Appflare uses).
 */
export const selfDeployingWorkerTemplateSchema = z
  .string()
  .regex(
    /^[a-z0-9-]*\{\{stage\}\}[a-z0-9-]*$/,
    "must be lowercase letters, digits and dashes around exactly one {{stage}}",
  )
  .refine(
    (template) => template.replace(STAGE_PLACEHOLDER, "x".repeat(MAX_STAGE_LENGTH)).length <= 63,
    "is longer than 63 characters once the stage is filled in",
  );

/**
 * The stage an install deploys to: lowercase letters, digits and dashes, as
 * Alchemy accepts and as fits a Worker name. Each install has its own, so two
 * installs of one app never share a resource.
 */
export const selfDeployingStageSchema = z
  .string()
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/,
    `must be 1 to ${MAX_STAGE_LENGTH} lowercase letters, digits or dashes, not starting or ending with a dash`,
  );

/**
 * The stage of an install: `appflare-` and the last 8 characters of its id,
 * lowercase. Install ids are ULIDs, whose last characters are random, so two
 * installs in one account practically never share a stage, and the prefix
 * tells anyone looking at the account who deployed it.
 */
export function selfDeployingStage(installId: string): string {
  const tail = installId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(-8);
  return `appflare-${tail || "0"}`;
}

/** A Worker name template filled in with a stage. */
export function renderWorkerTemplate(template: string, stage: string): string {
  return template.replace(STAGE_PLACEHOLDER, stage);
}

/**
 * `install.selfDeploying`: how the sandbox Worker runs the app's own
 * installer. Allowed only when `install.tier` is `"self-deploying"`, and
 * required then.
 */
export const catalogSelfDeployingSchema = z
  .object({
    tool: selfDeployingToolSchema.describe(
      'The installer the app ships. `"alchemy"`: an Alchemy stack, which gets the app\'s token ' +
        "as `CLOUDFLARE_API_TOKEN` and the account id as `CLOUDFLARE_ACCOUNT_ID`.",
    ),
    deployCommand: selfDeployingCommandSchema.describe(
      "The command that deploys (or updates) the app, as argv, run at the root of the " +
        "checkout after the dependency install and `install.buildCommand`, for example " +
        '`["pnpm", "alchemy", "deploy", "--yes"]`. The sandbox Worker appends the stage ' +
        "option and the stage (`--stage <stage>` for Alchemy). It must not prompt: it runs " +
        "without a terminal. A list of words rather than one string, so the words run exactly " +
        "as listed.",
    ),
    destroyCommand: selfDeployingCommandSchema.describe(
      "The command that deletes everything the deploy command created, as argv, for example " +
        '`["pnpm", "alchemy", "destroy", "--yes"]`. Uninstalling runs it; Appflare never ' +
        "deletes the app's resources itself.",
    ),
    workerNames: z
      .array(selfDeployingWorkerTemplateSchema)
      .min(1)
      .max(8)
      .describe(
        "The Workers the deploy command creates, with `{{stage}}` for the install's stage, for " +
          'example `["open-seo-{{stage}}", "open-seo-{{stage}}-audit"]`. The first one serves ' +
          "the app: its workers.dev URL is the install's URL and the health check probes it. " +
          "After each deploy Appflare reads these Workers and records what they bind.",
      ),
  })
  .superRefine((block, ctx) => {
    const stageArg = SELF_DEPLOYING_TOOLS[block.tool].stageArg;
    for (const key of ["deployCommand", "destroyCommand"] as const) {
      if (namesStage(block[key], stageArg)) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `must not name the stage; the sandbox Worker appends ${stageArg} <stage>`,
        });
      }
    }
  })
  .meta({
    description:
      "How the sandbox Worker runs the app's own installer (self-deploying tier only). The " +
      "admin creates a Cloudflare API token from `tokenPermissions` for it. The installer keeps " +
      "its state in the account (for Alchemy, its `alchemy-state-store` Worker), so every run " +
      "sees what earlier runs deployed.",
  });
export type CatalogSelfDeploying = z.infer<typeof catalogSelfDeployingSchema>;

/** The option that names the stage for this entry: its tool's. */
export function selfDeployingStageArg(block: Pick<CatalogSelfDeploying, "tool">): string {
  return SELF_DEPLOYING_TOOLS[block.tool].stageArg;
}

/** Whether a command already names a stage (`--stage x` or `--stage=x`). */
export function namesStage(command: readonly string[], stageArg: string): boolean {
  return command.some((word) => word === stageArg || word.startsWith(`${stageArg}=`));
}

/**
 * Why an install block's tier and `selfDeploying` do not go together, or
 * null when they do.
 */
export function selfDeployingTierProblem(install: {
  tier: string;
  selfDeploying?: unknown;
}): { path: string; message: string } | null {
  if (install.tier === "self-deploying" && install.selfDeploying === undefined) {
    return {
      path: "selfDeploying",
      message: "a self-deploying tier entry needs install.selfDeploying",
    };
  }
  if (install.tier !== "self-deploying" && install.selfDeploying !== undefined) {
    return {
      path: "selfDeploying",
      message: `install.selfDeploying is only allowed for the self-deploying tier, not ${install.tier}`,
    };
  }
  return null;
}
