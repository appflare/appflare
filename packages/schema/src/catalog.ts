import { z } from "zod";
// With its extension: the JSON Schema export runs this file directly under
// Node's type stripping, which resolves relative imports literally.
import { catalogSelfDeployingSchema, selfDeployingTierProblem } from "./self-deploying.ts";

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
 * Rules for a catalog manifest's `install.buildCommand`: a single command the
 * packer runs as a plain argv, without a shell. Anything a shell would
 * interpret (pipes, redirects, quotes, variables, globs, command separators,
 * environment assignments) is refused rather than passed through literally,
 * so what the manifest says is exactly what runs.
 */

/** The longest build command a manifest may declare. */
export const MAX_BUILD_COMMAND_LENGTH = 256;

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

/**
 * How an app is built: `artifact` (a signed release catalog CI built),
 * `sandbox` (built from its pinned commit in the account's sandbox Worker),
 * or `self-deploying` (the app's own installer, run in the sandbox Worker).
 */
export const installTierSchema = z.enum(["artifact", "sandbox", "self-deploying"]);
export type InstallTier = z.infer<typeof installTierSchema>;

/** Package manager the packer uses to build the app from its checkout. */
export const packageManagerSchema = z.enum(["pnpm", "npm", "yarn", "bun"]);
export type PackageManager = z.infer<typeof packageManagerSchema>;

/** Free vs paid plan requirement. */
export const planSchema = z.enum(["free", "paid"]);
export type Plan = z.infer<typeof planSchema>;

/** Account capability an app needs beyond the free Workers baseline. */
export const requirementSchema = z.enum([
  "r2",
  "zone",
  "email-routing",
  "workers-ai",
  "browser-rendering",
  "containers",
]);
export type Requirement = z.infer<typeof requirementSchema>;

/**
 * A secret the installer prompts for. `generate: true` means the manager mints a
 * random value instead of asking the user. Defaults are seeded by catalog CI from
 * `.dev.vars.example` when the manifest omits them.
 *
 * `optional: true` marks a secret the app works without: the install form
 * leaves it unset unless the admin chooses to set it, updates never ask for
 * it, and the app's settings can remove it. Optional rather than defaulted so
 * manifests and artifacts written before the field existed keep the same
 * parsed shape (catalog CI compares a published release's manifest with the
 * current one field by field). Refused on `self-deploying` entries, whose
 * installer run expects every declared secret ({@link catalogManifestSchema}).
 */
export const catalogSecretSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  help: z.string().optional(),
  generate: z.boolean().default(false),
  optional: z
    .boolean()
    .describe(
      "The app works without this secret. The install form leaves it unset unless the admin " +
        'chooses "Set now", updates never ask for it, and the app\'s settings can remove it. ' +
        "Not allowed on self-deploying entries.",
    )
    .optional(),
});
export type CatalogSecret = z.infer<typeof catalogSecretSchema>;

/** Whether the app works without the secret (`optional: true`). */
export function isOptionalSecret(secret: Pick<CatalogSecret, "optional">): boolean {
  return secret.optional === true;
}

/**
 * Placeholders the manager fills in with the install's own values: in
 * `postInstall` markdown, in `vars[].default`, and in the values of the
 * wrangler config's `vars` (strings, and strings inside JSON values).
 *
 * - `{{workerUrl}}`: the install's workers.dev URL,
 *   `https://<worker name>.<account subdomain>.workers.dev`, without a
 *   trailing slash. Always the workers.dev address, even when a custom
 *   domain is attached to the install.
 * - `{{workerName}}`: the install's Worker name.
 *
 * Vars are rendered on every install and update, so they follow the Worker
 * name the admin chose. Whitespace inside the braces is allowed
 * (`{{ workerUrl }}`); anything else in double braces is left as written.
 */
export const INSTALL_PLACEHOLDERS = ["workerUrl", "workerName"] as const;
export type InstallPlaceholder = (typeof INSTALL_PLACEHOLDERS)[number];

/** The values {@link renderPlaceholders} fills in. */
export interface PlaceholderValues {
  /** Null while the account's workers.dev subdomain is unknown; `{{workerUrl}}` is then kept. */
  workerUrl: string | null;
  workerName: string;
}

const PLACEHOLDER_PATTERN = /\{\{\s*(workerUrl|workerName)\s*\}\}/g;

/** Whether `text` holds a placeholder the manager fills in. */
export function hasPlaceholder(text: string): boolean {
  return new RegExp(PLACEHOLDER_PATTERN.source).test(text);
}

/** `text` with every {@link INSTALL_PLACEHOLDERS} entry filled in. */
export function renderPlaceholders(text: string, values: PlaceholderValues): string {
  return text.replace(PLACEHOLDER_PATTERN, (match, key: string) => {
    if (key === "workerName") return values.workerName;
    return values.workerUrl ?? match;
  });
}

/** A JSON value: what a wrangler config var holds when it is not a string. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * `value` with placeholders filled in inside every string it holds (keys
 * excepted). Every key is copied as an own property, `__proto__` included,
 * so the value round-trips through `JSON.stringify` unchanged.
 */
export function renderJsonPlaceholders(value: JsonValue, values: PlaceholderValues): JsonValue {
  if (typeof value === "string") return renderPlaceholders(value, values);
  if (Array.isArray(value)) return value.map((item) => renderJsonPlaceholders(item, values));
  if (value !== null && typeof value === "object") {
    const out: { [key: string]: JsonValue } = {};
    for (const [key, item] of Object.entries(value)) {
      // Plain assignment of `__proto__` would set the prototype instead.
      Object.defineProperty(out, key, {
        value: renderJsonPlaceholders(item, values),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}

/**
 * A plain (non-secret) var the install form asks for. It reaches the Worker
 * as a `plain_text` binding, or as a `json` binding when the app's wrangler
 * config gives the var a value that is not a string (an array, object,
 * number, or boolean): the form then takes JSON and `default` must be JSON
 * text. `default` may hold `{{workerUrl}}` and `{{workerName}}`
 * ({@link INSTALL_PLACEHOLDERS}).
 *
 * `type: "select"` with `options` limits the var to a fixed set of values,
 * shown as choices instead of a text field; `default`, when given, must be one
 * of them. `type` and `options` are optional rather than defaulted so
 * manifests and artifacts written before they existed keep the same parsed
 * shape.
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
  type?: CatalogVarType | undefined;
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
    name: z.string().min(1),
    label: z.string().min(1),
    help: z.string().optional(),
    default: z
      .string()
      .describe(
        "Value the form starts with. `{{workerUrl}}` becomes the install's workers.dev URL " +
          "(`https://<worker name>.<account subdomain>.workers.dev`, no trailing slash) and " +
          "`{{workerName}}` its Worker name, filled in on every install and update. `{{workerUrl}}` is " +
          "always the workers.dev address, even when a custom domain is attached. When the app's " +
          "wrangler config gives this var a value that is not a string (an array, object, number, or " +
          "boolean), the var reaches the Worker as JSON and `default` must be JSON text, for " +
          'example `["{{workerUrl}}"]`. Without `default`, the form starts with the wrangler config\'s value. ' +
          'For a `type: "select"` var, `default` must be one of the `options` values.',
      )
      .optional(),
    required: z.boolean().default(false),
    type: z
      .enum(CATALOG_VAR_TYPES)
      .describe(
        '`"text"` (the default) takes any value; `"select"` takes one of `options`, shown as ' +
          "choices (cards for up to 4, a dropdown beyond).",
      )
      .optional(),
    options: z
      .array(catalogVarOptionSchema)
      .min(2)
      .max(MAX_VAR_OPTIONS)
      .describe(
        'The values a `type: "select"` var can take, in the order the form shows them. Required ' +
          "for, and only allowed with, `select`. Values must be distinct.",
      )
      .optional(),
  })
  .superRefine((v, ctx) => {
    for (const problem of selectVarProblems(v)) {
      ctx.addIssue({ code: "custom", path: problem.path, message: problem.message });
    }
  })
  // The refinements do not reach the JSON Schema; `allOf` states the pairing
  // of `type: "select"` and `options` there, so editors refuse the same vars.
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
    ],
  });
export type CatalogVar = z.infer<typeof catalogVarSchema>;

/** The choices of a `type: "select"` var; null for any other var. */
export function catalogVarOptions(
  v: Pick<CatalogVar, "type" | "options">,
): CatalogVarOption[] | null {
  return v.type === "select" && v.options !== undefined ? v.options : null;
}

/**
 * A post-install instruction rendered after a successful install, with
 * {@link INSTALL_PLACEHOLDERS} filled in.
 */
export const postInstallStepSchema = z.object({
  type: z.enum(["markdown"]),
  content: z.string().min(1),
});
export type PostInstallStep = z.infer<typeof postInstallStepSchema>;

/**
 * A Cloudflare API-token permission an app needs for ITS OWN token (never the
 * manager's). Shown to the user so they can mint a scoped token at
 * install time. Kept descriptive rather than tied to Cloudflare's internal
 * permission-group ids, which can be added later if the UI needs them.
 */
export const tokenPermissionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  scope: z.enum(["account", "zone", "user"]).optional(),
});
export type TokenPermission = z.infer<typeof tokenPermissionSchema>;

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

/**
 * Settings for resources the app's wrangler config binds but cannot fully
 * describe. `vectorize` is keyed by binding name and must cover every
 * Vectorize binding in the wrangler config; the packer refuses one without it.
 */
export const catalogResourcesSchema = z.object({
  vectorize: z.record(z.string().min(1), vectorizeIndexConfigSchema).optional(),
});
export type CatalogResources = z.infer<typeof catalogResourcesSchema>;

/** The pinned upstream source a version is built from; the bump bot edits it. */
export const catalogSourceSchema = z.object({
  ref: z.string().min(1),
  sha: gitShaSchema,
});
export type CatalogSource = z.infer<typeof catalogSourceSchema>;

/**
 * How the health check after an install, update, or rollback reads the
 * Worker's answer.
 *
 * - `default`: a redirect or a 4xx counts as verified (the Worker answered),
 *   a server error (5xx) as unhealthy.
 * - `status-only`: any answer the Worker itself gives counts as verified,
 *   server errors included, because an app behind Cloudflare Access or its
 *   own sign-in answers every unauthenticated request with a redirect, 401,
 *   403, or an error of its own. Connection failures and Cloudflare's own
 *   error pages (`error code: 1042` while the route goes live, or a Worker
 *   that crashed) are still retried or reported as before.
 */
export const healthModeSchema = z
  .enum(["default", "status-only"])
  .describe(
    'How the health check reads the Worker\'s answer. `"default"` counts redirects and 4xx ' +
      'answers as verified and server errors (5xx) as unhealthy. `"status-only"` counts any ' +
      "answer from the Worker itself as verified, server errors included: use it for apps whose " +
      "health path sits behind Cloudflare Access or the app's own sign-in. Either way, " +
      "connection failures and Cloudflare's error pages (such as `error code: 1042` while the " +
      'route goes live) are retried. Defaults to `"default"`.',
  );
export type HealthMode = z.infer<typeof healthModeSchema>;
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
 * with `catchAll` points the zone's catch-all rule at the app's Worker. The
 * app's Worker must export an `email` handler. Uninstalling removes the
 * rules, puts the catch-all back as it was, and turns Email Routing off again
 * only when the install turned it on and no other rule remains.
 */
export const catalogEmailRoutingSchema = z
  .object({
    catchAll: z
      .boolean()
      .describe(
        "Send every address of the zone that no other rule matches to the app (the zone's " +
          "catch-all rule). The install refuses when the catch-all already sends mail somewhere else.",
      )
      .optional(),
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
      .optional(),
  })
  .refine((v) => v.catchAll === true || (v.rules?.length ?? 0) > 0, {
    message: "set catchAll to true or list at least one address in rules",
  })
  .refine((v) => new Set(v.rules ?? []).size === (v.rules?.length ?? 0), {
    message: "rules must not list an address twice",
    path: ["rules"],
  })
  // The refinements do not reach the JSON Schema; `anyOf` states the first one
  // there, so editors refuse `{}` as the parser does.
  .meta({
    description:
      "Email the app receives through Email Routing. The install form asks for one of the " +
      "account's zones; the install turns Email Routing on there if it is off, then points the " +
      "listed addresses (and, with `catchAll`, every other address) at the app's Worker, which " +
      "must export an `email` handler. Uninstalling removes what the install added. Not for the " +
      "self-deploying tier, whose own installer deploys the app.",
    anyOf: [
      { required: ["catchAll"], properties: { catchAll: { const: true } } },
      { required: ["rules"], properties: { rules: { minItems: 1 } } },
    ],
  });
export type CatalogEmailRouting = z.infer<typeof catalogEmailRoutingSchema>;

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
 * Optional for the same reason as `fixedWorkerName`.
 */
export const catalogSandboxSchema = z
  .object({
    expectedMinutes: expectedBuildMinutesSchema
      .describe(
        "About how many minutes one run of this app in the sandbox Worker takes (its build, or " +
          "for a self-deploying entry its installer's deploy), measured on a `standard-1` " +
          "container (or `instanceType`, when set). The manager multiplies it by the container's " +
          "rates to show what each install or update costs before the admin confirms it. Whole minutes, " +
          `1 to ${MAX_EXPECTED_BUILD_MINUTES}; defaults to ${DEFAULT_EXPECTED_BUILD_MINUTES}.`,
      )
      .optional(),
    instanceType: sandboxInstanceTypeSchema
      .describe(
        "The container the run uses: `standard-1` (1/2 vCPU, 4 GiB memory, 8 GB disk) or " +
          "`standard-2` (1 vCPU, 6 GiB, 12 GB) for builds or installers that run out of memory or disk on the " +
          "smaller one. The larger container costs more per minute, which the manager's cost " +
          'estimate reflects. Defaults to `"standard-1"`.',
      )
      .optional(),
  })
  .describe(
    "How a run of this app in the user's sandbox Worker is sized: the build of a `sandbox` tier " +
      "entry or the installer of a `self-deploying` one (not allowed on `artifact` entries). Both " +
      "fields feed the cost the manager shows before each install and update.",
  );
export type CatalogSandbox = z.infer<typeof catalogSandboxSchema>;

/** The size of a run in the sandbox Worker, defaults filled in. */
export interface SandboxBuildSettings {
  expectedMinutes: number;
  instanceType: SandboxInstanceType;
}

/** `install.sandbox` with {@link DEFAULT_EXPECTED_BUILD_MINUTES} and {@link DEFAULT_SANDBOX_INSTANCE_TYPE} filled in. */
export function sandboxBuildSettings(
  install: Pick<CatalogInstall, "sandbox">,
): SandboxBuildSettings {
  return {
    expectedMinutes: install.sandbox?.expectedMinutes ?? DEFAULT_EXPECTED_BUILD_MINUTES,
    instanceType: install.sandbox?.instanceType ?? DEFAULT_SANDBOX_INSTANCE_TYPE,
  };
}

/** How the packer builds and names the app. */
export const catalogInstallSchema = z
  .object({
    tier: installTierSchema,
    packageManager: packageManagerSchema,
    wranglerConfig: z.string().min(1),
    /** The default Worker name; the installer may change it unless `fixedWorkerName` is set. */
    workerName: z.string().min(1),
    /**
     * The app only works under `workerName` (for example, it hard-codes its own
     * hostname), so it installs at most once per account. Omitted means false.
     * Optional rather than defaulted so manifests and artifacts written before the
     * field existed keep the same parsed shape.
     */
    fixedWorkerName: z.boolean().optional(),
    /**
     * The path the manager probes to tell whether the app serves, for example
     * `/api/health`. When it answers JSON with a string `version`, an update's
     * check of the new version requires that version. Omitted means `/`;
     * optional for the same reason as `fixedWorkerName`.
     */
    healthPath: z
      .string()
      .regex(/^\/[^\s?#]*$/, "healthPath is a URL path starting with /, without query or fragment")
      .optional(),
    /**
     * How the health check reads the Worker's answer. Omitted means `"default"`.
     * `"status-only"` is for apps whose every route sits behind Cloudflare
     * Access or the app's own sign-in, so no unauthenticated request can show
     * whether the app is healthy.
     */
    healthMode: healthModeSchema.optional(),
    /**
     * One command the packer runs in the checkout after installing
     * dependencies and before bundling, for apps whose wrangler config has no
     * `build.command` (Vite, React Router, OpenNext). Optional for the same
     * reason as `fixedWorkerName`.
     */
    buildCommand: z
      .string()
      .max(MAX_BUILD_COMMAND_LENGTH)
      .regex(
        BUILD_COMMAND_PATTERN,
        "buildCommand may contain only letters, digits, spaces, and @ % + , . / : = _ -; it runs without a shell",
      )
      .superRefine((command, ctx) => {
        const problem = buildCommandProblem(command);
        if (problem !== null) ctx.addIssue({ code: "custom", message: `buildCommand ${problem}` });
      })
      .describe(
        "One command the packer runs at the root of the checkout after installing dependencies " +
          "(with install scripts disabled) and before bundling, for example " +
          "`pnpm --filter @scope/web build`. Use it when the wrangler config has no `build.command`. " +
          "It runs as a plain command without a shell, with no credentials in its environment, and " +
          "the checkout's `node_modules/.bin` on its PATH, so pipes, redirects, quotes, variables, " +
          "and environment assignments are not allowed. At most 256 characters.",
      )
      .optional(),
    /**
     * The version shown for this entry when the repository's tag does not
     * describe this app (monorepos); it must change whenever `source` moves.
     * Omitted means the version comes from `source.ref` when it is a semver tag,
     * else from the pinned commit's date and SHA.
     */
    version: semverSchema
      .describe(
        "The version shown for this entry when the repository's tag does not describe this app " +
          "(monorepos); it must change whenever `source` moves.",
      )
      .optional(),
    /**
     * Email the app receives through Email Routing; see
     * {@link catalogEmailRoutingSchema}. Optional for the same reason as
     * `fixedWorkerName`. Refused on `self-deploying` entries: their own
     * installer deploys the app, and Appflare sets up no routing for it.
     */
    emailRouting: catalogEmailRoutingSchema.optional(),
    /**
     * The size of a run in the sandbox Worker (a `sandbox` entry's build or a
     * `self-deploying` entry's installer); see {@link catalogSandboxSchema}.
     * Refused on `artifact` entries, which never run in the user's account.
     */
    sandbox: catalogSandboxSchema.optional(),
    // --- Self-deploying tier -------------------------------------------------
    /**
     * How the sandbox Worker runs the app's own installer; see
     * {@link catalogSelfDeployingSchema}. Required for, and only allowed for,
     * the `self-deploying` tier.
     */
    selfDeploying: catalogSelfDeployingSchema.optional(),
  })
  .superRefine((install, ctx) => {
    if (install.sandbox !== undefined && !runsInSandbox(install.tier)) {
      ctx.addIssue({
        code: "custom",
        path: ["sandbox"],
        message: `install.sandbox is only for the sandbox and self-deploying tiers, which run in the sandbox Worker; this entry's tier is ${install.tier}`,
      });
    }
    const problem = selfDeployingTierProblem(install);
    if (problem !== null) {
      ctx.addIssue({ code: "custom", path: [problem.path], message: problem.message });
    }
    if (install.emailRouting !== undefined && install.tier === "self-deploying") {
      ctx.addIssue({
        code: "custom",
        path: ["emailRouting"],
        message:
          "install.emailRouting is not allowed for the self-deploying tier: the app's own installer deploys it, and Appflare sets up no Email Routing for it",
      });
    }
  })
  // The refinements do not reach the JSON Schema; `allOf` states them there
  // (no `sandbox`, or a tier that runs in the sandbox Worker; `selfDeploying`
  // exactly when the tier is `self-deploying`; no `emailRouting` on a
  // `self-deploying` entry), so editors refuse the same manifests.
  .meta({
    allOf: [
      {
        anyOf: [
          { not: { required: ["sandbox"] } },
          { properties: { tier: { enum: [...SANDBOX_RUN_TIERS] } } },
        ],
      },
      {
        anyOf: [
          {
            required: ["selfDeploying"],
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
    ],
  });
export type CatalogInstall = z.infer<typeof catalogInstallSchema>;

/** Whether the app must run under its catalog `workerName` (and so installs once). */
export function hasFixedWorkerName(install: Pick<CatalogInstall, "fixedWorkerName">): boolean {
  return install.fixedWorkerName === true;
}

/** The path health checks probe: `install.healthPath`, else `/`. */
export function appHealthPath(install: Pick<CatalogInstall, "healthPath">): string {
  return install.healthPath ?? "/";
}

/** How the health check reads the Worker's answer: `install.healthMode`, else `default`. */
export function appHealthMode(install: Pick<CatalogInstall, "healthMode">): HealthMode {
  return install.healthMode ?? "default";
}

/**
 * How the catalog's bump bot treats an entry when its upstream moves.
 *
 * `autoMerge: true` makes the bot's pull request merge itself (squash) once the
 * required checks, the full install check included, pass. Without it, or with
 * `false`, a maintainer reviews and merges each bump. Set it for entries whose
 * maintainers trust upstream's tags to be releasable as they are. The bot does
 * not auto-merge an entry that sets `install.version`, because a person has to
 * update that version with each bump.
 */
export const catalogBumpSchema = z
  .object({
    autoMerge: z
      .boolean()
      .describe(
        "Let the bump bot's pull request merge itself once the required checks, including " +
          "the install check, pass. For entries whose maintainers trust upstream's tags to be " +
          "releasable as they are.",
      ),
  })
  .describe("How the catalog's bump bot treats this entry when its upstream moves.");
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
  manifest: Pick<CatalogManifest, "authors" | "repo">,
): CatalogAuthor[] {
  return manifest.authors ?? authorsFromRepo(manifest.repo);
}

/** What an omitted catalog manifest `revision` means. */
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
      "change to `name`, `summary`, `homepage`, `license`, `categories`, `authors`, " +
      "`maintainers`, `secrets`, `vars`, `postInstall` or `bump` without moving `source`: the " +
      "released artifact stays as it is, and managers show the new form without an update. " +
      "Anything else needs a new build, so move `source` instead.",
  );

/** The full catalog manifest, `appflare.jsonc`. */
export const catalogManifestSchema = z
  .object({
    $schema: z.url().optional(),
    slug: z.string().min(1),
    name: z.string().min(1),
    summary: z.string().min(1),
    /** Shown as a link in the manager; https only (the regex also lands in the JSON Schema). */
    homepage: z
      .url({ protocol: /^https$/, error: "must be an https:// URL" })
      .regex(/^https:\/\//, "must be an https:// URL"),
    repo: ownerRepoSchema,
    license: z.string().min(1),
    categories: z.array(z.string().min(1)),
    /**
     * Who wrote the app upstream, as the catalog shows them. Optional rather
     * than defaulted so manifests and artifacts written before the field existed
     * keep the same parsed shape; the catalog index lists the owner of `repo`
     * when it is omitted ({@link catalogAuthors}).
     */
    authors: z
      .array(catalogAuthorSchema)
      .min(1)
      .describe(
        "Who wrote the app upstream: one or more people or organizations, shown on the catalog " +
          "card and the app's page. Not the people who package it for the catalog (those are " +
          "`maintainers`). When omitted, the catalog lists the owner of `repo`.",
      )
      .optional(),
    /** GitHub users who package the app for the catalog; shown as "Packaged by". */
    maintainers: z.array(z.string().min(1)),
    source: catalogSourceSchema,
    install: catalogInstallSchema,
    plan: planSchema,
    requires: z.array(requirementSchema),
    secrets: z.array(catalogSecretSchema),
    vars: z.array(catalogVarSchema),
    postInstall: z.array(postInstallStepSchema),
    tokenPermissions: z.array(tokenPermissionSchema),
    /**
     * Resource settings the wrangler config cannot express, such as a Vectorize
     * index's dimensions and metric. Optional so manifests and artifacts written
     * before the field existed keep the same parsed shape.
     */
    resources: catalogResourcesSchema.optional(),
    /**
     * How the catalog's bump bot treats this entry. Optional for the same reason
     * as `resources`; omitted means a maintainer merges every bump.
     */
    bump: catalogBumpSchema.optional(),
    /**
     * Which edit of the entry's form and copy this is, for one build. Optional
     * rather than defaulted for the same reason as `resources`: a default would
     * change the parsed shape, and so the published bytes and digest, of every
     * manifest and artifact written before the field existed. Omitted means
     * {@link FIRST_CATALOG_REVISION}; read it with `catalogRevision()`.
     */
    revision: catalogRevisionSchema.optional(),
  })
  .superRefine((manifest, ctx) => {
    if (manifest.install.tier !== "self-deploying") return;
    manifest.secrets.forEach((secret, i) => {
      if (isOptionalSecret(secret)) {
        ctx.addIssue({
          code: "custom",
          path: ["secrets", i, "optional"],
          message:
            "optional secrets are not allowed for the self-deploying tier: the app's own installer runs with every secret the manifest declares",
        });
      }
    });
  })
  // The refinement does not reach the JSON Schema; `allOf` states it there.
  .meta({
    allOf: [
      {
        anyOf: [
          {
            properties: { install: { properties: { tier: { not: { const: "self-deploying" } } } } },
          },
          {
            properties: {
              secrets: {
                items: {
                  not: { required: ["optional"], properties: { optional: { const: true } } },
                },
              },
            },
          },
        ],
      },
    ],
  });
export type CatalogManifest = z.infer<typeof catalogManifestSchema>;
