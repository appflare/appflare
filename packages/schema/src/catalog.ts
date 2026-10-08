import { z } from "zod";
import {
  ACCESS_PLACEHOLDER_SOURCE,
  accessRequirementProblems,
  catalogAccessSchema,
} from "./access.ts";
import { appAlternativesSchema, appFeaturesSchema } from "./app-features.ts";
// With its extension: the JSON Schema export runs this file directly under
// Node's type stripping, which resolves relative imports literally.
import { buildEnvSchema } from "./build-env.ts";
import { catalogCategoriesSchema, catalogCategoryProblems } from "./categories.ts";
import { type ConfigPatch, configPatchSchema } from "./config-patch.ts";
import { catalogD1Schema } from "./d1.ts";
import { catalogFieldLinkSchema } from "./field-link.ts";
import { catalogHyperdriveBindingsSchema } from "./hyperdrive.ts";
import { catalogInstallDirsSchema, packageManagerSchema } from "./install-dirs.ts";
import {
  catalogLicenseProblem,
  licenseNoteSchema,
  licenseProblem,
  licenseSchema,
} from "./license.ts";
import { CATALOG_SLUG_PATTERN } from "./links.ts";
import {
  CONFIG_PATCH_VALUES_REQUIREMENT,
  EMAIL_PLACEHOLDERS_REQUIREMENT,
  EMAIL_WORKER_REQUIREMENT,
  HYPERDRIVE_CACHING_REQUIREMENT,
  MANAGER_FEATURE_REQUIREMENTS,
  SECRET_KEYS_REQUIREMENT,
  SERVICE_PROPS_REQUIREMENT,
} from "./manager-features.ts";
import { openPathSchema } from "./open-path.ts";
import {
  appTokenPermissions,
  catalogPipelinesSchema,
  pipelineManifestProblems,
} from "./pipelines.ts";
import {
  jsonTexts,
  PLACEHOLDER_FIELDS,
  placeholderInJsonKey,
  placeholderProblems,
  usesEmailPlaceholders,
} from "./placeholders.ts";
import { catalogR2Schema } from "./r2-lifecycle.ts";
import { BASE64_KEY_32_LENGTH, isBase64Key32 } from "./random-key.ts";
import { isSeedOnly, seedManifestProblems } from "./seed.ts";
import { catalogSelfDeployingSchema, selfDeployingTierProblem } from "./self-deploying.ts";
import { formatPath, type StrictProblem, strictSchema } from "./strict.ts";
import { taglineSchema } from "./tagline.ts";
import { tokenPermissionGroupProblems, tokenPermissionsSchema } from "./token-permissions.ts";
import { isVapidPrivateKey, VAPID_PRIVATE_KEY_LENGTH } from "./vapid.ts";
import { inlineConfigPathProblem, wranglerConfigInlineSchema } from "./wrangler-config-inline.ts";

/**
 * Schemas for the human-authored catalog manifest `appflare.jsonc`.
 * Everything derivable from the wrangler config
 * (bindings, DO migrations, compat, assets, crons) is NOT repeated here; the
 * packer reads it from the pinned checkout.
 */

/** 40-character lowercase hex git commit SHA. */
export const gitShaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/, "must be a 40-character lowercase hex git SHA");

export { CATALOG_SLUG_PATTERN };

/** `owner/repo` GitHub slug. */
export const ownerRepoSchema = z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'must be "owner/repo"');

/**
 * A semver version without a leading `v` (`1.2.3`, `2.0.0-rc.1`), as artifact
 * versions and release tags `<slug>@<version>` carry it.
 */
export const semverSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    "must be a semver version such as 1.2.3, without a leading v",
  );

/**
 * Rules for a catalog manifest's `install.buildCommand`: one command, or a
 * list of commands run in order, each of which the packer runs as a plain
 * argv, without a shell. Anything a shell would interpret (pipes, redirects,
 * quotes, variables, globs, command separators, environment assignments) is
 * refused rather than passed through literally, so what the manifest says is
 * exactly what runs.
 */

/** The longest build command a manifest may declare. */
export const MAX_BUILD_COMMAND_LENGTH = 256;

/** The most commands `install.buildCommand` may list. */
export const MAX_BUILD_COMMANDS = 8;

/**
 * Characters a build command may contain: letters, digits, spaces, and
 * `@ % + , . / : = _ -`. Enough for `pnpm --filter @scope/web build` or
 * `npx opennextjs-cloudflare build`; none of them means anything to a shell.
 */
export const BUILD_COMMAND_PATTERN = /^[A-Za-z0-9@%+,./:=_ -]+$/;

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The words of a build command, split on spaces. */
export function buildCommandArgv(command: string): string[] {
  return command.split(" ").filter((word) => word.length > 0);
}

/**
 * Why `command` cannot be a build command, or null when it can. The message
 * names the first offending character or word.
 */
export function buildCommandProblem(command: string): string | null {
  if (command.length > MAX_BUILD_COMMAND_LENGTH) {
    return `is longer than ${MAX_BUILD_COMMAND_LENGTH} characters`;
  }
  for (const char of command) {
    if (!BUILD_COMMAND_PATTERN.test(char)) {
      const shown = /^[\x21-\x7e]$/.test(char)
        ? `"${char}"`
        : `U+${char.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0")}`;
      return (
        `contains ${shown}; it runs as one plain command without a shell, so only letters, ` +
        "digits, spaces, and @ % + , . / : = _ - are allowed (no pipes, redirects, quotes, " +
        "variables, globs, or command separators)"
      );
    }
  }
  const argv = buildCommandArgv(command);
  const program = argv[0];
  if (program === undefined) return "is empty";
  const assignment = argv.find((word) => ENV_ASSIGNMENT.test(word));
  if (assignment !== undefined) {
    return `sets an environment variable ("${assignment}"); the packer runs the command in a fixed environment, so environment assignments are not allowed`;
  }
  if (program.startsWith("-")) return `starts with an option ("${program}") instead of a program`;
  return null;
}

/** One build command, as `install.buildCommand` or one entry of its list. */
export const singleBuildCommandSchema = z
  .string()
  .max(MAX_BUILD_COMMAND_LENGTH)
  .regex(
    BUILD_COMMAND_PATTERN,
    "buildCommand may contain only letters, digits, spaces, and @ % + , . / : = _ -; it runs without a shell",
  )
  .superRefine((command, ctx) => {
    const problem = buildCommandProblem(command);
    if (problem !== null) ctx.addIssue({ code: "custom", message: `buildCommand ${problem}` });
  });

/** `install.buildCommand`: one command, or up to {@link MAX_BUILD_COMMANDS} run in order. */
export type CatalogBuildCommand = string | string[];

/** The commands of `install.buildCommand`, in the order they run; empty when there is none. */
export function buildCommandList(command: CatalogBuildCommand | undefined): string[] {
  if (command === undefined) return [];
  return typeof command === "string" ? [command] : [...command];
}

/**
 * `install.buildCommand` on one line, for logs and display: the commands
 * joined with ` && `, which is how they run (in order, stopping at the first
 * that fails). Never run through a shell.
 */
export function buildCommandText(command: CatalogBuildCommand): string {
  return buildCommandList(command).join(" && ");
}

/**
 * The Workers of an entry that installs as several (`install.workers`). Each
 * has a short name within the entry; the install runs the primary Worker
 * under the install's own Worker name and every other one as
 * `<install Worker name>-<name>`, so the name must fit in a Worker name.
 */

/**
 * The most Workers one catalog entry may declare: 24, room for the largest
 * app the catalog knows (18 Workers) with some to spare. What bounds it is
 * the one Workflow instance that installs or updates them all: every Worker
 * adds its own steps (about 25 at an update, a canary of six probes with a
 * sleep after each included) and its own requests (about 20), and one
 * instance may run 10,000 steps on Workers Paid and 1,024 on Workers Free.
 * Requests are limited per Worker invocation instead (10,000 on Workers
 * Paid, 50 on Workers Free, where the manager spreads a job of several
 * Workers over as many invocations as it needs). Each Worker's upload is
 * checked on its own (`workerUploadProblem`). 24 Workers also leave most of
 * an account's Workers free: 100 on Workers Free, 500 on Workers Paid
 * (`FREE_PLAN_ACCOUNT_WORKERS`, `PAID_PLAN_ACCOUNT_WORKERS`).
 */
export const MAX_ENTRY_WORKERS = 24;

/**
 * The most Workers an entry with `"plan": "free"` may declare: as many as
 * any entry. It was 3 while the manager ran a job in one invocation of 50
 * requests; tools built against that release read this export by name, so it
 * stays for one release.
 *
 * @deprecated An entry with `"plan": "free"` may declare up to {@link MAX_ENTRY_WORKERS}.
 */
export const MAX_FREE_PLAN_ENTRY_WORKERS = MAX_ENTRY_WORKERS;

/** The longest name of one of an entry's Workers. */
export const MAX_ENTRY_WORKER_NAME_LENGTH = 24;

/** Lowercase letters, digits and inner hyphens: what a Worker name allows. */
export const ENTRY_WORKER_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** The name of one of an entry's Workers, as `install.workers[].name` gives it. */
export const entryWorkerNameSchema = z
  .string()
  .min(1)
  .max(MAX_ENTRY_WORKER_NAME_LENGTH)
  .regex(
    ENTRY_WORKER_NAME_PATTERN,
    "must be lowercase letters, digits, and hyphens, starting and ending with a letter or digit",
  );

/**
 * Which of an entry's Workers a secret or var goes to, by name. Only for
 * entries with `install.workers`.
 */
const entryWorkerTargetsSchema = z
  .array(entryWorkerNameSchema)
  .min(1)
  .describe(
    "For an entry that installs several Workers (`install.workers`): the names of the Workers " +
      "that get this value. Omitted means every Worker for a secret, and for a var the Workers " +
      "whose wrangler config declares it (every Worker when none does).",
  );

/** One Worker of an entry that installs as several (`install.workers`). */
export const catalogEntryWorkerSchema = z
  .object({
    name: entryWorkerNameSchema.describe(
      "The Worker's name within the entry, for example `api`. The primary Worker installs " +
        "under the install's Worker name; every other one as `<install Worker name>-<name>`. " +
        "Placeholders name it too: `{{appUrl:<name>}}`, `{{workerUrl:<name>}}`, " +
        "`{{workerName:<name>}}` and the hostname forms.",
    ),
    wranglerConfig: z
      .string()
      .min(1)
      .describe("Path of this Worker's wrangler config in the repository."),
    buildCommand: z
      .union([
        singleBuildCommandSchema,
        z.array(singleBuildCommandSchema).min(1).max(MAX_BUILD_COMMANDS),
      ])
      .describe(
        "The command, or the commands in order, the packer runs at the root of the checkout for " +
          "this Worker, after `install.buildCommand` (when set) and before bundling it. Same " +
          "rules as `install.buildCommand`.",
      )
      .optional(),
    configPatch: configPatchSchema
      .describe(
        "Changes to this Worker's wrangler config, applied before wrangler reads it; the same " +
          "rules as `install.configPatch`.",
      )
      .optional(),
    wranglerConfigInline: wranglerConfigInlineSchema
      .describe(
        "This Worker's wrangler config, for a repository that ships none; the same rules as " +
          "`install.wranglerConfigInline`, and `wranglerConfig` names where it is written.",
      )
      .optional(),
    primary: z
      .boolean()
      .default(false)
      .describe(
        "The Worker that answers the app's address and its health check. Exactly one Worker " +
          "is primary, and its `wranglerConfig` is `install.wranglerConfig`.",
      ),
    /**
     * Whether the Worker answers on its workers.dev URL. On unless set to
     * false; only a Worker other than the primary may turn it off.
     */
    workersDev: z
      .boolean()
      .default(true)
      .describe(
        "Whether this Worker answers on its workers.dev URL (on unless set to `false`). Set " +
          "`false` for a Worker only the entry's other Workers call, through a service binding " +
          "or a Durable Object binding, and that must not be reachable from the internet (for " +
          "example one that trusts identity headers set by the primary Worker). It then has no " +
          "public URL and no version previews, and updates skip its preview check. The primary " +
          "Worker always keeps its workers.dev URL: it is the app's address and health check " +
          "until a custom domain takes over.",
      ),
  })
  .describe("One Worker of an entry that installs as several Workers.");
export type CatalogEntryWorker = z.infer<typeof catalogEntryWorkerSchema>;

/** A problem with an entry's `install.workers`, on a path inside `install`. */
export interface EntryWorkersProblem {
  path: Array<string | number>;
  message: string;
}

/**
 * What is wrong with an install's `workers` list; empty when nothing is (or
 * when the entry installs one Worker).
 */
export function entryWorkersProblems(install: {
  tier: string;
  wranglerConfig: string;
  workers?:
    | ReadonlyArray<Pick<CatalogEntryWorker, "name" | "wranglerConfig" | "primary" | "workersDev">>
    | undefined;
}): EntryWorkersProblem[] {
  const workers = install.workers;
  if (workers === undefined) return [];
  const problems: EntryWorkersProblem[] = [];
  if (install.tier !== "artifact") {
    problems.push({
      path: ["workers"],
      message: `install.workers is only for the artifact tier; this entry's tier is ${install.tier}`,
    });
  }
  const primaries = workers.filter((w) => w.primary);
  const primary = primaries[0];
  if (primaries.length !== 1 || primary === undefined) {
    problems.push({
      path: ["workers"],
      message: `exactly one Worker in install.workers must set "primary": true; ${primaries.length} do`,
    });
  } else if (primary.wranglerConfig !== install.wranglerConfig) {
    problems.push({
      path: ["wranglerConfig"],
      message: `install.wranglerConfig must be the primary Worker's wranglerConfig ("${primary.wranglerConfig}"), so tools that build one Worker build the primary`,
    });
  }
  const names = new Set<string>();
  const configs = new Set<string>();
  workers.forEach((w, i) => {
    if (w.primary && !w.workersDev) {
      problems.push({
        path: ["workers", i, "workersDev"],
        message:
          "the primary Worker cannot turn workersDev off: its workers.dev URL is the app's address, health check and Open link until the admin adds a custom domain, which then turns it off",
      });
    }
    if (names.has(w.name)) {
      problems.push({ path: ["workers", i, "name"], message: `two Workers are named "${w.name}"` });
    }
    names.add(w.name);
    if (configs.has(w.wranglerConfig)) {
      problems.push({
        path: ["workers", i, "wranglerConfig"],
        message: `two Workers are built from ${w.wranglerConfig}`,
      });
    }
    configs.add(w.wranglerConfig);
  });
  return problems;
}

/**
 * How an app is built: `artifact` (a signed release catalog CI built),
 * `sandbox` (built from its pinned commit in the account's sandbox Worker),
 * or `self-deploying` (the app's own installer, run in the sandbox Worker).
 */
export const installTierSchema = z.enum(["artifact", "sandbox", "self-deploying"]);
export type InstallTier = z.infer<typeof installTierSchema>;

/** Free vs paid plan requirement. */
export const planSchema = z.enum(["free", "paid"]);
export type Plan = z.infer<typeof planSchema>;

/**
 * Account capability an app needs beyond the free Workers baseline, or a
 * feature the manager must have to install it (`MANAGER_FEATURE_REQUIREMENTS`
 * in ./manager-features.ts). A manager leaves out an entry that lists a value
 * it does not know, which is what keeps entries away from managers too old
 * for them.
 */
export const requirementSchema = z.enum([
  "r2",
  "zone",
  "email-routing",
  "workers-ai",
  "browser-rendering",
  "containers",
  "analytics-engine",
  "access",
  ...MANAGER_FEATURE_REQUIREMENTS,
]);
export type Requirement = z.infer<typeof requirementSchema>;

/**
 * What kind of value the install form generates for a secret. `password`: a
 * random password the admin can copy, regenerate or replace.
 * `vapid-private-key`: a Web Push (VAPID) private key, a P-256 private key
 * as the unpadded base64url of its raw 32 bytes, the form web-push libraries
 * take (see ./vapid.ts). `base64-key-32`: 32 random bytes as padded base64,
 * 44 characters, for apps that read a raw 256-bit key (see ./random-key.ts).
 */
export const SECRET_GENERATE_KINDS = ["password", "vapid-private-key", "base64-key-32"] as const;
export type SecretGenerateKind = (typeof SECRET_GENERATE_KINDS)[number];

/**
 * How the manager computes a derived secret from its source secret's value.
 * `bcrypt`: a bcrypt hash (`$2b$`, cost {@link BCRYPT_COST}, a fresh random
 * salt each time), as apps that check a password with `bcrypt.compare` expect
 * (Counterscale's `CF_PASSWORD_HASH`, for example). `vapid-public-key`: the
 * Web Push (VAPID) public key of a `generate: "vapid-private-key"` secret, as
 * the unpadded base64url of its 65-byte uncompressed point.
 */
export const SECRET_DERIVE_METHODS = ["bcrypt", "vapid-public-key"] as const;
export type SecretDeriveMethod = (typeof SECRET_DERIVE_METHODS)[number];

/**
 * How the manager computes a derived var: only methods whose result is
 * public config. A password hash stays a secret.
 */
export const VAR_DERIVE_METHODS = ["vapid-public-key"] as const;
export type VarDeriveMethod = (typeof VAR_DERIVE_METHODS)[number];

/** What a derive method needs its source secret to generate; undefined when any value will do. */
export function deriveSourceKind(method: SecretDeriveMethod): SecretGenerateKind | undefined {
  return method === "vapid-public-key" ? "vapid-private-key" : undefined;
}

/** The bcrypt cost (log2 of the rounds) of a derived `bcrypt` secret. */
export const BCRYPT_COST = 10;

/**
 * A secret the manager computes instead of asking for: `method` applied to the
 * value of the secret named `from`. See {@link catalogSecretSchema}.
 */
export const catalogSecretDeriveSchema = z
  .object({
    from: z
      .string()
      .min(1)
      .describe(
        "The secret whose value this one is computed from, by its `key` (its `name` when it has " +
          "no key). It must be another secret of this manifest, not itself derived, not optional.",
      ),
    method: z
      .enum(SECRET_DERIVE_METHODS)
      .describe(
        `How the value is computed. \`"bcrypt"\`: a bcrypt hash (\`$2b$\`, cost ${BCRYPT_COST}) of ` +
          "the source value, for apps that check a password against a stored hash. " +
          '`"vapid-public-key"`: the Web Push (VAPID) public key of a source secret with ' +
          '`generate: "vapid-private-key"`, as the unpadded base64url of its 65-byte uncompressed point.',
      ),
  })
  .describe(
    "Computes this secret from another one instead of asking for it: the install form shows only " +
      "the source secret, and the manager writes both at install, and again whenever the source " +
      "secret gets a new value in the app's settings or an update. Neither value is ever logged. " +
      "Not allowed with `generate` or `optional`, nor on self-deploying entries.",
  );
export type CatalogSecretDerive = z.infer<typeof catalogSecretDeriveSchema>;

/**
 * A var the manager computes from a secret instead of asking for: `method`
 * applied to the value of the secret named `from`. See {@link catalogVarSchema}.
 */
export const catalogVarDeriveSchema = z
  .object({
    from: z
      .string()
      .min(1)
      .describe(
        "The secret whose value this var is computed from, by its `key` (its `name` when it has " +
          "no key). It must be a secret of this manifest, not itself derived, not optional.",
      ),
    method: z
      .enum(VAR_DERIVE_METHODS)
      .describe(
        '`"vapid-public-key"`: the Web Push (VAPID) public key of a source secret with ' +
          '`generate: "vapid-private-key"`, as the unpadded base64url of its 65-byte uncompressed ' +
          "point: public config the app hands to browsers.",
      ),
  })
  .describe(
    "Computes this var from a secret instead of asking for it: the install and settings forms " +
      "show it read-only, and the manager sets it at install, and again whenever the source " +
      "secret gets a new value in the app's settings or an update. Not allowed with `default`, " +
      '`optional: true`, `type: "select"` or `options`, nor on self-deploying entries.',
  );
export type CatalogVarDerive = z.infer<typeof catalogVarDeriveSchema>;

/** Longest secret `key`. */
export const MAX_SECRET_KEY_LENGTH = 64;

/** A secret `key`: an env-name-like word, so it reads like the names beside it. */
export const SECRET_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const secretKeySchema = z
  .string()
  .min(1)
  .max(MAX_SECRET_KEY_LENGTH)
  .regex(SECRET_KEY_PATTERN, "must be letters, digits and underscores, not starting with a digit")
  .describe(
    "What Appflare calls the secret, when it is not its `name`: unique among the entry's " +
      "secrets, for an entry of several Workers where two secrets give different Workers a value " +
      "under one name, for example `GITHUB_CLIENT_ID` for the `CLIENT_ID` of the `github` " +
      "Worker. The forms, the install's record and `derive.from`, seed params and a Pipelines " +
      "sink's `tokenSecret` use the key; the Worker still reads the secret by `name`. Defaults " +
      `to \`name\`. An entry with a key other than its secret's name lists "${SECRET_KEYS_REQUIREMENT}" ` +
      "in `requires`, so managers that do not know keys leave it out. Not for self-deploying " +
      "entries. Changing a released secret's key makes installs ask for its value again.",
  );

/**
 * What Appflare knows a secret by: its `key`, else its `name`. The install
 * form's fields, the job inputs, the install's records (`resources.name` of a
 * `secret` row; `binding` holds the name the Worker reads) and every
 * reference from another field go by it.
 */
export function secretKey(secret: { name: string; key?: string | undefined }): string {
  return secret.key ?? secret.name;
}

/** Whether a secret's key differs from its name, which needs `requires: ["secret-keys"]`. */
export function hasOwnSecretKey(secret: { name: string; key?: string | undefined }): boolean {
  return secret.key !== undefined && secret.key !== secret.name;
}

/**
 * A secret the installer prompts for. `generate` makes the form fill in a
 * value instead of asking the user ({@link SECRET_GENERATE_KINDS}).
 *
 * `derive` makes the manager compute the secret from another secret's value
 * instead of asking for it ({@link catalogSecretDeriveSchema}); the manifest's
 * refinements check that the source exists and is an ordinary secret.
 *
 * `optional: true` marks a secret the app works without: the install form
 * leaves it unset unless the admin chooses to set it, updates never ask for
 * it, and the app's settings can remove it. Refused on `self-deploying`
 * entries, whose installer run expects every declared secret.
 *
 * `multiline: true` asks for a value of several lines (a PEM private key) in
 * a multi-line field; the value reaches the Worker with its line breaks
 * ({@link multilineSecretProblems} refuses it next to `generate` or `derive`).
 *
 * `cloudflareToken: true` marks the secret that takes the Cloudflare API
 * token the admin creates for the app from `tokenPermissions`; the forms show
 * how to create that token next to its field. At most one per entry.
 */
export const catalogSecretSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .describe(
        "The name the Worker reads the secret by, exactly as the app's code spells it, for " +
          "example `ADMIN_PASSWORD`.",
      ),
    key: secretKeySchema.optional(),
    label: z
      .string()
      .min(1)
      .describe(
        "What the install and settings forms call the secret, in plain words, for example " +
          "`Admin password`.",
      ),
    help: z
      .string()
      .describe(
        "A sentence or two shown under the field: what the value is for, or where to find it.",
      )
      .optional(),
    /** Where to get the value, as a link beside the field; see {@link catalogFieldLinkSchema}. */
    link: catalogFieldLinkSchema.optional(),
    generate: z
      .enum(SECRET_GENERATE_KINDS)
      .describe(
        'The install form fills in a value instead of asking for one. `"password"`: a random ' +
          'value the admin can copy, regenerate, or replace. `"vapid-private-key"`: a new Web Push (VAPID) private key, a ' +
          "P-256 private key as the unpadded base64url of its raw 32 bytes (the form web-push " +
          "libraries take), and the manager refuses a value that is not one. Pair it with a " +
          '`derive: { method: "vapid-public-key" }` var for the public key. `"base64-key-32"`: 32 ' +
          "random bytes as padded base64 (44 characters), for an app that reads a raw 256-bit key; " +
          "the manager refuses a value that does not decode to 32 bytes.",
      )
      .optional(),
    optional: z
      .boolean()
      .default(false)
      .describe(
        "The app works without this secret. The install form leaves it unset unless the admin " +
          'chooses "Set now", updates never ask for it, and the app\'s settings can remove it. ' +
          "Not allowed on self-deploying entries.",
      ),
    /** Computed from another secret instead of asked for. */
    derive: catalogSecretDeriveSchema.optional(),
    /**
     * For an entry with `install.workers`: the Workers that get the secret.
     * Omitted means every Worker of the entry.
     */
    workers: entryWorkerTargetsSchema.optional(),
    /** Only for seed statements. */
    seedOnly: z
      .boolean()
      .default(false)
      .describe(
        "The secret exists only for `resources.d1[binding].seed`: the install form asks for it once, " +
          "the seed uses it (as a param or the source of a hash), and it is never set on the Worker, " +
          "stored, or asked for again by updates or settings. For a first admin's password, so the " +
          "plaintext never sits in the app's environment. Not allowed with `optional`, `derive` or " +
          "`workers`, nor on self-deploying entries.",
      ),
    /** Asked for in a multi-line field. */
    multiline: z
      .boolean()
      .default(false)
      .describe(
        "The value spans several lines, such as a PEM private key: the install, update and " +
          "settings forms ask for it in a multi-line field that keeps every line break, and the " +
          "Worker gets the value as entered (Windows line endings become `\\n`, and spaces or " +
          "tabs at the end of the last line are dropped). Not allowed with `generate` or `derive`.",
      ),
    cloudflareToken: z
      .boolean()
      .default(false)
      .describe(
        "This secret takes the Cloudflare API token the admin creates for the app from " +
          "`tokenPermissions`: the install and settings forms show how to create that token next " +
          "to its field. At most one secret per entry. Not allowed with `generate`, `derive` or " +
          "`seedOnly`, and only when the entry lists `tokenPermissions` (or a Pipelines sink, " +
          "whose token permissions Appflare adds).",
      ),
  })
  // The manifest-level refinement does not reach the JSON Schema; this states
  // its per-secret half there (no `generate` and no `optional: true` next to
  // `derive`; no `optional: true`, `derive` or `workers` next to
  // `seedOnly: true`; no `generate` and no `derive` next to
  // `multiline: true`; no `generate`, `derive` or `seedOnly: true` next to
  // `cloudflareToken: true`), so editors refuse the same secrets.
  .meta({
    allOf: [
      {
        anyOf: [
          { not: { required: ["multiline"], properties: { multiline: { const: true } } } },
          { not: { anyOf: [{ required: ["derive"] }, { required: ["generate"] }] } },
        ],
      },
      {
        anyOf: [
          { not: { required: ["derive"] } },
          {
            not: { required: ["generate"] },
            properties: { optional: { not: { const: true } } },
          },
        ],
      },
      {
        anyOf: [
          { not: { required: ["seedOnly"], properties: { seedOnly: { const: true } } } },
          {
            not: { anyOf: [{ required: ["derive"] }, { required: ["workers"] }] },
            properties: { optional: { not: { const: true } } },
          },
        ],
      },
      {
        anyOf: [
          {
            not: {
              required: ["cloudflareToken"],
              properties: { cloudflareToken: { const: true } },
            },
          },
          {
            not: { anyOf: [{ required: ["derive"] }, { required: ["generate"] }] },
            properties: { seedOnly: { not: { const: true } } },
          },
        ],
      },
    ],
  });
export type CatalogSecret = z.infer<typeof catalogSecretSchema>;

/** Whether the app works without the secret (`optional: true`). */
export function isOptionalSecret(secret: { optional?: boolean | undefined }): boolean {
  return secret.optional === true;
}

/** Whether the forms ask for the secret in a multi-line field (`multiline: true`). */
export function isMultilineSecret(secret: { multiline?: boolean | undefined }): boolean {
  return secret.multiline === true;
}

/**
 * The secret that takes the app's own Cloudflare API token
 * (`cloudflareToken: true`), or null when none does.
 */
export function cloudflareTokenSecret<
  T extends { name: string; cloudflareToken?: boolean | undefined },
>(secrets: readonly T[]): T | null {
  return secrets.find((s) => s.cloudflareToken === true) ?? null;
}

/**
 * What is wrong with the `multiline` flags of a manifest's secrets, one issue
 * each (the Zod refinement and catalog tooling share it): a generated value
 * is one line, and a derived secret is never entered.
 */
export function multilineSecretProblems(
  secrets: ReadonlyArray<
    Pick<CatalogSecret, "name" | "generate" | "derive"> & { multiline?: boolean | undefined }
  >,
): Array<{ path: Array<string | number>; message: string }> {
  const problems: Array<{ path: Array<string | number>; message: string }> = [];
  secrets.forEach((secret, i) => {
    if (!isMultilineSecret(secret)) return;
    if (secret.generate !== undefined) {
      problems.push({
        path: [i, "multiline"],
        message: `${secret.name} is multiline; it cannot also be generated, since a generated value is one line`,
      });
    }
    if (secret.derive !== undefined) {
      problems.push({
        path: [i, "multiline"],
        message: `${secret.name} is derived from ${secret.derive.from}, so no one enters it; it cannot be multiline`,
      });
    }
  });
  return problems;
}

/** Whether the manager computes the secret from another one (`derive`). */
export function isDerivedSecret(secret: Pick<CatalogSecret, "derive">): boolean {
  return secret.derive !== undefined;
}

/**
 * Why `value` cannot be the value of `secret`, or null when it can. Only a
 * generated kind has a format: a `generate: "vapid-private-key"` secret takes
 * a VAPID private key, whatever the admin typed over the generated one.
 * Never repeats the value.
 */
export function secretValueProblem(
  secret: Pick<CatalogSecret, "name" | "label" | "generate">,
  value: string,
): string | null {
  if (secret.generate === "vapid-private-key" && !isVapidPrivateKey(value)) {
    return `${secret.label} (${secret.name}) must be a VAPID private key: the unpadded base64url of a 32-byte P-256 private key (${VAPID_PRIVATE_KEY_LENGTH} characters), as web-push libraries generate it.`;
  }
  if (secret.generate === "base64-key-32" && !isBase64Key32(value)) {
    return `${secret.label} (${secret.name}) must be a 256-bit key: 32 bytes as padded base64 (${BASE64_KEY_32_LENGTH} characters).`;
  }
  return null;
}

/** The secrets an admin enters (or has generated): every one but the derived ones, in order. */
export function enteredSecrets<T extends Pick<CatalogSecret, "derive">>(
  secrets: readonly T[],
): T[] {
  return secrets.filter((s) => !isDerivedSecret(s));
}

/**
 * What is wrong with the `derive` blocks of a manifest's secrets, one issue
 * each (the Zod refinement and catalog tooling share it): the source must be
 * another declared secret that is neither derived nor optional, and a derived
 * secret may not also be generated or optional.
 */
export function derivedSecretProblems(
  secrets: ReadonlyArray<
    Pick<CatalogSecret, "name" | "generate" | "derive"> & {
      key?: string | undefined;
      optional?: boolean | undefined;
    }
  >,
): Array<{ path: Array<string | number>; message: string }> {
  // `derive.from` names the source by its key (its name when it has none).
  const byName = new Map(secrets.map((s) => [secretKey(s), s]));
  const problems: Array<{ path: Array<string | number>; message: string }> = [];
  secrets.forEach((secret, i) => {
    const derive = secret.derive;
    if (derive === undefined) return;
    if (secret.generate !== undefined) {
      problems.push({
        path: [i, "generate"],
        message: `${secret.name} is derived from ${derive.from}; it cannot also be generated`,
      });
    }
    if (isOptionalSecret(secret)) {
      problems.push({
        path: [i, "optional"],
        message: `${secret.name} is derived from ${derive.from}, whose presence it follows; it cannot be optional`,
      });
    }
    const source = byName.get(derive.from);
    if (derive.from === secretKey(secret)) {
      problems.push({
        path: [i, "derive", "from"],
        message: `${secret.name} cannot derive from itself`,
      });
    } else if (source === undefined) {
      problems.push({
        path: [i, "derive", "from"],
        message: `${secret.name} derives from ${derive.from}, which is not a secret of this manifest`,
      });
    } else if (isDerivedSecret(source)) {
      problems.push({
        path: [i, "derive", "from"],
        message: `${secret.name} derives from ${derive.from}, which is itself derived; derive from the secret the admin enters`,
      });
    } else if (isOptionalSecret(source)) {
      problems.push({
        path: [i, "derive", "from"],
        message: `${secret.name} derives from ${derive.from}, which is optional; its source must be a secret every install has`,
      });
    } else {
      const kind = sourceKindProblem(secret.name, derive, source);
      if (kind !== null) problems.push({ path: [i, "derive", "method"], message: kind });
    }
  });
  return problems;
}

/** Why `source` cannot feed `derive.method`, or null when it can. */
function sourceKindProblem(
  name: string,
  derive: { from: string; method: SecretDeriveMethod },
  source: Pick<CatalogSecret, "generate">,
): string | null {
  const kind = deriveSourceKind(derive.method);
  if (kind === undefined || source.generate === kind) return null;
  return `${name} is the ${derive.method} of ${derive.from}, which must then be generate: "${kind}"`;
}

/**
 * What is wrong with the `derive` blocks of a manifest's vars, one issue
 * each (the Zod refinement and catalog tooling share it): the source must be
 * a declared secret, neither derived nor optional, that generates the kind
 * of value the method reads.
 */
export function derivedVarProblems(
  secrets: ReadonlyArray<
    Pick<CatalogSecret, "name" | "generate" | "derive"> & {
      key?: string | undefined;
      optional?: boolean | undefined;
    }
  >,
  vars: ReadonlyArray<{ name: string; derive?: CatalogVarDerive | undefined }>,
): Array<{ path: Array<string | number>; message: string }> {
  const byName = new Map(secrets.map((s) => [secretKey(s), s]));
  const problems: Array<{ path: Array<string | number>; message: string }> = [];
  vars.forEach((v, i) => {
    const derive = v.derive;
    if (derive === undefined) return;
    const source = byName.get(derive.from);
    const from = [i, "derive", "from"];
    if (source === undefined) {
      problems.push({
        path: from,
        message: `${v.name} derives from ${derive.from}, which is not a secret of this manifest`,
      });
    } else if (isDerivedSecret(source)) {
      problems.push({
        path: from,
        message: `${v.name} derives from ${derive.from}, which is itself derived; derive from the secret the admin enters`,
      });
    } else if (isOptionalSecret(source)) {
      problems.push({
        path: from,
        message: `${v.name} derives from ${derive.from}, which is optional; its source must be a secret every install has`,
      });
    } else {
      const kind = sourceKindProblem(v.name, derive, source);
      if (kind !== null) problems.push({ path: [i, "derive", "method"], message: kind });
    }
  });
  return problems;
}

/**
 * A plain (non-secret) var the install form asks for. It reaches the Worker
 * as a `plain_text` binding, or as a `json` binding when the app's wrangler
 * config gives the var a value that is not a string (an array, object,
 * number, or boolean): the form then takes JSON and `default` must be JSON
 * text. `default` may hold the placeholders of `PLACEHOLDER_FIELDS.varDefault`
 * (`{{appUrl}}`, `{{workerName}}`, `{{accountId}}` and the others).
 *
 * `optional: true` marks a var the admin may leave empty; every other var
 * needs a value (typed, or its `default`) before the install runs.
 *
 * `type: "select"` with `options` limits the var to a fixed set of values,
 * shown as choices instead of a text field; `default`, when given, must be one
 * of them.
 */
export const CATALOG_VAR_TYPES = ["text", "select"] as const;
export type CatalogVarType = (typeof CATALOG_VAR_TYPES)[number];

/** Most choices a `select` var may offer. */
export const MAX_VAR_OPTIONS = 20;

/** One choice of a `select` var: the value the Worker gets, and what the form shows. */
export const catalogVarOptionSchema = z.object({
  value: z
    .string()
    .min(1)
    .max(200)
    .describe(
      "What the Worker gets. For a var the app reads as JSON, JSON text such as `true` or `404`.",
    ),
  label: z.string().min(1).max(80).describe("What the form shows for this choice."),
});
export type CatalogVarOption = z.infer<typeof catalogVarOptionSchema>;

/**
 * What is wrong with a var's `type`, `options` and `default` together, one
 * issue each (the Zod refinement and catalog tooling share it).
 */
export function selectVarProblems(v: {
  type: CatalogVarType;
  options?: readonly CatalogVarOption[] | undefined;
  default?: string | undefined;
}): Array<{ path: Array<string | number>; message: string }> {
  const problems: Array<{ path: Array<string | number>; message: string }> = [];
  if (v.type !== "select") {
    if (v.options !== undefined) {
      problems.push({
        path: ["options"],
        message: 'options are only allowed with type: "select"',
      });
    }
    return problems;
  }
  if (v.options === undefined) {
    problems.push({ path: ["options"], message: 'a type: "select" var needs options' });
    return problems;
  }
  const seen = new Set<string>();
  v.options.forEach((option, i) => {
    if (seen.has(option.value)) {
      problems.push({
        path: ["options", i, "value"],
        message: `option values must be distinct; "${option.value}" is listed twice`,
      });
    }
    seen.add(option.value);
  });
  if (v.default !== undefined && !seen.has(v.default)) {
    problems.push({
      path: ["default"],
      message: `default must be one of the options (${[...seen].map((s) => `"${s}"`).join(", ")})`,
    });
  }
  return problems;
}

export const catalogVarSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .describe(
        "The name the Worker reads the setting by, exactly as the app's code and wrangler " +
          "config spell it, for example `SITE_TITLE`.",
      ),
    label: z
      .string()
      .min(1)
      .describe(
        "What the install and settings forms call the setting, in plain words, for example " +
          "`Site title`.",
      ),
    help: z
      .string()
      .describe(
        "A sentence or two shown under the field: what the setting changes, or which values work.",
      )
      .optional(),
    /** A link beside the field; see {@link catalogFieldLinkSchema}. */
    link: catalogFieldLinkSchema.optional(),
    default: z
      .string()
      .describe(
        "Value the form starts with, filled in on every install, update and settings change. " +
          "`{{appUrl}}` becomes the address the app is served at (its custom domain while " +
          "workers.dev is off for it, else its workers.dev URL; no trailing slash) and " +
          "`{{appHostname}}` that address's hostname; `{{workerUrl}}` and `{{workerHostname}}` are " +
          "always the workers.dev address (`https://<worker name>.<account subdomain>.workers.dev`); " +
          "`{{workerName}}` is the installed Worker's name and `{{accountId}}` the id of the " +
          "Cloudflare account. `{{wildcardHostname}}` becomes the hostname of the app's wildcard " +
          "domain (for an entry with `install.wildcardHostname`), empty until one is assigned. " +
          "For an app Appflare protects with Cloudflare Access, `{{accessTeamDomain}}` becomes " +
          "the team domain (`<team>.cloudflareaccess.com`), `{{accessTeamName}}` the team name " +
          "alone (`<team>`), `{{accessAud}}` the audience tag of the app's Access application and " +
          "`{{accessCertsUrl}}` the URL of the keys that sign Access's JWTs; all four are empty " +
          "while the app is not protected, and filled in again when protection is turned on or " +
          "off. " +
          "An entry of several Workers names one with `{{appUrl:<name>}}` and the like. When " +
          "the app's wrangler config gives this var a value that is not a string (an array, " +
          "object, number, or boolean), the var reaches the Worker as JSON and `default` must be " +
          'JSON text, for example `["{{appUrl}}"]`. Without `default`, the form starts with the ' +
          'wrangler config\'s value. For a `type: "select"` var, `default` must be one of the ' +
          "`options` values.",
      )
      .optional(),
    optional: z
      .boolean()
      .default(false)
      .describe(
        "The admin may leave this var empty. Every other var needs a value, typed or from " +
          "`default`, before the install runs.",
      ),
    type: z
      .enum(CATALOG_VAR_TYPES)
      .default("text")
      .describe(
        '`"text"` (the default) takes any value; `"select"` takes one of `options`, shown as ' +
          "choices (cards for up to 4, a dropdown beyond).",
      ),
    options: z
      .array(catalogVarOptionSchema)
      .min(2)
      .max(MAX_VAR_OPTIONS)
      .describe(
        'The values a `type: "select"` var can take, in the order the form shows them. Required ' +
          "for, and only allowed with, `select`. Values must be distinct.",
      )
      .optional(),
    /** Computed from a secret instead of asked for. */
    derive: catalogVarDeriveSchema.optional(),
    /**
     * For an entry with `install.workers`: the Workers that get the var.
     * Omitted means the Workers whose wrangler config declares it, else every Worker.
     */
    workers: entryWorkerTargetsSchema.optional(),
    /** Only for seed statements. */
    seedOnly: z
      .boolean()
      .default(false)
      .describe(
        "The var exists only for `resources.d1[binding].seed`, such as a first admin's user name: " +
          "the install form asks for it once, a seed statement binds it, and it is never set on the " +
          "Worker, stored, or shown in settings. Must not be optional, or must have a default. " +
          "Not allowed with `derive` or `workers`, nor on self-deploying entries.",
      ),
  })
  .superRefine((v, ctx) => {
    for (const problem of selectVarProblems(v)) {
      ctx.addIssue({ code: "custom", path: problem.path, message: problem.message });
    }
    if (v.derive === undefined) return;
    // The manager sets a derived var itself: nothing for the form to start with or ask.
    for (const field of ["default", "options"] as const) {
      if (v[field] !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `${v.name} is derived from ${v.derive.from}; it cannot also have ${field}`,
        });
      }
    }
    if (v.type === "select") {
      ctx.addIssue({
        code: "custom",
        path: ["type"],
        message: `${v.name} is derived from ${v.derive.from}; it cannot also be a select`,
      });
    }
    if (v.optional) {
      ctx.addIssue({
        code: "custom",
        path: ["optional"],
        message: `${v.name} is derived from ${v.derive.from}, which every install has; it cannot be optional`,
      });
    }
  })
  // The refinements do not reach the JSON Schema; `allOf` states the pairing
  // of `type: "select"` and `options` there, and that a derived var has no
  // `default`, `options`, `type: "select"` or `optional: true`, so editors
  // refuse the same vars.
  .meta({
    allOf: [
      {
        anyOf: [
          { required: ["type", "options"], properties: { type: { const: "select" } } },
          {
            not: { required: ["options"] },
            properties: { type: { not: { const: "select" } } },
          },
        ],
      },
      {
        anyOf: [
          { not: { required: ["derive"] } },
          {
            not: { anyOf: [{ required: ["default"] }, { required: ["options"] }] },
            properties: {
              type: { not: { const: "select" } },
              optional: { not: { const: true } },
            },
          },
        ],
      },
    ],
  });
export type CatalogVar = z.infer<typeof catalogVarSchema>;

/** Whether the manager computes the var from a secret (`derive`). */
export function isDerivedVar(v: Pick<CatalogVar, "derive">): boolean {
  return v.derive !== undefined;
}

/** The choices of a `type: "select"` var; null for any other var. */
export function catalogVarOptions(
  v: Pick<CatalogVar, "type" | "options">,
): CatalogVarOption[] | null {
  return v.type === "select" && v.options !== undefined ? v.options : null;
}

/**
 * A post-install instruction rendered after a successful install, with the
 * placeholders of `PLACEHOLDER_FIELDS.postInstall` filled in.
 */
export const postInstallStepSchema = z
  .object({
    type: z.enum(["markdown"]).describe('How `content` is written. Only `"markdown"` for now.'),
    content: z
      .string()
      .min(1)
      .describe(
        "Markdown the manager shows once the app is installed, such as how to sign in the first " +
          "time. These placeholders are filled in: " +
          PLACEHOLDER_FIELDS.postInstall.map((name) => `\`{{${name}}}\``).join(", ") +
          ". For the address people open, use `{{appUrl}}`, which follows a custom domain. An " +
          "entry of several Workers names one of them with `{{appUrl:<name>}}` and the like.",
      ),
  })
  .describe("A note the manager shows after the install.");
export type PostInstallStep = z.infer<typeof postInstallStepSchema>;

/** How a Vectorize index measures the distance between two vectors. */
export const vectorizeMetricSchema = z.enum(["cosine", "euclidean", "dot-product"]);
export type VectorizeMetric = z.infer<typeof vectorizeMetricSchema>;

/**
 * The fixed shape of a Vectorize index. Cloudflare needs both to create the
 * index and neither can change afterwards; wrangler's config does not carry
 * them (`wrangler vectorize create` takes them as flags), so the catalog
 * manifest states them. Vectorize allows at most 1536 dimensions.
 */
export const vectorizeIndexConfigSchema = z.object({
  dimensions: z.int().min(1).max(1536),
  metric: vectorizeMetricSchema,
});
export type VectorizeIndexConfig = z.infer<typeof vectorizeIndexConfigSchema>;

/** Vectorize allows at most 10 metadata indexes per index. */
export const MAX_VECTORIZE_METADATA_INDEXES = 10;

/** The type of a metadata property a Vectorize metadata index filters on. */
export const vectorizeMetadataTypeSchema = z.enum(["string", "number", "boolean"]);
export type VectorizeMetadataType = z.infer<typeof vectorizeMetadataTypeSchema>;

/**
 * A metadata index: queries can filter on this metadata property. Only
 * vectors written after it exists are indexed, so the manager creates it
 * right after the index, before the app writes anything. Names follow
 * Vectorize's rules for filter keys: not empty, at most 512 characters, no
 * `"`, not starting with `$` (a `.` names a nested property).
 */
export const vectorizeMetadataIndexSchema = z.object({
  propertyName: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[^$"][^"]*$/, 'a metadata property name cannot contain " or start with $')
    .describe("The metadata property queries filter on, for example `url` or `user_id`."),
  type: vectorizeMetadataTypeSchema.describe("The property's type: string, number or boolean."),
});
export type VectorizeMetadataIndex = z.infer<typeof vectorizeMetadataIndexSchema>;

/** `metadataIndexes`, each property once. */
export const vectorizeMetadataIndexesSchema = z
  .array(vectorizeMetadataIndexSchema)
  .min(1)
  .max(MAX_VECTORIZE_METADATA_INDEXES)
  .superRefine((indexes, ctx) => {
    const seen = new Set<string>();
    indexes.forEach((index, i) => {
      if (seen.has(index.propertyName)) {
        ctx.addIssue({
          code: "custom",
          path: [i, "propertyName"],
          message: `the metadata property "${index.propertyName}" is indexed twice`,
        });
      }
      seen.add(index.propertyName);
    });
  });

/**
 * `resources.vectorize[binding]`: the index's fixed shape, and the metadata
 * indexes the manager creates on it right after the index, when the app's
 * queries filter on metadata.
 */
export const catalogVectorizeIndexSchema = vectorizeIndexConfigSchema.extend({
  metadataIndexes: vectorizeMetadataIndexesSchema
    .describe(
      "Metadata properties the app's queries filter on, each with its type. Appflare creates " +
        "these metadata indexes when it creates the index, before the app writes a vector (a " +
        `vector written earlier is not indexed). At most ${MAX_VECTORIZE_METADATA_INDEXES}.`,
    )
    .optional(),
});
export type CatalogVectorizeIndex = z.infer<typeof catalogVectorizeIndexSchema>;

/**
 * Settings for resources the app's wrangler config binds but cannot fully
 * describe. `vectorize` is keyed by binding name and must cover every
 * Vectorize binding in the wrangler config; the packer refuses one without it.
 * `hyperdrive` declares every Hyperdrive binding, by name, with the database
 * protocol behind it: the database lives outside Cloudflare, so the install
 * form asks for its connection string, and the packer refuses a Hyperdrive
 * binding it does not declare. `d1` says where a D1 binding's SQL lives when the
 * wrangler config's migrations folder does not (see `d1.ts`). `pipelines`
 * describes the stream behind each Pipelines binding and the Iceberg table
 * its events land in (see `pipelines.ts`). Each is optional: most apps need
 * none of them.
 */
export const catalogResourcesSchema = z.object({
  vectorize: z.record(z.string().min(1), catalogVectorizeIndexSchema).optional(),
  r2: catalogR2Schema
    .describe(
      "Settings of the R2 bucket Appflare creates for an R2 binding, keyed by the binding's name: " +
        "lifecycle rules that delete objects, move them to Infrequent Access storage, or abort " +
        "unfinished multipart uploads after some days. Every key must be an R2 binding of the " +
        "wrangler config. Not allowed on self-deploying entries.",
    )
    .optional(),
  hyperdrive: catalogHyperdriveBindingsSchema
    .describe(
      "The Hyperdrive bindings of the wrangler config, keyed by the binding's name, each with the " +
        "database it connects to (`postgres` or `mysql`). The database runs outside Cloudflare: the " +
        "install form asks for its connection string, and Appflare creates a Hyperdrive " +
        "configuration of the install's own from it. Every Hyperdrive binding must be listed. Not " +
        "allowed on self-deploying entries.",
    )
    .optional(),
  pipelines: catalogPipelinesSchema.optional(),
  d1: z
    .record(z.string().min(1), catalogD1Schema)
    .describe(
      "Where each D1 binding's SQL lives when the wrangler config's migrations folder does not " +
        "describe it, keyed by the binding's name: a migrations folder or glob, schema files that " +
        "run on every install and update, migrations that run after the new version serves, seed " +
        "statements, and a baseline schema that runs once on a new database. Paths are relative to the checkout's root. Not allowed on self-deploying entries.",
    )
    .optional(),
});
export type CatalogResources = z.infer<typeof catalogResourcesSchema>;

/** The pinned upstream source a version is built from; the bump bot edits it. */
export const catalogSourceSchema = z.object({
  ref: z
    .string()
    .min(1)
    .describe(
      "The tag or branch of the app's repository this entry is built from, for example " +
        "`v1.4.2` or `main`. A tag that is a semver version is also the version the catalog " +
        "shows. The catalog's bump bot moves it when upstream publishes a new release.",
    ),
  sha: gitShaSchema.describe(
    "The commit the entry is built from, as its full 40-character SHA in lower case: the " +
      "commit `ref` pointed at when the entry was last updated. The build always uses this " +
      "commit, so a moved tag or a new commit on the branch changes nothing until `sha` does.",
  ),
  /**
   * The version shown for this entry when the repository's tag does not
   * describe this app (monorepos); it must change whenever `sha` moves.
   * Omitted means the version comes from `ref` when it is a semver tag, else
   * from the pinned commit's date and SHA.
   */
  version: semverSchema
    .describe(
      "The version shown for this entry when the repository's tag does not describe this app " +
        "(monorepos); it must change whenever `sha` moves. Omitted, the version comes from `ref` " +
        "when it is a semver tag, else from the pinned commit's date and SHA.",
    )
    .optional(),
});
export type CatalogSource = z.infer<typeof catalogSourceSchema>;

/**
 * How the health check after an install, update, or rollback reads the
 * Worker's answer.
 *
 * - `no-server-errors` (the default): any answer but a server error counts
 *   as verified (a redirect or a 4xx still shows the Worker answered); a
 *   server error (5xx) counts as unhealthy.
 * - `any-response`: any answer the Worker itself gives counts as verified,
 *   server errors included, because an app that checks Cloudflare Access or
 *   its own sign-in answers every unauthenticated request with a redirect,
 *   401, 403, or an error of its own.
 *
 * Neither reads the body beyond the version check, and under both,
 * connection failures and Cloudflare's own error pages (`error code: 1042`
 * while the route goes live, or a Worker that crashed) are retried or
 * reported, since they are not the Worker's answer. Nor is the redirect to
 * Cloudflare Access's sign-in page that Access sends before a request
 * reaches the Worker: it never counts as serving.
 */
export const HEALTH_MODES = ["no-server-errors", "any-response"] as const;

/** The health mode of an entry that does not set one. */
export const DEFAULT_HEALTH_MODE = "no-server-errors" satisfies (typeof HEALTH_MODES)[number];

export const healthModeSchema = z
  .enum(HEALTH_MODES)
  .describe(
    'Which answers of the Worker count as serving. `"no-server-errors"` (the default): any ' +
      "answer but a server error (5xx), so a redirect or a 404 passes and a 500 fails. " +
      '`"any-response"`: any answer the Worker itself gives, server errors included; use it ' +
      "for an app whose health path asks for a sign-in, its own or one it checks from " +
      "Cloudflare Access. " +
      "Either way, connection failures and Cloudflare's own error pages (such as " +
      "`error code: 1042` while the route goes live) are retried and never count as serving, " +
      "and neither does the redirect to Cloudflare Access's sign-in page, which Access sends " +
      "before the request reaches the Worker.",
  );
export type HealthMode = z.infer<typeof healthModeSchema>;

/**
 * How the manager checks that the app serves, after an install, update or
 * rollback: the path it probes and how it reads the answer.
 */
export const catalogHealthSchema = z
  .object({
    path: z
      .string()
      .regex(/^\/[^\s?#]*$/, "health.path is a URL path starting with /, without query or fragment")
      .default("/")
      .describe(
        "The path the manager probes, for example `/api/health`. When it answers JSON with a " +
          'string `version`, an update\'s check of the new version requires that version. Defaults to `"/"`.',
      ),
    mode: healthModeSchema.default(DEFAULT_HEALTH_MODE),
  })
  .describe("How the manager checks that the app serves after an install, update or rollback.");
export type CatalogHealth = z.infer<typeof catalogHealthSchema>;
/** Most addresses one entry may ask Email Routing to deliver to its Worker. */
export const EMAIL_ROUTING_MAX_RULES = 10;

/**
 * An address the manager routes to the app: a local part such as `inbox`
 * (becoming `inbox@<the zone the admin picks>`) or a full address such as
 * `inbox@example.com`, which must then be in the zone the admin picks.
 * The local part is at most 64 lowercase letters and digits, with single `.`,
 * `_`, `+` or `-` between them (so `a..b` and `.a` are refused).
 */
export const EMAIL_ROUTING_ADDRESS_PATTERN =
  /^(?=[^@]{1,64}(?:@|$))[a-z0-9]+(?:[._+-][a-z0-9]+)*(?:@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)?$/;

/**
 * Email the app receives through Email Routing. When set, the install form
 * asks the admin for one of the account's zones, and the install:
 * turns Email Routing on for that zone if it is off (Cloudflare then adds
 * its MX, SPF and DKIM records), creates one routing rule per `rules` entry, and
 * with `catchAll` points the zone's catch-all rule at the app's Worker (for
 * an app of several Workers, the primary one unless `worker` names another).
 * That Worker must export an `email` handler. Uninstalling removes the
 * rules, puts the catch-all back as it was, and turns Email Routing off again
 * only when the install turned it on and no other rule remains.
 */
export const catalogEmailRoutingSchema = z
  .object({
    /**
     * For an app of several Workers: the `install.workers[].name` of the
     * Worker that receives the mail. Omitted means the primary Worker. Read
     * the receiving Worker's installed name with `emailScriptName`.
     */
    worker: entryWorkerNameSchema
      .describe(
        "For an app of several Workers (`install.workers`): the `name` of the Worker that " +
          "receives the mail, which must export an `email` handler. Omitted means the primary " +
          "Worker. Email Routing delivers to a Worker by name, not over HTTP, so a Worker with " +
          '`workersDev: false` can receive mail. An entry that sets it lists `"email-worker"` in ' +
          "`requires`.",
      )
      .optional(),
    catchAll: z
      .boolean()
      .default(false)
      .describe(
        "Send every address of the zone that no other rule matches to the app (the zone's " +
          "catch-all rule). The install refuses when the catch-all already sends mail somewhere else.",
      ),
    rules: z
      .array(
        z
          .string()
          .regex(
            EMAIL_ROUTING_ADDRESS_PATTERN,
            "must be a lowercase local part such as inbox, or a full address such as inbox@example.com",
          ),
      )
      .max(EMAIL_ROUTING_MAX_RULES)
      // `uniqueItems` lands in the JSON Schema, so editors flag a repeated address too.
      .meta({
        description:
          "Addresses to route to the app, one routing rule each: a local part such as `inbox` " +
          "(becomes `inbox@<zone>`) or a full address in the chosen zone. The install refuses an " +
          "address that already has a rule.",
        uniqueItems: true,
      })
      .default([]),
  })
  .refine((v) => v.catchAll || v.rules.length > 0, {
    message: "set catchAll to true or list at least one address in rules",
  })
  .refine((v) => new Set(v.rules).size === v.rules.length, {
    message: "rules must not list an address twice",
    path: ["rules"],
  })
  // The refinements do not reach the JSON Schema; `anyOf` states the first one
  // there, so editors refuse `{}` as the parser does.
  .meta({
    description:
      "Email the app receives through Email Routing. The install form asks for one of the " +
      "account's zones; the install turns Email Routing on there if it is off, then points the " +
      "listed addresses (and, with `catchAll`, every other address) at the app's Worker (the " +
      "primary one, or the Worker `worker` names), which must export an `email` handler. " +
      "Uninstalling removes what the install added. `{{emailDomain}}` and `{{emailZoneId}}` " +
      "give the app the zone's name and id. Not for the self-deploying tier, whose own " +
      "installer deploys the app.",
    anyOf: [
      { required: ["catchAll"], properties: { catchAll: { const: true } } },
      { required: ["rules"], properties: { rules: { minItems: 1 } } },
    ],
  });
export type CatalogEmailRouting = z.infer<typeof catalogEmailRoutingSchema>;

/**
 * What is wrong with `install.emailRouting.worker`; empty when nothing is.
 * It names one of `install.workers`, so an entry of one Worker cannot set it.
 */
export function emailRoutingWorkerProblems(install: {
  emailRouting?: { worker?: string | undefined } | undefined;
  workers?: ReadonlyArray<{ name: string }> | undefined;
}): Array<{ path: Array<string | number>; message: string }> {
  const worker = install.emailRouting?.worker;
  if (worker === undefined) return [];
  const path = ["emailRouting", "worker"];
  if (install.workers === undefined) {
    return [
      {
        path,
        message:
          "install.emailRouting.worker names one of install.workers; an entry of one Worker receives mail with that Worker, so leave it out",
      },
    ];
  }
  if (!install.workers.some((w) => w.name === worker)) {
    return [
      {
        path,
        message: `install.emailRouting.worker names the Worker "${worker}", which install.workers does not declare`,
      },
    ];
  }
  return [];
}

/**
 * Container sizes a sandbox build may run on. `standard-1` (1/2 vCPU, 4 GiB
 * memory, 8 GB disk) is the default; an entry whose build needs more may ask
 * for `standard-2` (1 vCPU, 6 GiB, 12 GB). Smaller types cannot hold a
 * typical Vite or OpenNext build.
 */
export const sandboxInstanceTypeSchema = z.enum(["standard-1", "standard-2"]);
export type SandboxInstanceType = z.infer<typeof sandboxInstanceTypeSchema>;
export const DEFAULT_SANDBOX_INSTANCE_TYPE: SandboxInstanceType = "standard-1";

/** Minutes a sandbox build is expected to take when the entry does not say. */
export const DEFAULT_EXPECTED_BUILD_MINUTES = 10;

/** The longest build an entry may declare; the build step gives up after 55 minutes anyway. */
export const MAX_EXPECTED_BUILD_MINUTES = 120;

/** Whole minutes a sandbox build usually takes, from 1 to {@link MAX_EXPECTED_BUILD_MINUTES}. */
export const expectedBuildMinutesSchema = z.int().min(1).max(MAX_EXPECTED_BUILD_MINUTES);

/** The tiers whose installs and updates run in the account's sandbox Worker. */
export const SANDBOX_RUN_TIERS = [
  "sandbox",
  "self-deploying",
] as const satisfies readonly InstallTier[];

/** Whether installs and updates of a `tier` entry run in the account's sandbox Worker. */
export function runsInSandbox(tier: InstallTier): tier is (typeof SANDBOX_RUN_TIERS)[number] {
  return (SANDBOX_RUN_TIERS as readonly InstallTier[]).includes(tier);
}

/**
 * How one run of an entry in the account's sandbox Worker is sized: the
 * build of a `sandbox` tier entry, or the run of a `self-deploying` entry's
 * own installer. This block is the source of the cost estimate the manager
 * shows before every such install or update: a run occupies one container
 * of `instanceType` for about `expectedMinutes`, and Cloudflare bills that
 * container's memory, vCPU and disk by the second beyond the usage Workers
 * Paid includes each month (a 10-minute `standard-1` run costs about one US
 * cent). `instanceType` also sets the container the run actually uses;
 * `expectedMinutes` changes nothing about the run itself. Catalog CI copies
 * both into the index entry's `build` block, where the manager reads them.
 * Refused on `artifact` entries, which never run in the user's account.
 */
export const catalogContainerSchema = z
  .object({
    expectedMinutes: expectedBuildMinutesSchema
      .describe(
        "About how many minutes one run of this app in the sandbox Worker takes (its build, or " +
          "for a self-deploying entry its installer's deploy), measured on a `standard-1` " +
          "container (or `instanceType`, when set). The manager multiplies it by the container's " +
          "rates to show what each install or update costs before the admin confirms it. Whole minutes, " +
          `1 to ${MAX_EXPECTED_BUILD_MINUTES}; defaults to ${DEFAULT_EXPECTED_BUILD_MINUTES}.`,
      )
      .default(DEFAULT_EXPECTED_BUILD_MINUTES),
    instanceType: sandboxInstanceTypeSchema
      .describe(
        "The container the run uses: `standard-1` (1/2 vCPU, 4 GiB memory, 8 GB disk) or " +
          "`standard-2` (1 vCPU, 6 GiB, 12 GB) for builds or installers that run out of memory or disk on the " +
          "smaller one. The larger container costs more per minute, which the manager's cost " +
          'estimate reflects. Defaults to `"standard-1"`.',
      )
      .default(DEFAULT_SANDBOX_INSTANCE_TYPE),
  })
  .describe(
    "How a run of this app in the user's sandbox Worker is sized: the build of a `sandbox` tier " +
      "entry or the installer of a `self-deploying` one (not allowed on `artifact` entries). Both " +
      "fields feed the cost the manager shows before each install and update.",
  );
export type CatalogContainer = z.infer<typeof catalogContainerSchema>;

/** The size of a run in the sandbox Worker, defaults filled in. */
export interface SandboxBuildSettings {
  expectedMinutes: number;
  instanceType: SandboxInstanceType;
}

/** `install.container`, or {@link DEFAULT_EXPECTED_BUILD_MINUTES} on {@link DEFAULT_SANDBOX_INSTANCE_TYPE} when the entry sets none. */
export function sandboxBuildSettings(
  install: Pick<CatalogInstall, "container">,
): SandboxBuildSettings {
  return {
    expectedMinutes: install.container?.expectedMinutes ?? DEFAULT_EXPECTED_BUILD_MINUTES,
    instanceType: install.container?.instanceType ?? DEFAULT_SANDBOX_INSTANCE_TYPE,
  };
}

/**
 * Suffixes of a wrangler config kept as a template to copy, such as
 * `wrangler.toml.example` or `wrangler.jsonc.template`. Wrangler reads a
 * config by its extension, so it cannot read such a file where it is.
 */
export const WRANGLER_CONFIG_TEMPLATE_SUFFIXES = [".example", ".template"] as const;

/** The extensions wrangler reads a config by. */
const WRANGLER_CONFIG_EXTENSIONS = [".toml", ".json", ".jsonc"] as const;

/**
 * The file name a template wrangler config is copied to before it is read
 * (`wrangler.toml.example` -> `wrangler.toml`), or null when `configPath`
 * is not a template: it does not end in a template suffix, or what is left
 * is not a `.toml`, `.json` or `.jsonc` file.
 */
export function wranglerConfigFromTemplate(configPath: string): string | null {
  const lower = configPath.toLowerCase();
  const suffix = WRANGLER_CONFIG_TEMPLATE_SUFFIXES.find((s) => lower.endsWith(s));
  if (suffix === undefined) return null;
  const real = configPath.slice(0, -suffix.length);
  const base = real.split("/").pop() ?? real;
  const extension = WRANGLER_CONFIG_EXTENSIONS.find((e) => base.toLowerCase().endsWith(e));
  if (extension === undefined || base.length === extension.length) return null;
  return real;
}

/**
 * Toolchains beyond Node.js a build needs. `rust`: catalog CI installs a
 * pinned Rust toolchain (rustup, with the `wasm32-unknown-unknown` target)
 * before the pack, for workers-rs apps built with `worker-build`.
 */
export const CATALOG_TOOLCHAINS = ["rust"] as const;
export const catalogToolchainSchema = z.enum(CATALOG_TOOLCHAINS);
export type CatalogToolchain = z.infer<typeof catalogToolchainSchema>;

/** The toolchains an entry's build needs (`install.toolchains`); empty when it lists none. */
export function installToolchains(
  install: Pick<CatalogInstall, "toolchains">,
): readonly CatalogToolchain[] {
  return install.toolchains ?? [];
}

/**
 * What is wrong with where an entry uses an inline wrangler config
 * (`install.wranglerConfigInline`, or a Worker's), on paths inside
 * `install`; empty when nothing is.
 */
export function wranglerConfigInlineProblems(install: {
  tier: string;
  wranglerConfig: string;
  configPatch?: unknown;
  wranglerConfigInline?: unknown;
  workers?: ReadonlyArray<InlineConfigTarget> | undefined;
}): EntryWorkersProblem[] {
  const problems: EntryWorkersProblem[] = [];
  const check = (at: Array<string | number>, label: string, target: InlineConfigTarget): void => {
    if (target.wranglerConfigInline === undefined) return;
    if (install.tier === "self-deploying") {
      problems.push({
        path: [...at, "wranglerConfigInline"],
        message: `${label} is not allowed for the self-deploying tier: its installer deploys the app without the packer that writes the config`,
      });
    }
    if (target.configPatch !== undefined) {
      problems.push({
        path: [...at, "configPatch"],
        message: `a config patch changes the repository's own config; with ${label}, change the inline config instead`,
      });
    }
    const pathProblem = inlineConfigPathProblem(target.wranglerConfig);
    if (pathProblem !== null) {
      problems.push({ path: [...at, "wranglerConfig"], message: pathProblem });
    }
  };
  if (install.wranglerConfigInline !== undefined && install.workers !== undefined) {
    problems.push({
      path: ["wranglerConfigInline"],
      message:
        "install.wranglerConfigInline is for an app of one Worker; with install.workers, set wranglerConfigInline on the Worker whose config it is",
    });
  } else {
    check([], "install.wranglerConfigInline", install);
  }
  (install.workers ?? []).forEach((worker, i) => {
    check(["workers", i], "wranglerConfigInline", worker);
  });
  return problems;
}

/** The fields {@link wranglerConfigInlineProblems} reads of an entry or one of its Workers. */
interface InlineConfigTarget {
  wranglerConfig: string;
  configPatch?: unknown;
  wranglerConfigInline?: unknown;
}

/** The longest `install.wildcardHostname.reason`. */
export const WILDCARD_REASON_MAX_LENGTH = 200;

/**
 * `install.wildcardHostname`: the app needs every name under one hostname
 * (`*.<base>`), not one exact hostname, and says why in one short sentence
 * shown where the admin assigns the base.
 */
export const catalogWildcardHostnameSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(1)
      .max(WILDCARD_REASON_MAX_LENGTH)
      .describe(
        "One short sentence, shown where the admin assigns the hostname, on why the app needs every " +
          'name under it, for example "Each tunnel gets its own address under this hostname." ' +
          `At most ${WILDCARD_REASON_MAX_LENGTH} characters.`,
      ),
  })
  .describe(
    "The app needs every name under one hostname (`*.<base>`) rather than one exact hostname, " +
      "for example a tunnel that gives each session a name of its own. The admin assigns the base " +
      "(`tunnels.example.com`) in one of the account's domains; the manager then serves the " +
      "primary Worker on the base and every name under it (a proxied wildcard DNS record and " +
      "Workers routes). Not for the self-deploying tier.",
  );
export type CatalogWildcardHostname = z.infer<typeof catalogWildcardHostnameSchema>;

/**
 * What is wrong with an entry's `wildcardHostname`; empty when nothing is. A
 * self-deploying entry's own installer decides where its Workers answer.
 */
export function wildcardHostnameProblems(install: {
  tier: InstallTier;
  wildcardHostname?: unknown;
}): Array<{ path: "wildcardHostname"; message: string }> {
  if (install.wildcardHostname === undefined || install.tier !== "self-deploying") return [];
  return [
    {
      path: "wildcardHostname",
      message:
        "install.wildcardHostname is not allowed for the self-deploying tier: the app's own installer decides where its Workers answer",
    },
  ];
}

/** How the packer builds and names the app. */
export const catalogInstallSchema = z
  .object({
    tier: installTierSchema
      .default("artifact")
      .describe(
        'How the app is built: `"artifact"` (the default: a signed release catalog CI builds), ' +
          '`"sandbox"` (built from the pinned commit in the account\'s sandbox Worker) or ' +
          '`"self-deploying"` (the app\'s own installer, run in the sandbox Worker).',
      ),
    packageManager: packageManagerSchema,
    wranglerConfig: z
      .string()
      .min(1)
      .describe(
        "The wrangler config to build from, relative to the repository root, for example " +
          "`wrangler.jsonc`. A config the repository keeps only as a template " +
          "(`wrangler.toml.example`, `wrangler.jsonc.template`) is copied to its real name " +
          "(`wrangler.toml`) before it is read.",
      ),
    /**
     * The Worker name the install form suggests; the installer may change it
     * unless `fixedWorkerName` is set. Omitted means the entry's slug; read
     * it with {@link catalogWorkerName}.
     */
    workerName: z
      .string()
      .min(1)
      .describe(
        "The Worker name the install form suggests; the admin may change it unless " +
          "`fixedWorkerName` is set. Defaults to the entry's `slug`.",
      )
      .optional(),
    /**
     * The app only works under `workerName` (for example, it hard-codes its own
     * hostname), so it installs at most once per account.
     */
    fixedWorkerName: z
      .boolean()
      .default(false)
      .describe(
        "The app only works under `workerName` (for example, it hard-codes its own hostname), " +
          "so it installs at most once per account.",
      ),
    /** How the manager checks that the app serves; see {@link catalogHealthSchema}. */
    health: catalogHealthSchema.default({ path: "/", mode: DEFAULT_HEALTH_MODE }),
    /**
     * The command, or the commands in order, the packer runs in the checkout
     * after installing dependencies and before bundling, for apps whose
     * wrangler config has no `build.command` (Vite, React Router, OpenNext).
     * Read it with {@link buildCommandList}.
     */
    buildCommand: z
      .union([
        singleBuildCommandSchema,
        z.array(singleBuildCommandSchema).min(1).max(MAX_BUILD_COMMANDS),
      ])
      .describe(
        "The command the packer runs at the root of the checkout after installing dependencies " +
          "(with install scripts disabled) and before bundling, for example " +
          "`pnpm --filter @scope/web build`, or a list of such commands run in order, for example " +
          '`["pnpm run build:sphere", "pnpm run build"]`; the build stops at the first that fails. ' +
          "Use it when the wrangler config has no `build.command`. Each runs as a plain command " +
          "without a shell, with no credentials in its environment and the checkout's " +
          "`node_modules/.bin` on its PATH, so pipes, redirects, quotes, variables, and environment " +
          "assignments are not allowed. pnpm and npm run no pre or post hooks of package scripts " +
          "there (`pnpm run build` skips `prebuild`), so list such a step as a command of its own. At " +
          `most ${MAX_BUILD_COMMANDS} commands of at most 256 characters each.`,
      )
      .optional(),
    /**
     * Build-time constants the packer sets in the environment of every build
     * command and of wrangler's bundling; see {@link buildEnvSchema}.
     * Refused on `self-deploying` entries, whose installer runs without the
     * packer.
     */
    buildEnv: buildEnvSchema
      .describe(
        "Public constants the build compiles into the app, by name, for example " +
          '`{ "VITE_API_ORIGIN": "https://api.example.com" }`: the packer sets them in the ' +
          "environment of every build command and of wrangler's bundling. Everyone can read them " +
          "(the catalog publishes them and the build writes them into downloadable files), so a " +
          "name that looks like a credential (containing SECRET, PASSWORD, PASSWD, PASSPHRASE, " +
          "TOKEN, PRIVATE or CREDENTIAL) is refused, and so is a name the build's tools " +
          "read: wrangler and what it runs (WRANGLER_, CLOUDFLARE_, CF_, ESBUILD_, MINIFLARE_, " +
          "WORKERD_), Node.js and package managers (NODE_, NPM_, PNPM_, YARN_, BUN_, COREPACK_, " +
          "DENO_), git and CI (GIT_, GITHUB_, RUNNER_, ACTIONS_, CI), shells (BASH*, ENV, IFS, " +
          "PS4, PROMPT_COMMAND and the like), the dynamic linker (LD_, DYLD_, GCONV*), TLS and " +
          "HTTP clients (SSL_, OPENSSL_, CURL_, *_PROXY), configuration directories (XDG_, HOME, " +
          "TMPDIR), other toolchains (PYTHON*, PERL5*, RUBY*, JAVA_, CARGO_, RUST*, GOPATH, GOFLAGS and the other Go settings), and " +
          "build tools (TURBO_, NX_, PRISMA_). Catalog review reads every constant as well. " +
          "Upper-case names, at most 32 constants. Not for the self-deploying tier.",
      )
      .optional(),
    /**
     * The directories whose dependencies the packer installs, in order; see
     * {@link catalogInstallDirsSchema}. Omitted means the root alone; read it
     * with `installDirList`. Refused on `self-deploying` entries, whose installer
     * runs without the packer. An entry of several Workers lists them once
     * for all its Workers.
     */
    installDirs: catalogInstallDirsSchema
      .describe(
        "The directories whose dependencies the packer installs, in order, each with install " +
          'scripts disabled, before any build command. Omitted means `[{ "path": "." }]`, the ' +
          "root of the checkout; list `.` as well when the root still needs its install. Use it " +
          "when the Worker's `package.json` sits in a directory of its own (a template " +
          `repository), or for a second install beside the root one. At most 8 directories. ` +
          "An empty list installs nothing, for a repository without a `package.json`: wrangler " +
          "bundles the entry and its relative imports, and any build command runs with no " +
          "dependencies installed. An entry of several Workers lists them once for all its Workers.",
      )
      .optional(),
    /**
     * Email the app receives through Email Routing; see
     * {@link catalogEmailRoutingSchema}. Refused on `self-deploying` entries: their own
     * installer deploys the app, and Appflare sets up no routing for it.
     */
    emailRouting: catalogEmailRoutingSchema.optional(),
    /**
     * The app needs every name under one hostname; see
     * {@link catalogWildcardHostnameSchema}. A `self-deploying` entry cannot
     * set it: its installer deploys the app and decides where it answers.
     */
    wildcardHostname: catalogWildcardHostnameSchema.optional(),
    /**
     * The size of a run in the sandbox Worker (a `sandbox` entry's build or a
     * `self-deploying` entry's installer); see {@link catalogContainerSchema}.
     * Refused on `artifact` entries, which never run in the user's account.
     */
    container: catalogContainerSchema.optional(),
    /**
     * Changes to the wrangler config the packer applies before wrangler reads
     * it; see {@link configPatchSchema}. An entry of several Workers sets it per Worker
     * instead, and a `self-deploying` entry cannot set it: its installer
     * runs without the packer.
     */
    configPatch: configPatchSchema.optional(),
    /**
     * The wrangler config of an app whose repository ships none; see
     * {@link wranglerConfigInlineSchema}. `wranglerConfig` then names where
     * the packer writes it (`.appflare.wrangler.jsonc`, in a directory of
     * the repository or at its root). Not beside `configPatch` (change the inline config
     * instead), nor beside `workers` (set it per Worker), nor on a
     * `self-deploying` entry, whose installer runs without the packer.
     */
    wranglerConfigInline: wranglerConfigInlineSchema
      .describe(
        "The wrangler config of an app whose repository ships none, which the packer writes as " +
          "`.appflare.wrangler.jsonc` where `wranglerConfig` names (for example " +
          "`.appflare.wrangler.jsonc`, or `server/.appflare.wrangler.jsonc`) and reads like any " +
          "other config. Not beside `configPatch` or `workers`. Prefer a pull request upstream " +
          "that adds a config, and link it in a comment beside this one.",
      )
      .optional(),
    /**
     * Toolchains beyond Node.js the build needs; see {@link CATALOG_TOOLCHAINS}.
     * The packer records them (the artifact carries the catalog manifest) and
     * installs nothing itself. Read it with {@link installToolchains}. Refused on
     * the tiers that build in the sandbox Worker, whose image has none.
     */
    toolchains: z
      .array(catalogToolchainSchema)
      .min(1)
      .max(CATALOG_TOOLCHAINS.length)
      .refine((list) => new Set(list).size === list.length, "a toolchain is listed twice")
      .describe(
        'Toolchains beyond Node.js the build needs. `"rust"`: catalog CI installs a pinned ' +
          "Rust toolchain with the `wasm32-unknown-unknown` target before installing and " +
          "building, for workers-rs apps (`worker-build`). Artifact tier only: the sandbox " +
          "image that builds sandbox and self-deploying entries in an account has no Rust.",
      )
      .optional(),
    // --- Self-deploying tier -------------------------------------------------
    /**
     * How the sandbox Worker runs the app's own installer; see
     * {@link catalogSelfDeployingSchema}. Required for, and only allowed for,
     * the `self-deploying` tier.
     */
    selfDeploying: catalogSelfDeployingSchema.optional(),
    // --- Several Workers -----------------------------------------------------
    /**
     * An app that installs as several Workers deployed together; see
     * {@link catalogEntryWorkerSchema}. Omitted for an app of one Worker
     * (`wranglerConfig`).
     */
    workers: z
      .array(catalogEntryWorkerSchema)
      .min(2)
      .max(
        MAX_ENTRY_WORKERS,
        `an entry installs at most ${MAX_ENTRY_WORKERS} Workers: one job installs or updates them all, within one Workflow's step and request limits`,
      )
      .describe(
        `For an app that installs as several Workers deployed together (for example an API and a web front end), 2 to ${MAX_ENTRY_WORKERS} of them: ` +
          "each Worker's name, wrangler config and optional build command. Exactly " +
          "one is `primary`: it answers the app's address and health check, and its " +
          "`wranglerConfig` is `install.wranglerConfig`. Service bindings between these Workers, " +
          "Durable Object bindings to a class in another of them, and Workflow bindings to a " +
          "Workflow another of them defines are pointed at the installed Workers; bindings of the " +
          "same name share one resource. Artifact tier only. On Workers Free a job for more " +
          "than three Workers can take longer: the manager waits 5 minutes whenever the job " +
          "needs a fresh allowance of the 50 requests Cloudflare gives it at a time.",
      )
      .optional(),
  })
  .superRefine((install, ctx) => {
    for (const problem of entryWorkersProblems(install)) {
      ctx.addIssue({ code: "custom", path: problem.path, message: problem.message });
    }
    if (install.container !== undefined && !runsInSandbox(install.tier)) {
      ctx.addIssue({
        code: "custom",
        path: ["container"],
        message: `install.container is only for the sandbox and self-deploying tiers, which run in the sandbox Worker; this entry's tier is ${install.tier}`,
      });
    }
    const problem = selfDeployingTierProblem(install);
    if (problem !== null) {
      ctx.addIssue({ code: "custom", path: [problem.path], message: problem.message });
    }
    if (install.installDirs !== undefined && install.tier === "self-deploying") {
      ctx.addIssue({
        code: "custom",
        path: ["installDirs"],
        message:
          "install.installDirs is not allowed for the self-deploying tier: its installer runs at the root of the checkout, without the packer that installs these directories",
      });
    }
    if (install.buildEnv !== undefined && install.tier === "self-deploying") {
      ctx.addIssue({
        code: "custom",
        path: ["buildEnv"],
        message:
          "install.buildEnv is not allowed for the self-deploying tier: its installer builds the app without the packer that sets these constants",
      });
    }
    if (install.configPatch !== undefined && install.tier === "self-deploying") {
      ctx.addIssue({
        code: "custom",
        path: ["configPatch"],
        message:
          "install.configPatch is not allowed for the self-deploying tier: its installer deploys the app without the packer that applies the patch",
      });
    }
    if (install.configPatch !== undefined && install.workers !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["configPatch"],
        message:
          "install.configPatch is for an app of one Worker; with install.workers, set configPatch on the Worker whose config it changes",
      });
    }
    for (const problem of wranglerConfigInlineProblems(install)) {
      ctx.addIssue({ code: "custom", path: problem.path, message: problem.message });
    }
    if (install.toolchains !== undefined && runsInSandbox(install.tier)) {
      ctx.addIssue({
        code: "custom",
        path: ["toolchains"],
        message: `install.toolchains (${install.toolchains.join(", ")}) is only for the artifact tier, which catalog CI builds with those toolchains installed; the sandbox image that builds ${install.tier} entries in an account has no ${install.toolchains.join(" or ")} toolchain`,
      });
    }
    if (install.emailRouting !== undefined && install.tier === "self-deploying") {
      ctx.addIssue({
        code: "custom",
        path: ["emailRouting"],
        message:
          "install.emailRouting is not allowed for the self-deploying tier: the app's own installer deploys it, and Appflare sets up no Email Routing for it",
      });
    }
    for (const problem of emailRoutingWorkerProblems(install)) {
      ctx.addIssue({ code: "custom", path: problem.path, message: problem.message });
    }
    for (const problem of wildcardHostnameProblems(install)) {
      ctx.addIssue({ code: "custom", path: [problem.path], message: problem.message });
    }
  })
  // The refinements do not reach the JSON Schema; `allOf` states them there
  // (no `container`, or a tier that runs in the sandbox Worker; `selfDeploying`
  // exactly when the tier is `self-deploying`; no `emailRouting` or
  // `installDirs` on a `self-deploying` entry; `emailRouting.worker` only
  // beside `workers`; `workers` and `toolchains`
  // only on the `artifact` tier; `configPatch` neither beside `workers` nor
  // on a `self-deploying` entry; `wranglerConfigInline` beside neither
  // `workers` nor `configPatch`, nor on a `self-deploying` entry), so editors
  // refuse the same manifests.
  .meta({
    allOf: [
      {
        anyOf: [
          { not: { required: ["container"] } },
          { required: ["tier"], properties: { tier: { enum: [...SANDBOX_RUN_TIERS] } } },
        ],
      },
      {
        anyOf: [
          {
            required: ["tier", "selfDeploying"],
            properties: { tier: { const: "self-deploying" } },
          },
          {
            not: { required: ["selfDeploying"] },
            properties: { tier: { not: { const: "self-deploying" } } },
          },
        ],
      },
      {
        anyOf: [
          { not: { required: ["emailRouting"] } },
          { properties: { tier: { not: { const: "self-deploying" } } } },
        ],
      },
      {
        anyOf: [
          { not: { required: ["installDirs"] } },
          { properties: { tier: { not: { const: "self-deploying" } } } },
        ],
      },
      {
        anyOf: [
          { not: { required: ["workers"] } },
          { properties: { tier: { const: "artifact" } } },
        ],
      },
      {
        anyOf: [
          { not: { required: ["configPatch"] } },
          {
            not: { required: ["workers"] },
            properties: { tier: { not: { const: "self-deploying" } } },
          },
        ],
      },
      {
        anyOf: [
          { not: { required: ["wranglerConfigInline"] } },
          {
            not: { anyOf: [{ required: ["workers"] }, { required: ["configPatch"] }] },
            properties: { tier: { not: { const: "self-deploying" } } },
          },
        ],
      },
      {
        anyOf: [
          { not: { required: ["toolchains"] } },
          { properties: { tier: { const: "artifact" } } },
        ],
      },
      // No wildcard hostname on a self-deploying entry.
      {
        anyOf: [
          { not: { required: ["wildcardHostname"] } },
          { properties: { tier: { not: { const: "self-deploying" } } } },
        ],
      },
      // No build-time constants on a self-deploying entry.
      {
        anyOf: [
          { not: { required: ["buildEnv"] } },
          { properties: { tier: { not: { const: "self-deploying" } } } },
        ],
      },
      // The Worker that receives mail is named only among install.workers.
      {
        anyOf: [
          { not: { required: ["emailRouting"] } },
          { properties: { emailRouting: { not: { required: ["worker"] } } } },
          { required: ["workers"] },
        ],
      },
    ],
  });
export type CatalogInstall = z.infer<typeof catalogInstallSchema>;

/** Whether the app needs every name under one hostname (`install.wildcardHostname`). */
export function needsWildcardHostname(install: Pick<CatalogInstall, "wildcardHostname">): boolean {
  return install.wildcardHostname !== undefined;
}

/** The Worker name the install form suggests: `install.workerName`, else the slug. */
export function catalogWorkerName(manifest: {
  slug: string;
  install: Pick<CatalogInstall, "workerName">;
}): string {
  return manifest.install.workerName ?? manifest.slug;
}

/** The app's public repository: `upstreamRepo`, else its build repository. */
export function catalogRepository(
  manifest: Pick<CatalogManifest, "repo" | "upstreamRepo">,
): string {
  return manifest.upstreamRepo ?? manifest.repo;
}

/** The app's homepage: `homepage`, else its public repository on GitHub. */
export function catalogHomepage(
  manifest: Pick<CatalogManifest, "homepage" | "repo" | "upstreamRepo">,
): string {
  return manifest.homepage ?? `https://github.com/${catalogRepository(manifest)}`;
}

/**
 * How the catalog's bump bot treats an entry when its upstream moves.
 *
 * The catalog checks that each upstream release builds, matches its hashes and
 * installs; it does not review upstream code, and each user decides whether to
 * update. The bot reads `autoMerge` from the file itself: left out or `true`,
 * a bump of an artifact tier entry that does not set `source.version` merges
 * itself (squash) once the required checks, the full install check included,
 * pass; `false` opts out, and a maintainer merges each bump. Sandbox and
 * self-deploying entries are never merged by the bot, since CI does not
 * install them, and may not set `true`.
 *
 * The parsed value defaults to `false` only so that released catalog
 * manifests keep their bytes; it does not mean the entry opts out.
 */
export const catalogBumpSchema = z
  .object({
    autoMerge: z
      .boolean()
      .default(false)
      .describe(
        "Whether the bump bot's pull request merges itself once the required checks, " +
          "including the install check, pass. Left out or `true`, it does for an artifact " +
          "tier entry that does not set `source.version`; the default of `false` shown here " +
          "only keeps released manifests as they were and does not opt out. Set `false` to " +
          "have a maintainer merge each bump, for example when upstream's releases often " +
          "break installs or need a migration guide. Sandbox and self-deploying entries are " +
          "never merged by the bot and may not set `true`.",
      ),
  })
  .describe(
    "How the catalog's bump bot treats this entry when its upstream moves. Left out, an " +
      "artifact tier entry's bumps merge themselves once their checks pass.",
  );
export type CatalogBump = z.infer<typeof catalogBumpSchema>;

/**
 * A GitHub user or organization login, without the leading `@`: letters,
 * digits, and single hyphens between them, at most 39 characters.
 */
export const githubLoginSchema = z
  .string()
  .regex(
    /^(?=.{1,39}$)[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/,
    "must be a GitHub username or organization, without @",
  );

/** An X (Twitter) handle, without the leading `@`: at most 15 letters, digits, or `_`. */
export const xHandleSchema = z
  .string()
  .regex(/^[A-Za-z0-9_]{1,15}$/, "must be an X handle without @: up to 15 letters, digits, or _");

/**
 * A person or organization that wrote the app upstream. Shown on the
 * catalog card (the name) and the app page (the name with its links). Not
 * the catalog entry's `maintainers`, who package the app for the catalog.
 */
export const catalogAuthorSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(100)
      .describe("The author's name as shown in the catalog, for example `Ben Senescu`."),
    url: z
      .url({ protocol: /^https$/, error: "must be an https:// URL" })
      .regex(/^https:\/\//, "must be an https:// URL")
      .describe("The author's website, as an https:// URL.")
      .optional(),
    github: githubLoginSchema
      .describe("The author's GitHub username or organization, without @.")
      .optional(),
    x: xHandleSchema.describe("The author's X (Twitter) handle, without @.").optional(),
  })
  .describe("A person or organization that wrote the app, with optional links.");
export type CatalogAuthor = z.infer<typeof catalogAuthorSchema>;

/**
 * The author a manifest without `authors` is listed with: the owner of its
 * upstream repository, linked to their GitHub profile.
 */
export function authorsFromRepo(repo: string): CatalogAuthor[] {
  const owner = repo.split("/")[0] ?? "";
  if (owner === "") return [];
  return githubLoginSchema.safeParse(owner).success
    ? [{ name: owner, github: owner }]
    : [{ name: owner }];
}

/** The app's authors: `authors` when the manifest lists them, else {@link authorsFromRepo}. */
export function catalogAuthors(
  manifest: Pick<CatalogManifest, "authors" | "repo" | "upstreamRepo">,
): CatalogAuthor[] {
  return manifest.authors ?? authorsFromRepo(catalogRepository(manifest));
}

/** A catalog manifest's first `revision`, and what an omitted one means. */
export const FIRST_CATALOG_REVISION = 1;

/**
 * A catalog manifest's `revision`: a whole number from 1. Raising it publishes
 * an edit of the entry's form or copy for the build its pin already released,
 * without a new build (see `revision.ts`).
 */
export const catalogRevisionSchema = z
  .int()
  .min(FIRST_CATALOG_REVISION)
  .max(1_000_000)
  .describe(
    "Which edit of this entry's form and copy the catalog publishes for the build its `source` " +
      "already released, starting at 1 (the default when omitted). Raise it by one to publish a " +
      "change to `name`, `summary`, `homepage`, `upstreamRepo`, `license`, `categories`, `maintainers`, " +
      '`secrets`, `vars`, `postInstall`, `bump`, `access` or `openPath`, or to add `"access"` to ' +
      "`requires`, without moving `source`: the released artifact stays as it is, and managers " +
      "show the new form without an update. `tagline`, `features`, `alternativeTo`, " +
      "`licenseNote` and `authors` need no revision: the catalog shows them from the current " +
      "manifest. Anything else needs a new build, so move `source` instead.",
  );

/**
 * A catalog slug, held to {@link CATALOG_SLUG_PATTERN} wherever it is read:
 * it becomes a Worker name, a folder and a page address, so a manifest or an
 * index row with any other slug could never be installed.
 */
export const catalogSlugSchema = z
  .string()
  .regex(
    CATALOG_SLUG_PATTERN,
    "must be lowercase letters, digits and dashes, starting with a letter or digit, at most 63 characters",
  );

/** The full catalog manifest, `appflare.jsonc`. */
export const catalogManifestSchema = z
  .object({
    $schema: z.url().optional(),
    slug: catalogSlugSchema.describe(
      "The entry's permanent id, in lowercase letters, digits and hyphens, for example " +
        "`open-seo`. It is also the entry's folder in the catalog, the first part of its release " +
        "tags (`<slug>@<version>`) and the Worker name the install form suggests. It never " +
        "changes once the entry is published.",
    ),
    name: z
      .string()
      .min(1)
      .describe("The app's name as the catalog and the manager show it, for example `Open SEO`."),
    summary: z
      .string()
      .min(1)
      .describe(
        "What the app does and who it is for, in a few plain sentences, shown on the app's page " +
          "(a blank line starts a new paragraph). The catalog search reads it too.",
      ),
    /** The one-line pitch on catalog tiles. */
    tagline: taglineSchema,
    /** What the app does for people, one line each, for the app's page. */
    features: appFeaturesSchema.optional(),
    /** Well-known products the app can replace, for the app's page. */
    alternativeTo: appAlternativesSchema.optional(),
    /**
     * Shown as a link in the manager; https only (the regex also lands in the
     * JSON Schema). Omitted means the repository on GitHub; read it with
     * {@link catalogHomepage}.
     */
    homepage: z
      .url({ protocol: /^https$/, error: "must be an https:// URL" })
      .regex(/^https:\/\//, "must be an https:// URL")
      .describe("The app's website, as an https:// URL. Defaults to its repository on GitHub.")
      .optional(),
    repo: ownerRepoSchema.describe(
      "The public GitHub repository the app is built from, as `owner/repo`. The source pin, " +
        "builds and version bumps always use this repository. Also shown as the app's source " +
        "code link unless `upstreamRepo` names its main project.",
    ),
    upstreamRepo: ownerRepoSchema
      .describe(
        "The app's main public GitHub repository, as `owner/repo`, when `repo` is a deployment " +
          "template or a fork. Used for source code links, GitHub stars, and the default " +
          "homepage and authors. Builds, source pins and version bumps still use `repo`.",
      )
      .optional(),
    license: licenseSchema,
    /** A short line shown next to the license. */
    licenseNote: licenseNoteSchema.optional(),
    categories: catalogCategoriesSchema,
    /**
     * Who wrote the app upstream, as the catalog shows them. The catalog
     * index lists the owner of its public repository when omitted ({@link catalogAuthors}).
     */
    authors: z
      .array(catalogAuthorSchema)
      .min(1)
      .describe(
        "Who wrote the app upstream: one or more people or organizations, shown on the catalog " +
          "card and the app's page. Not the people who package it for the catalog (those are " +
          "`maintainers`). When omitted, the catalog lists the owner of `upstreamRepo`, or " +
          "`repo` when no upstream repository is set.",
      )
      .optional(),
    /** GitHub users who package the app for the catalog; shown as "Packaged by". */
    maintainers: z
      .array(z.string().min(1))
      .default([])
      .describe(
        "The GitHub usernames, without @, of the people who package the app for the catalog and " +
          'look after this entry, shown as "Packaged by". Not the app\'s own authors (those are ' +
          "`authors`).",
      ),
    source: catalogSourceSchema,
    install: catalogInstallSchema,
    plan: planSchema.describe(
      'The Cloudflare Workers plan the app needs: `"free"` when it runs on Workers Free, ' +
        '`"paid"` when it needs Workers Paid. An entry with Pipelines must say `"paid"`.',
    ),
    requires: z
      .array(requirementSchema)
      .default([])
      .describe(
        'Account capabilities the app needs beyond the free Workers baseline. `"access"`: ' +
          "the app goes with Cloudflare Access. The account needs a Zero Trust organization " +
          'only while the app is protected (always, with `access.mode: "required"`), and the ' +
          "value keeps the entry away from managers too old to protect apps. Required with " +
          '`access.mode: "required"` and whenever a var\'s default uses an Access placeholder. ' +
          "Some values name a feature of Appflare instead, which keeps the entry away from " +
          'managers too old for it: `"secret-keys"` (a secret with a `key`), `"service-props"` ' +
          '(`props` on a service binding), `"config-patch-values"` (a config patch that sets var ' +
          'text or adds Workers AI), `"email-worker"` (`install.emailRouting.worker`), ' +
          '`"email-placeholders"` (`{{emailDomain}}` or `{{emailZoneId}}` anywhere, or any ' +
          "placeholder in an object key of a JSON var or of service binding `props`) and " +
          '`"hyperdrive-caching"` (`caching` on a Hyperdrive binding).',
      ),
    secrets: z.array(catalogSecretSchema).default([]),
    vars: z.array(catalogVarSchema).default([]),
    postInstall: z
      .array(postInstallStepSchema)
      .default([])
      .describe("Instructions shown after a successful install, in order."),
    tokenPermissions: tokenPermissionsSchema
      .default([])
      .describe(
        "The permissions of the Cloudflare API token the admin creates for the app itself " +
          "(never Appflare's own). The secret that takes the token sets `cloudflareToken: true`.",
      ),
    /**
     * Resource settings the wrangler config cannot express, such as a Vectorize
     * index's dimensions and metric.
     */
    resources: catalogResourcesSchema.optional(),
    /**
     * How the catalog's bump bot treats this entry. Left out, an artifact tier
     * entry's bumps merge themselves once their checks pass; the parsed default
     * only keeps released manifests' bytes (see {@link catalogBumpSchema}).
     */
    bump: catalogBumpSchema.default({ autoMerge: false }),
    /** Which edit of the entry's form and copy this is, for one build. */
    revision: catalogRevisionSchema.default(FIRST_CATALOG_REVISION),
    /**
     * How the app goes with Cloudflare Access (./access.ts). A manager from
     * before this field strips it, like any key it does not know.
     */
    access: catalogAccessSchema.optional(),
    /**
     * Where the manager's Open buttons take people in the app; see
     * {@link openPathSchema}. A manager from before this field strips it and
     * opens the root.
     */
    openPath: openPathSchema.optional(),
  })
  .superRefine((manifest, ctx) => {
    for (const problem of seedManifestProblems(manifest)) {
      ctx.addIssue({ code: "custom", path: problem.path, message: problem.message });
    }
    for (const problem of derivedSecretProblems(manifest.secrets)) {
      ctx.addIssue({
        code: "custom",
        path: ["secrets", ...problem.path],
        message: problem.message,
      });
    }
    for (const problem of multilineSecretProblems(manifest.secrets)) {
      ctx.addIssue({
        code: "custom",
        path: ["secrets", ...problem.path],
        message: problem.message,
      });
    }
    for (const problem of derivedVarProblems(manifest.secrets, manifest.vars)) {
      ctx.addIssue({ code: "custom", path: ["vars", ...problem.path], message: problem.message });
    }
    // A Worker cannot have a var and a secret of one name: Cloudflare refuses
    // the secret over the var, and an upload of the var replaces the secret.
    const secretNames = new Set(manifest.secrets.map((s) => s.name));
    manifest.vars.forEach((v, i) => {
      if (secretNames.has(v.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["vars", i, "name"],
          message: `${v.name} is declared both as a secret and as a var; a Worker cannot have a secret and a var of one name, so keep one of them`,
        });
      }
    });
    // `workers` on a secret or var names Workers of `install.workers`.
    const declared = manifest.install.workers;
    const names = new Set((declared ?? []).map((w) => w.name));
    const check = (
      field: "secrets" | "vars",
      items: ReadonlyArray<{ name: string; workers?: readonly string[] | undefined }>,
    ): void => {
      items.forEach((item, i) => {
        if (item.workers === undefined) return;
        if (declared === undefined) {
          ctx.addIssue({
            code: "custom",
            path: [field, i, "workers"],
            message: `${field}[${i}].workers is only for an entry that installs several Workers (install.workers)`,
          });
          return;
        }
        for (const name of item.workers) {
          if (!names.has(name)) {
            ctx.addIssue({
              code: "custom",
              path: [field, i, "workers"],
              message: `${item.name} names the Worker "${name}", which install.workers does not declare`,
            });
          }
        }
      });
    };
    check("secrets", manifest.secrets);
    check("vars", manifest.vars);
    // Placeholders a field does not take, that name a Worker the entry does
    // not have (or one with no address), or that need an entry receiving email.
    const entry = { workers: declared, emailRouting: manifest.install.emailRouting !== undefined };
    manifest.postInstall.forEach((step, i) => {
      for (const message of placeholderProblems(step.content, "postInstall", entry)) {
        ctx.addIssue({ code: "custom", path: ["postInstall", i, "content"], message });
      }
    });
    manifest.vars.forEach((v, i) => {
      if (v.default === undefined) return;
      for (const message of placeholderProblems(v.default, "varDefault", entry)) {
        ctx.addIssue({ code: "custom", path: ["vars", i, "default"], message });
      }
    });
    for (const problem of cloudflareTokenProblems(manifest)) {
      ctx.addIssue({ code: "custom", path: problem.path, message: problem.message });
    }
    for (const problem of accessRequirementProblems(manifest)) {
      ctx.addIssue({ code: "custom", path: problem.path, message: problem.message });
    }
  })
  .superRefine((manifest, ctx) => {
    for (const problem of pipelineManifestProblems(manifest)) {
      ctx.addIssue({ code: "custom", path: problem.path, message: problem.message });
    }
  })
  .superRefine((manifest, ctx) => {
    for (const problem of [
      ...secretKeyProblems(manifest),
      ...configPatchManifestProblems(manifest),
      ...managerFeatureProblems(manifest),
    ]) {
      ctx.addIssue({ code: "custom", path: problem.path, message: problem.message });
    }
  })
  .superRefine((manifest, ctx) => {
    if (manifest.install.tier !== "self-deploying") return;
    if (manifest.requires.includes("access")) {
      ctx.addIssue({
        code: "custom",
        path: ["requires"],
        message:
          'requires "access" is not allowed for the self-deploying tier: Appflare cannot protect an app whose own installer decides its Workers and addresses',
      });
    }
    if (manifest.access !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["access"],
        message:
          "access is not allowed for the self-deploying tier: the app's own installer decides its Workers and addresses, so Appflare cannot protect it with Cloudflare Access",
      });
    }
    if (manifest.resources?.hyperdrive !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["resources", "hyperdrive"],
        message:
          "resources.hyperdrive is not allowed for the self-deploying tier: the app's own installer creates its Hyperdrive configurations",
      });
    }
    if (manifest.resources?.d1 !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["resources", "d1"],
        message:
          "resources.d1 is not allowed for the self-deploying tier: the app's own installer sets up its databases",
      });
    }
    if (manifest.resources?.r2 !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["resources", "r2"],
        message:
          "resources.r2 is not allowed for the self-deploying tier: the app's own installer creates its buckets",
      });
    }
    const metadataIndexed = Object.values(manifest.resources?.vectorize ?? {}).some(
      (index) => index.metadataIndexes !== undefined,
    );
    if (metadataIndexed) {
      ctx.addIssue({
        code: "custom",
        path: ["resources", "vectorize"],
        message:
          "Vectorize metadataIndexes are not allowed for the self-deploying tier: the app's own installer creates its indexes",
      });
    }
    manifest.secrets.forEach((secret, i) => {
      if (isOptionalSecret(secret)) {
        ctx.addIssue({
          code: "custom",
          path: ["secrets", i, "optional"],
          message:
            "optional secrets are not allowed for the self-deploying tier: the app's own installer runs with every secret the manifest declares",
        });
      }
      if (isDerivedSecret(secret)) {
        ctx.addIssue({
          code: "custom",
          path: ["secrets", i, "derive"],
          message:
            "derived secrets are not allowed for the self-deploying tier: the app's own installer reads its secrets as entered",
        });
      }
      if (isSeedOnly(secret)) {
        ctx.addIssue({
          code: "custom",
          path: ["secrets", i, "seedOnly"],
          message:
            "seed-only secrets are not allowed for the self-deploying tier: the app's own installer sets up its databases",
        });
      }
      if (hasOwnSecretKey(secret)) {
        ctx.addIssue({
          code: "custom",
          path: ["secrets", i, "key"],
          message:
            "a secret key other than its name is not allowed for the self-deploying tier: the app's own installer reads its secrets by name",
        });
      }
    });
    manifest.vars.forEach((v, i) => {
      if (isDerivedVar(v)) {
        ctx.addIssue({
          code: "custom",
          path: ["vars", i, "derive"],
          message:
            "derived vars are not allowed for the self-deploying tier: the app's own installer reads its variables as entered",
        });
      }
      if (isSeedOnly(v)) {
        ctx.addIssue({
          code: "custom",
          path: ["vars", i, "seedOnly"],
          message:
            "seed-only vars are not allowed for the self-deploying tier: the app's own installer sets up its databases",
        });
      }
    });
  })
  // The refinements do not reach the JSON Schema; `allOf` states the
  // self-deploying ones there (no `access` block, no optional, derived or seed-only secrets, no
  // derived or seed-only vars, no Hyperdrive declarations, no D1 layout, no
  // Pipelines), and that Pipelines needs `plan: "paid"`. Whether a
  // `derive.from` names another secret, or a sink's `tokenSecret` names a
  // secret the install form asks for, cannot be said in JSON Schema.
  .meta({
    allOf: [
      {
        anyOf: [
          {
            properties: { install: { properties: { tier: { not: { const: "self-deploying" } } } } },
          },
          {
            not: {
              anyOf: [
                { required: ["access"] },
                {
                  required: ["requires"],
                  properties: { requires: { contains: { const: "access" } } },
                },
              ],
            },
          },
        ],
      },
      // `access.mode: "required"` needs `"access"` in `requires`.
      {
        anyOf: [
          {
            not: {
              required: ["access"],
              properties: {
                access: { required: ["mode"], properties: { mode: { const: "required" } } },
              },
            },
          },
          { required: ["requires"], properties: { requires: { contains: { const: "access" } } } },
        ],
      },
      // So does a var whose default uses an Access placeholder.
      {
        anyOf: [
          {
            not: {
              required: ["vars"],
              properties: {
                vars: {
                  contains: {
                    required: ["default"],
                    properties: { default: { type: "string", pattern: ACCESS_PLACEHOLDER_SOURCE } },
                  },
                },
              },
            },
          },
          { required: ["requires"], properties: { requires: { contains: { const: "access" } } } },
        ],
      },
      {
        anyOf: [
          {
            properties: { install: { properties: { tier: { not: { const: "self-deploying" } } } } },
          },
          { properties: { resources: { not: { required: ["pipelines"] } } } },
        ],
      },
      {
        anyOf: [
          { properties: { plan: { const: "paid" } } },
          { properties: { resources: { not: { required: ["pipelines"] } } } },
        ],
      },
      {
        anyOf: [
          {
            properties: { install: { properties: { tier: { not: { const: "self-deploying" } } } } },
          },
          { properties: { resources: { not: { required: ["hyperdrive"] } } } },
        ],
      },
      {
        anyOf: [
          {
            properties: { install: { properties: { tier: { not: { const: "self-deploying" } } } } },
          },
          { properties: { resources: { not: { required: ["d1"] } } } },
        ],
      },
      {
        anyOf: [
          {
            properties: { install: { properties: { tier: { not: { const: "self-deploying" } } } } },
          },
          { properties: { resources: { not: { required: ["r2"] } } } },
        ],
      },
      {
        anyOf: [
          {
            properties: { install: { properties: { tier: { not: { const: "self-deploying" } } } } },
          },
          {
            properties: {
              secrets: {
                items: {
                  not: {
                    anyOf: [
                      { required: ["optional"], properties: { optional: { const: true } } },
                      { required: ["derive"] },
                      { required: ["seedOnly"], properties: { seedOnly: { const: true } } },
                    ],
                  },
                },
              },
              vars: {
                items: {
                  not: {
                    anyOf: [
                      { required: ["derive"] },
                      { required: ["seedOnly"], properties: { seedOnly: { const: true } } },
                    ],
                  },
                },
              },
            },
          },
        ],
      },
    ],
  });
export type CatalogManifest = z.infer<typeof catalogManifestSchema>;

/**
 * What is wrong with an entry's `cloudflareToken` secret, one issue each with
 * its path from the manifest's root: at most one secret takes the app's
 * token, the admin enters it (not generated, derived or seed-only), and the
 * entry lists the permissions the token needs.
 */
/** The Workers a secret goes to, by name within the entry; null for every Worker. */
function secretWorkerSet(secret: { workers?: readonly string[] | undefined }): Set<string> | null {
  return secret.workers === undefined ? null : new Set(secret.workers);
}

/**
 * What is wrong with the keys and names of a manifest's secrets, one issue
 * each: keys are unique (a secret without one is known by its name); two
 * secrets may share a name only when each names the Workers it goes to and
 * no Worker gets both; a key other than the name needs
 * `"secret-keys"` in `requires`, which keeps the entry away from managers that
 * would store both values under the one name.
 */
export function secretKeyProblems(manifest: {
  secrets: ReadonlyArray<
    Pick<CatalogSecret, "name"> & {
      key?: string | undefined;
      workers?: readonly string[] | undefined;
      seedOnly?: boolean | undefined;
    }
  >;
  requires: readonly string[];
}): Array<{ path: Array<string | number>; message: string }> {
  const problems: Array<{ path: Array<string | number>; message: string }> = [];
  const byKey = new Map<string, number>();
  manifest.secrets.forEach((secret, i) => {
    const key = secretKey(secret);
    const first = byKey.get(key);
    if (first === undefined) {
      byKey.set(key, i);
    } else {
      problems.push({
        path: ["secrets", i, secret.key === undefined ? "name" : "key"],
        message: `two secrets are known by the key ${key} (secrets[${first}] and secrets[${i}]); give each its own key, which is its name when it has no key`,
      });
    }
  });
  manifest.secrets.forEach((secret, i) => {
    for (let j = 0; j < i; j++) {
      const other = manifest.secrets[j];
      if (other === undefined || other.name !== secret.name) continue;
      // Seed-only secrets reach no Worker, so they share a name with nothing.
      if (secret.seedOnly === true || other.seedOnly === true) continue;
      const mine = secretWorkerSet(secret);
      const theirs = secretWorkerSet(other);
      const shared =
        mine === null || theirs === null ? null : [...mine].filter((w) => theirs.has(w));
      if (shared === null) {
        problems.push({
          path: ["secrets", i, "workers"],
          message: `secrets[${j}] and secrets[${i}] are both named ${secret.name}; secrets of one name must each list the Workers that get them (workers), and no Worker may get both`,
        });
      } else if (shared.length > 0) {
        problems.push({
          path: ["secrets", i, "workers"],
          message: `secrets[${j}] and secrets[${i}] are both named ${secret.name} and both go to ${shared.map((w) => `"${w}"`).join(", ")}; a Worker has one value per name`,
        });
      }
    }
  });
  const keyed = manifest.secrets.findIndex(hasOwnSecretKey);
  if (keyed >= 0 && !manifest.requires.includes(SECRET_KEYS_REQUIREMENT)) {
    problems.push({
      path: ["requires"],
      message: `secrets[${keyed}] has a key other than its name, so requires must list "${SECRET_KEYS_REQUIREMENT}": a manager that does not know keys would set both values under one name`,
    });
  }
  return problems;
}

/**
 * What is wrong with what a manifest's config patches set, beyond each
 * patch's own shape (./config-patch.ts), one issue each: a var a patch sets
 * may hold only the placeholders a var's default takes, must not have the
 * name of a secret its Worker gets (Cloudflare keeps one binding per name),
 * nor of a catalog var that goes to that Worker (which would replace it
 * unseen); var text or an `ai` binding needs `"config-patch-values"` in
 * `requires`, since an older manager's config patch rules refuse both;
 * `props` on a service binding needs `"service-props"`, and its strings hold
 * the same placeholders.
 */
export function configPatchManifestProblems(manifest: {
  install: {
    emailRouting?: unknown;
    configPatch?: ConfigPatch | undefined;
    workers?:
      | ReadonlyArray<{
          name: string;
          workersDev: boolean;
          configPatch?: ConfigPatch | undefined;
        }>
      | undefined;
  };
  secrets: ReadonlyArray<{
    name: string;
    workers?: readonly string[] | undefined;
    seedOnly?: boolean | undefined;
  }>;
  vars?: ReadonlyArray<{ name: string; workers?: readonly string[] | undefined }>;
  requires: readonly string[];
}): Array<{ path: Array<string | number>; message: string }> {
  const problems: Array<{ path: Array<string | number>; message: string }> = [];
  const declared = manifest.install.workers;
  // Whether something scoped to `workers` goes to the Worker `worker` (null:
  // the only Worker of an entry of one, which gets everything).
  const reaches = (workers: readonly string[] | undefined, worker: string | null) =>
    worker === null ? workers === undefined : workers === undefined || workers.includes(worker);
  const entry = { workers: declared, emailRouting: manifest.install.emailRouting !== undefined };
  const patches: Array<{
    path: Array<string | number>;
    worker: string | null;
    patch: ConfigPatch;
  }> = [];
  if (manifest.install.configPatch !== undefined) {
    patches.push({
      path: ["install", "configPatch"],
      worker: null,
      patch: manifest.install.configPatch,
    });
  }
  (declared ?? []).forEach((w, i) => {
    if (w.configPatch !== undefined) {
      patches.push({
        path: ["install", "workers", i, "configPatch"],
        worker: w.name,
        patch: w.configPatch,
      });
    }
  });
  let propsAt: Array<string | number> | null = null;
  let valuesAt: Array<string | number> | null = null;
  for (const { path, worker, patch } of patches) {
    if (patch.ai !== undefined) valuesAt ??= [...path, "ai"];
    for (const [name, value] of Object.entries(patch.vars ?? {})) {
      if (value === null) continue;
      valuesAt ??= [...path, "vars", name];
      for (const message of placeholderProblems(value, "varDefault", entry)) {
        problems.push({ path: [...path, "vars", name], message });
      }
      const secret = manifest.secrets.find(
        (s) => s.name === name && s.seedOnly !== true && reaches(s.workers, worker),
      );
      if (secret !== undefined) {
        problems.push({
          path: [...path, "vars", name],
          message: `the patch sets the var ${name}, which is also a secret this Worker gets; a Worker cannot have a secret and a var of one name`,
        });
      }
      if ((manifest.vars ?? []).some((v) => v.name === name && reaches(v.workers, worker))) {
        problems.push({
          path: [...path, "vars", name],
          message: `the patch sets the var ${name}, which a catalog var of that name going to this Worker would replace; set it in one place, or give the catalog var workers that leave this Worker out`,
        });
      }
    }
    (patch.services ?? []).forEach((service, i) => {
      if (service.props === undefined) return;
      propsAt ??= [...path, "services", i, "props"];
      const texts = new Set(jsonTexts(service.props));
      for (const text of texts) {
        for (const message of placeholderProblems(text, "varDefault", entry)) {
          problems.push({ path: [...path, "services", i, "props"], message });
        }
      }
    });
  }
  if (valuesAt !== null && !manifest.requires.includes(CONFIG_PATCH_VALUES_REQUIREMENT)) {
    problems.push({
      path: ["requires"],
      message: `a config patch sets var text or a Workers AI binding (${formatPath(valuesAt)}), so requires must list "${CONFIG_PATCH_VALUES_REQUIREMENT}": a manager that predates them refuses the patch`,
    });
  }
  if (propsAt !== null && !manifest.requires.includes(SERVICE_PROPS_REQUIREMENT)) {
    problems.push({
      path: ["requires"],
      message: `a config patch gives a service binding props, so requires must list "${SERVICE_PROPS_REQUIREMENT}": a manager that does not know props refuses the binding`,
    });
  }
  return problems;
}

/** The config patches of an entry, each with its path from the manifest's root. */
function configPatchesOf(install: {
  configPatch?: ConfigPatch | undefined;
  workers?: ReadonlyArray<{ configPatch?: ConfigPatch | undefined }> | undefined;
}): Array<{ path: Array<string | number>; patch: ConfigPatch }> {
  const patches: Array<{ path: Array<string | number>; patch: ConfigPatch }> = [];
  if (install.configPatch !== undefined) {
    patches.push({ path: ["install", "configPatch"], patch: install.configPatch });
  }
  (install.workers ?? []).forEach((w, i) => {
    if (w.configPatch !== undefined) {
      patches.push({ path: ["install", "workers", i, "configPatch"], patch: w.configPatch });
    }
  });
  return patches;
}

/**
 * Where a manifest's own text uses `{{emailDomain}}` or `{{emailZoneId}}`: a
 * var's default, a post-install note, a var a config patch sets, or the props
 * of a service binding a patch adds. Null when nowhere. (The wrangler
 * config's own vars are the artifact's; its schema checks them.)
 */
function emailPlaceholderUse(manifest: {
  install: {
    configPatch?: ConfigPatch | undefined;
    workers?: ReadonlyArray<{ configPatch?: ConfigPatch | undefined }> | undefined;
  };
  vars: ReadonlyArray<{ default?: string | undefined }>;
  postInstall: ReadonlyArray<{ content: string }>;
}): Array<string | number> | null {
  const v = manifest.vars.findIndex(
    (x) => x.default !== undefined && usesEmailPlaceholders(x.default),
  );
  if (v >= 0) return ["vars", v, "default"];
  const note = manifest.postInstall.findIndex((p) => usesEmailPlaceholders(p.content));
  if (note >= 0) return ["postInstall", note, "content"];
  for (const { path, patch } of configPatchesOf(manifest.install)) {
    for (const [name, value] of Object.entries(patch.vars ?? {})) {
      if (value !== null && usesEmailPlaceholders(value)) return [...path, "vars", name];
    }
    const service = (patch.services ?? []).findIndex(
      (svc) => svc.props !== undefined && jsonTexts(svc.props).some(usesEmailPlaceholders),
    );
    if (service >= 0) return [...path, "services", service, "props"];
  }
  return null;
}

/**
 * Where a config patch gives a service binding props with a placeholder in
 * an object key. Null when none does. (The wrangler config's own vars and
 * props, and the defaults of JSON vars, are the artifact's; its schema
 * checks them.)
 */
function jsonKeyPlaceholderUse(manifest: {
  install: {
    configPatch?: ConfigPatch | undefined;
    workers?: ReadonlyArray<{ configPatch?: ConfigPatch | undefined }> | undefined;
  };
}): Array<string | number> | null {
  for (const { path, patch } of configPatchesOf(manifest.install)) {
    const service = (patch.services ?? []).findIndex(
      (svc) => svc.props !== undefined && placeholderInJsonKey(svc.props),
    );
    if (service >= 0) return [...path, "services", service, "props"];
  }
  return null;
}

/**
 * Which manager features (./manager-features.ts) a manifest uses without
 * listing them in `requires`, one issue each: `install.emailRouting.worker`
 * needs `"email-worker"`, `{{emailDomain}}` or `{{emailZoneId}}` in the
 * manifest's text, or any placeholder in an object key of a service
 * binding's props, needs `"email-placeholders"`, and `caching` on a Hyperdrive
 * binding needs `"hyperdrive-caching"`. An older manager would drop each one
 * without a word (routing mail to the primary Worker, leaving the
 * placeholder as written, creating the configuration with query caching
 * on); the requirement keeps the entry away from it instead.
 */
export function managerFeatureProblems(manifest: {
  install: {
    emailRouting?: { worker?: string | undefined } | undefined;
    configPatch?: ConfigPatch | undefined;
    workers?: ReadonlyArray<{ configPatch?: ConfigPatch | undefined }> | undefined;
  };
  vars: ReadonlyArray<{ default?: string | undefined }>;
  postInstall: ReadonlyArray<{ content: string }>;
  resources?:
    | { hyperdrive?: Readonly<Record<string, { caching?: boolean | undefined }>> | undefined }
    | undefined;
  requires: readonly string[];
}): Array<{ path: Array<string | number>; message: string }> {
  const problems: Array<{ path: Array<string | number>; message: string }> = [];
  if (
    manifest.install.emailRouting?.worker !== undefined &&
    !manifest.requires.includes(EMAIL_WORKER_REQUIREMENT)
  ) {
    problems.push({
      path: ["requires"],
      message: `install.emailRouting.worker names the Worker that receives mail, so requires must list "${EMAIL_WORKER_REQUIREMENT}": a manager that does not know it would route the mail to the primary Worker`,
    });
  }
  const used = emailPlaceholderUse(manifest);
  if (used !== null && !manifest.requires.includes(EMAIL_PLACEHOLDERS_REQUIREMENT)) {
    problems.push({
      path: ["requires"],
      message: `${formatPath(used)} uses {{emailDomain}} or {{emailZoneId}}, so requires must list "${EMAIL_PLACEHOLDERS_REQUIREMENT}": a manager that does not fill them in would leave them as written`,
    });
  }
  const keyed = jsonKeyPlaceholderUse(manifest);
  if (keyed !== null && !manifest.requires.includes(EMAIL_PLACEHOLDERS_REQUIREMENT)) {
    problems.push({
      path: ["requires"],
      message: `${formatPath(keyed)} has a placeholder in an object key, so requires must list "${EMAIL_PLACEHOLDERS_REQUIREMENT}": a manager that fills placeholders in values only would leave the key as written`,
    });
  }
  const cached = Object.entries(manifest.resources?.hyperdrive ?? {}).find(
    ([, decl]) => decl.caching !== undefined,
  );
  if (cached !== undefined && !manifest.requires.includes(HYPERDRIVE_CACHING_REQUIREMENT)) {
    problems.push({
      path: ["requires"],
      message: `resources.hyperdrive.${cached[0]} sets caching, so requires must list "${HYPERDRIVE_CACHING_REQUIREMENT}": a manager that does not know it would create the configuration with query caching on`,
    });
  }
  return problems;
}

export function cloudflareTokenProblems(manifest: {
  secrets: ReadonlyArray<
    Pick<CatalogSecret, "name" | "generate" | "derive"> & {
      cloudflareToken?: boolean | undefined;
      seedOnly?: boolean | undefined;
    }
  >;
  tokenPermissions: CatalogManifest["tokenPermissions"];
  resources?: Pick<NonNullable<CatalogManifest["resources"]>, "pipelines"> | undefined;
}): Array<{ path: Array<string | number>; message: string }> {
  const problems: Array<{ path: Array<string | number>; message: string }> = [];
  const flagged = manifest.secrets.flatMap((s, i) => (s.cloudflareToken === true ? [i] : []));
  for (const i of flagged.slice(1)) {
    problems.push({
      path: ["secrets", i, "cloudflareToken"],
      message: `only one secret takes the app's Cloudflare API token; ${manifest.secrets[flagged[0] ?? 0]?.name} already does`,
    });
  }
  for (const i of flagged) {
    const secret = manifest.secrets[i];
    if (secret === undefined) continue;
    if (secret.generate !== undefined || secret.derive !== undefined || secret.seedOnly === true) {
      problems.push({
        path: ["secrets", i, "cloudflareToken"],
        message: `${secret.name} takes the app's Cloudflare API token, which the admin creates and enters; it cannot be generated, derived or seed-only`,
      });
    }
  }
  if (flagged.length > 0 && appTokenPermissions(manifest).length === 0) {
    problems.push({
      path: ["secrets", flagged[0] ?? 0, "cloudflareToken"],
      message:
        "a secret takes the app's Cloudflare API token, but tokenPermissions lists no permission for that token",
    });
  }
  return problems;
}

/**
 * Fields of catalog manifests written before this version, where each went.
 * A path part of `null` stands for any index or key. The strict schemas name
 * the new field instead of asking to check the spelling.
 */
const RENAMED_FIELDS: ReadonlyArray<{
  path: ReadonlyArray<string | null>;
  message: (at: string) => string;
}> = [
  {
    path: ["vars", null, "required"],
    message: (at) =>
      `${at} was removed: every var needs a value (typed, or its default) unless it sets "optional": true`,
  },
  { path: ["install", "healthPath"], message: (at) => `${at} is now install.health.path` },
  {
    path: ["install", "healthMode"],
    message: (at) =>
      `${at} is now install.health.mode, whose values are "${HEALTH_MODES.join('" and "')}" ("status-only" became "any-response")`,
  },
  {
    path: ["install", "wildcardReason"],
    message: (at) => `${at} is now install.wildcardHostname: { "reason": "..." }`,
  },
  { path: ["install", "sandbox"], message: (at) => `${at} is now install.container` },
  { path: ["install", "version"], message: (at) => `${at} is now source.version` },
  {
    path: ["resources", "d1", null, "migrations"],
    message: (at) =>
      `${at} is now migrationsGlob (a glob); a folder of migrations is migrationsDir`,
  },
  {
    path: ["install", "selfDeploying", "workers"],
    message: (at) => `${at} is now install.selfDeploying.workerNames`,
  },
  {
    path: ["install", "selfDeploying", "stateStore"],
    message: (at) => `${at} was removed: the installer always keeps its state in the account`,
  },
  {
    path: ["install", "selfDeploying", "stageArg"],
    message: (at) =>
      `${at} was removed: the sandbox Worker always passes the tool's own stage option`,
  },
  {
    path: ["tokenPermissions", null, "description"],
    message: (at) => `${at} is now reason`,
  },
  {
    path: ["tokenPermissions", null, "name"],
    message: (at) =>
      `${at} was replaced by group, scope and access, for example { "group": "DNS", "scope": "zone", "access": "edit" }`,
  },
];

/** What the strict schemas say about an unknown key: where a renamed field went, or null. */
function renamedFieldMessage(path: ReadonlyArray<string | number>): string | null {
  const renamed = RENAMED_FIELDS.find(
    (r) =>
      r.path.length === path.length && r.path.every((part, i) => part === null || part === path[i]),
  );
  return renamed === undefined ? null : renamed.message(formatPath(path));
}

/**
 * What the strict schemas check beyond the lenient one, from the manifest as
 * written: `license` by {@link catalogLicenseProblem}, `categories` against
 * the fixed list, and each `tokenPermissions[].group` against its scope's
 * groups. A value of the wrong shape is the lenient schema's problem,
 * reported once.
 */
function authoringProblems(input: unknown, repositoryBuild: boolean): StrictProblem[] {
  if (typeof input !== "object" || input === null) return [];
  const manifest = input as { license?: unknown; categories?: unknown; tokenPermissions?: unknown };
  const problems: StrictProblem[] = [];
  const license = manifest.license;
  if (typeof license === "string" && licenseProblem(license) === null) {
    const problem = catalogLicenseProblem(license, { repositoryBuild });
    if (problem !== null) problems.push({ path: ["license"], message: `license ${problem}` });
  }
  for (const problem of catalogCategoryProblems(manifest.categories)) {
    problems.push({ path: ["categories", ...problem.path], message: problem.message });
  }
  for (const problem of tokenPermissionGroupProblems(manifest.tokenPermissions)) {
    problems.push({ path: ["tokenPermissions", ...problem.path], message: problem.message });
  }
  return problems;
}

/**
 * The catalog manifest as the tools that write it check it: the packer, the
 * catalog checks and the CLI. It refuses every key {@link catalogManifestSchema}
 * would strip (a misspelled field, or one that was renamed, whose message
 * names the new field), holds `categories` to `CATALOG_CATEGORIES` and
 * `tokenPermissions[].group` to `APP_TOKEN_PERMISSION_GROUPS`, and holds
 * `license` to {@link catalogLicenseProblem}: SPDX ids of the current list, no
 * `NOASSERTION` or `SEE LICENSE IN`, which only the manifest Appflare writes
 * for a repository build carries ({@link strictRepositoryBuildManifestSchema}).
 * Managers read manifests with {@link catalogManifestSchema}, which strips
 * unknown keys and takes any category or group name, so a manifest written
 * for a later version still reads.
 */
export const strictCatalogManifestSchema = strictSchema(
  catalogManifestSchema,
  (input) => authoringProblems(input, false),
  renamedFieldMessage,
);

/**
 * {@link strictCatalogManifestSchema} for the manifest Appflare writes for an
 * app built from a repository without a catalog entry: the same checks, but
 * `license` may also be `NOASSERTION` (the repository states none) or
 * `SEE LICENSE IN <file>`, as its `package.json` says.
 */
export const strictRepositoryBuildManifestSchema = strictSchema(
  catalogManifestSchema,
  (input) => authoringProblems(input, true),
  renamedFieldMessage,
);
