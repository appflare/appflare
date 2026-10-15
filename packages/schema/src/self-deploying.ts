import { z } from "zod";
import { ACCOUNT_ID_PLACEHOLDER, PLACEHOLDER_FIELDS, STAGE_PLACEHOLDER } from "./placeholders.ts";

/**
 * The catalog manifest's `install.selfDeploying` block, for apps of the
 * `self-deploying` tier: apps that ship their own installer (for example an
 * Alchemy stack, or the Void CLI) instead of a wrangler project Appflare can
 * pack. The account's sandbox Worker checks the pinned commit out, installs
 * its dependencies with install scripts disabled, runs the entry's
 * `install.buildCommand` (if any) without credentials, then runs one of the
 * installer's commands with the app's own Cloudflare API token. An update
 * runs the installer again at the new pin; an uninstall runs its destroy
 * command. Appflare records what the installer created and never deletes any
 * of it itself.
 *
 * Each tool has a block of its own, told apart by `tool`:
 *
 * - `alchemy`: one deploy command (install and update alike) and one destroy
 *   command. The sandbox Worker appends `--stage <stage>` to both. Alchemy
 *   keeps its state in the account itself (its `alchemy-state-store`
 *   Worker), so every run in a fresh container sees what earlier runs
 *   deployed.
 * - `void`: a command for each thing the sandbox Worker may need to do
 *   (discover, install, resume, update, destroy). Void takes the
 *   installation's name as an option or argument of its own, so the entry
 *   writes `{{stage}}` (and `{{accountId}}` where the command names the
 *   account) into the command words, and the sandbox Worker fills them in
 *   with {@link fillSelfDeployingCommand}. Which command runs is the sandbox
 *   Worker's decision, made from the installation's recorded status.
 *
 * This module imports nothing but zod and placeholders: `catalog.ts` imports
 * it, and the JSON Schema export runs `catalog.ts` directly under Node's type
 * stripping.
 */

/** Installers Appflare knows how to run. */
export const selfDeployingToolSchema = z.enum(["alchemy", "void"]);
export type SelfDeployingTool = z.infer<typeof selfDeployingToolSchema>;

/** The option Alchemy picks its stage with, which the sandbox Worker appends. */
const ALCHEMY_STAGE_ARG = "--stage";

/** How Appflare hands credentials and the stage to one installer. */
export interface SelfDeployingToolConventions {
  /** Shown in the manager ("Deployed with Alchemy"). */
  label: string;
  /** Environment variables the installer reads the app's Cloudflare API token from. */
  tokenEnv: readonly string[];
  /** Environment variables the installer reads the Cloudflare account id from. */
  accountIdEnv: readonly string[];
  /**
   * The option the sandbox Worker appends to every command, before the
   * install's stage; null for a tool whose entry writes `{{stage}}` into
   * its command words instead.
   */
  stageArg: string | null;
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
 *
 * Void (the `void platform` commands): reads the token it manages the
 * account with from `CLOUDFLARE_API_TOKEN` and the token its runtime Workers
 * use from `VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN`; one app token serves
 * both. Its installation name (the stage) and account are options of each
 * command (`--name {{stage}}`, `--account {{accountId}}`), so nothing is
 * appended.
 */
export const SELF_DEPLOYING_TOOLS: Record<SelfDeployingTool, SelfDeployingToolConventions> = {
  alchemy: {
    label: "Alchemy",
    tokenEnv: ["CLOUDFLARE_API_TOKEN"],
    accountIdEnv: ["CLOUDFLARE_ACCOUNT_ID"],
    stageArg: ALCHEMY_STAGE_ARG,
  },
  void: {
    label: "Void",
    tokenEnv: ["CLOUDFLARE_API_TOKEN", "VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN"],
    accountIdEnv: ["CLOUDFLARE_ACCOUNT_ID"],
    stageArg: null,
  },
};

/** The characters a command word may hold: none that a shell interprets. */
const WORD_CHARACTERS = "A-Za-z0-9@%+,./:=_-";

/**
 * One word of an installer command. The sandbox Worker runs it without a
 * shell's help, so only characters no shell interprets are allowed.
 */
export const selfDeployingArgWordSchema = z
  .string()
  .min(1)
  .regex(
    new RegExp(`^[${WORD_CHARACTERS}]+$`),
    "may contain only letters, digits, and @ % + , . / : = _ -",
  );

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The most words a command may have. */
export const MAX_COMMAND_WORDS = 32;

/** The longest a command may be, its words joined with spaces. */
export const MAX_COMMAND_LENGTH = 256;

/**
 * An installer command as argv: the program first, then its arguments. Not
 * one string like `install.buildCommand`: the words run exactly as listed,
 * so a list says precisely what runs with the app's Cloudflare API token in
 * its environment. This is the command as it runs, with no placeholders
 * left; {@link selfDeployingCommandTemplateSchema} is one with placeholders.
 */
export const selfDeployingCommandSchema = z
  .array(selfDeployingArgWordSchema)
  .min(1)
  .max(MAX_COMMAND_WORDS)
  .refine(
    (argv) => argv.join(" ").length <= MAX_COMMAND_LENGTH,
    `must be at most ${MAX_COMMAND_LENGTH} characters in total`,
  )
  .refine(
    (argv) => !argv.some((word) => ENV_ASSIGNMENT.test(word)),
    "must not set environment variables; the command runs in a fixed environment",
  )
  .refine((argv) => !(argv[0] ?? "").startsWith("-"), "must start with a program, not an option");
export type SelfDeployingCommand = z.infer<typeof selfDeployingCommandSchema>;

/** The longest stage Appflare passes (see {@link selfDeployingStageSchema}). */
export const MAX_STAGE_LENGTH = 24;

/** The placeholders a command template may hold, by name. */
export const COMMAND_PLACEHOLDER_NAMES = PLACEHOLDER_FIELDS.selfDeployingCommand;
export type CommandPlaceholderName = (typeof COMMAND_PLACEHOLDER_NAMES)[number];

/** `{{stage}}` or `{{accountId}}`, exactly as written: no spaces, case as listed. */
const COMMAND_PLACEHOLDER_SOURCE = `\\{\\{(?:${COMMAND_PLACEHOLDER_NAMES.join("|")})\\}\\}`;

/**
 * One word of a command template: as {@link selfDeployingArgWordSchema}, and
 * it may also be or contain `{{stage}}` and `{{accountId}}`. No other braces.
 */
export const selfDeployingTemplateWordSchema = z
  .string()
  .min(1)
  .regex(
    new RegExp(`^(?:[${WORD_CHARACTERS}]|${COMMAND_PLACEHOLDER_SOURCE})+$`),
    "may contain only letters, digits, @ % + , . / : = _ - and the placeholders {{stage}} and {{accountId}}",
  );

/** Whether a word holds `{{stage}}` or `{{accountId}}`. */
function hasCommandPlaceholder(word: string): boolean {
  return new RegExp(COMMAND_PLACEHOLDER_SOURCE).test(word);
}

/** What fills a command template's placeholders. */
export interface SelfDeployingCommandValues {
  /** The install's stage ({@link selfDeployingStageSchema}). */
  stage: string;
  /** The Cloudflare account id, 32 lowercase hex characters. */
  accountId: string;
}

const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/;

/**
 * A command template with `{{stage}}` and `{{accountId}}` filled in, ready
 * to run. Throws when the stage is not a stage or the account id not an
 * account id, so what it returns holds only characters a command word may
 * (a template that {@link selfDeployingCommandTemplateSchema} accepts fills
 * in to a command {@link selfDeployingCommandSchema} accepts). A command
 * without placeholders comes back as it was.
 */
export function fillSelfDeployingCommand(
  template: readonly string[],
  values: SelfDeployingCommandValues,
): string[] {
  if (!selfDeployingStageSchema.safeParse(values.stage).success) {
    throw new Error(`"${values.stage}" is not a stage`);
  }
  if (!ACCOUNT_ID_PATTERN.test(values.accountId)) {
    throw new Error("the account id must be 32 lowercase hex characters");
  }
  return fillWords(template, values);
}

function fillWords(template: readonly string[], values: SelfDeployingCommandValues): string[] {
  return template.map((word) =>
    word
      .replaceAll(STAGE_PLACEHOLDER, values.stage)
      .replaceAll(ACCOUNT_ID_PLACEHOLDER, values.accountId),
  );
}

/**
 * The longest values a template can be filled with, starting with letters,
 * so the checks below see the longest command it can become and any
 * environment assignment a placeholder could start.
 */
const LONGEST_VALUES: SelfDeployingCommandValues = {
  stage: "x".repeat(MAX_STAGE_LENGTH),
  accountId: "f".repeat(32),
};

/**
 * An installer command whose words may hold `{{stage}}` and `{{accountId}}`,
 * which the sandbox Worker fills in before it runs
 * ({@link fillSelfDeployingCommand}). Filled in with the longest stage and an
 * account id, it must still be a command {@link selfDeployingCommandSchema}
 * accepts: at most 256 characters, no environment assignment, a program
 * first (written out, not a placeholder).
 */
export const selfDeployingCommandTemplateSchema = z
  .array(selfDeployingTemplateWordSchema)
  .min(1)
  .max(MAX_COMMAND_WORDS)
  .superRefine((argv, ctx) => {
    const first = argv[0] ?? "";
    if (first.startsWith("-") || hasCommandPlaceholder(first)) {
      ctx.addIssue({
        code: "custom",
        path: [0],
        message: "must start with a program, not an option or a placeholder",
      });
    }
    const filled = fillWords(argv, LONGEST_VALUES);
    if (filled.join(" ").length > MAX_COMMAND_LENGTH) {
      ctx.addIssue({
        code: "custom",
        message: `must be at most ${MAX_COMMAND_LENGTH} characters in total once {{stage}} and {{accountId}} are filled in`,
      });
    }
    filled.forEach((word, i) => {
      if (ENV_ASSIGNMENT.test(word)) {
        ctx.addIssue({
          code: "custom",
          path: [i],
          message: "must not set environment variables; the command runs in a fixed environment",
        });
      }
    });
  });
export type SelfDeployingCommandTemplate = z.infer<typeof selfDeployingCommandTemplateSchema>;

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
 * installs of one app never share a resource. Void takes it as its
 * installation name, which may be up to 40 of the same characters, but folds
 * repeated dashes into one; a stage has none, so Void keeps it as written and
 * the Workers it names match the entry's `workerNames`.
 */
export const selfDeployingStageSchema = z
  .string()
  .regex(
    /^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/,
    `must be 1 to ${MAX_STAGE_LENGTH} lowercase letters, digits or single dashes, not starting or ending with a dash`,
  );

/**
 * The stage of an install: `appflare-` and the last 8 characters of its id,
 * lowercase. Install ids are ULIDs, whose last characters are random, so two
 * installs in one account practically never share a stage, and the prefix
 * tells anyone looking at the account who deployed it. It has a single dash,
 * so Void, which folds repeated dashes into one, keeps it as written.
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

const workerNamesSchema = z
  .array(selfDeployingWorkerTemplateSchema)
  .min(1)
  .max(8)
  .describe(
    "The Workers the installer creates, with `{{stage}}` for the install's stage, for " +
      'example `["open-seo-{{stage}}", "open-seo-{{stage}}-audit"]`. The first one serves ' +
      "the app: its workers.dev URL is the install's URL and the health check probes it. " +
      "After each run Appflare reads these Workers and records what they bind.",
  );

/** The commands of an Alchemy entry. */
export const ALCHEMY_COMMAND_FIELDS = ["deployCommand", "destroyCommand"] as const;

/** The commands of a Void entry, in the order the sandbox Worker may need them. */
export const VOID_COMMAND_FIELDS = [
  "discoverCommand",
  "installCommand",
  "resumeCommand",
  "updateCommand",
  "destroyCommand",
] as const;

/** `install.selfDeploying` of an Alchemy stack. */
export const alchemySelfDeployingSchema = z
  .object({
    tool: z
      .literal("alchemy")
      .describe(
        'The installer the app ships. `"alchemy"`: an Alchemy stack, which gets the app\'s ' +
          "token as `CLOUDFLARE_API_TOKEN` and the account id as `CLOUDFLARE_ACCOUNT_ID`, " +
          "and whose commands get `--stage <stage>` appended.",
      ),
    deployCommand: selfDeployingCommandSchema.describe(
      "Alchemy only. The command that deploys (or updates) the app, as argv, run at the root " +
        "of the checkout after the dependency install and `install.buildCommand`, for example " +
        '`["pnpm", "alchemy", "deploy", "--yes"]`. The sandbox Worker appends `--stage ' +
        "<stage>`. It must not prompt: it runs without a terminal. A list of words rather " +
        "than one string, so the words run exactly as listed.",
    ),
    destroyCommand: selfDeployingCommandSchema.describe(
      "The command that deletes everything the deploy command created, as argv, for example " +
        '`["pnpm", "alchemy", "destroy", "--yes"]`. Uninstalling runs it; Appflare never ' +
        "deletes the app's resources itself.",
    ),
    workerNames: workerNamesSchema,
  })
  .superRefine((block, ctx) => {
    for (const key of ALCHEMY_COMMAND_FIELDS) {
      if (namesStage(block[key], ALCHEMY_STAGE_ARG)) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `must not name the stage; the sandbox Worker appends ${ALCHEMY_STAGE_ARG} <stage>`,
        });
      }
    }
  });
export type AlchemySelfDeploying = z.infer<typeof alchemySelfDeployingSchema>;

const VOID_COMMAND_HELP =
  "Words may hold `{{stage}}` (the install's stage, Void's installation name) and " +
  "`{{accountId}}`, which the sandbox Worker fills in. It must not prompt: it runs without " +
  "a terminal.";

/** `install.selfDeploying` of the Void Platform, installed with the Void CLI. */
export const voidSelfDeployingSchema = z
  .object({
    tool: z
      .literal("void")
      .describe(
        '`"void"`: the Void CLI (`void platform ...`), which gets the app\'s token as ' +
          "`CLOUDFLARE_API_TOKEN` and `VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN` and the " +
          "account id as `CLOUDFLARE_ACCOUNT_ID`. Nothing is appended to its commands: they " +
          "name the stage with `{{stage}}`.",
      ),
    discoverCommand: selfDeployingCommandTemplateSchema.describe(
      "Void only. The command that rebuilds the installer's local record of an installation " +
        'from the account, as argv, for example `["pnpm", "exec", "void", "platform", ' +
        '"discover", "--account", "{{accountId}}", "--installation", "{{stage}}"]`. Run when ' +
        `that record is missing. ${VOID_COMMAND_HELP}`,
    ),
    installCommand: selfDeployingCommandTemplateSchema.describe(
      "Void only. The command that installs the app the first time, as argv, for example " +
        '`["pnpm", "exec", "void", "platform", "install", "--yes", "--name", "{{stage}}", ' +
        '"--display-name", "Void", "--account", "{{accountId}}", "--workers-dev"]`. ' +
        VOID_COMMAND_HELP,
    ),
    resumeCommand: selfDeployingCommandTemplateSchema.describe(
      "Void only. The command that continues an install that stopped part way, as argv: the " +
        `install command with \`--resume\`. ${VOID_COMMAND_HELP}`,
    ),
    updateCommand: selfDeployingCommandTemplateSchema.describe(
      "Void only. The command that updates an installed app to the pinned version, as argv, " +
        'for example `["pnpm", "exec", "void", "platform", "upgrade", "{{stage}}", "--yes"]`. ' +
        VOID_COMMAND_HELP,
    ),
    destroyCommand: selfDeployingCommandTemplateSchema.describe(
      "The command that deletes everything the installer created, as argv, for example " +
        '`["pnpm", "exec", "void", "platform", "uninstall", "{{stage}}", "--purge-resources", ' +
        '"--yes"]`. Uninstalling runs it; Appflare never deletes the app\'s resources itself. ' +
        VOID_COMMAND_HELP,
    ),
    workerNames: workerNamesSchema,
  })
  .superRefine((block, ctx) => {
    for (const key of VOID_COMMAND_FIELDS) {
      if (!block[key].some((word) => word.includes(STAGE_PLACEHOLDER))) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `must name the installation with ${STAGE_PLACEHOLDER}; nothing is appended to a void command`,
        });
      }
    }
  });
export type VoidSelfDeploying = z.infer<typeof voidSelfDeployingSchema>;

/**
 * `install.selfDeploying`: how the sandbox Worker runs the app's own
 * installer, one block shape per `tool`. Allowed only when `install.tier` is
 * `"self-deploying"`, and required then.
 */
export const catalogSelfDeployingSchema = z
  .discriminatedUnion("tool", [alchemySelfDeployingSchema, voidSelfDeployingSchema])
  .meta({
    description:
      "How the sandbox Worker runs the app's own installer (self-deploying tier only), with " +
      'fields that depend on `tool`: `"alchemy"` lists `deployCommand` and `destroyCommand`; ' +
      '`"void"` lists `discoverCommand`, `installCommand`, `resumeCommand`, `updateCommand` ' +
      "and `destroyCommand`. The admin creates a Cloudflare API token from `tokenPermissions` " +
      "for it. The installer keeps its state in the account (for Alchemy, its " +
      "`alchemy-state-store` Worker), so every run sees what earlier runs deployed.",
  });
export type CatalogSelfDeploying = z.infer<typeof catalogSelfDeployingSchema>;

/** The option that names the stage for this entry: its tool's, or null when its commands name it. */
export function selfDeployingStageArg(block: Pick<CatalogSelfDeploying, "tool">): string | null {
  return SELF_DEPLOYING_TOOLS[block.tool].stageArg;
}

/** Whether a command already names a stage (`--stage x` or `--stage=x`). */
export function namesStage(command: readonly string[], stageArg: string): boolean {
  return command.some((word) => word === stageArg || word.startsWith(`${stageArg}=`));
}

/**
 * What the strict catalog schema says about a field of `install.selfDeploying`
 * that the entry's tool does not take (the strict walk reports such a key as
 * unknown once the block matched its tool), or null for any other path.
 */
export function selfDeployingFieldMessage(path: ReadonlyArray<string | number>): string | null {
  if (path.length !== 3 || path[0] !== "install" || path[1] !== "selfDeploying") return null;
  const key = String(path[2]);
  const at = `install.selfDeploying.${key}`;
  const list = (fields: readonly string[]) =>
    `${fields.slice(0, -1).join(", ")} and ${fields.at(-1)}`;
  const alchemy: readonly string[] = ALCHEMY_COMMAND_FIELDS;
  const voidFields: readonly string[] = VOID_COMMAND_FIELDS;
  if (voidFields.includes(key) && !alchemy.includes(key)) {
    return `${at} is only for tool "void"; an alchemy entry lists ${list(alchemy)}`;
  }
  if (alchemy.includes(key) && !voidFields.includes(key)) {
    return `${at} is only for tool "alchemy"; a void entry lists ${list(voidFields)}`;
  }
  return null;
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
