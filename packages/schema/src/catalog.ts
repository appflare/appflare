import { z } from "zod";

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

/** How an app is built. v1 ships `artifact` only. */
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
 */
export const catalogSecretSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  help: z.string().optional(),
  generate: z.boolean().default(false),
});
export type CatalogSecret = z.infer<typeof catalogSecretSchema>;

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
 */
export const catalogVarSchema = z.object({
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
        'example `["{{workerUrl}}"]`. Without `default`, the form starts with the wrangler config\'s value.',
    )
    .optional(),
  required: z.boolean().default(false),
});
export type CatalogVar = z.infer<typeof catalogVarSchema>;

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
      "must export an `email` handler. Uninstalling removes what the install added.",
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

/**
 * How a `sandbox` tier entry is built in the user's account. Neither field
 * changes what is built; both feed the cost the manager shows before an
 * install or update: a build runs one container of `instanceType` for about
 * `expectedMinutes`, and Cloudflare bills that container's memory, vCPU and
 * disk by the second beyond the usage Workers Paid includes each month
 * (a 10-minute `standard-1` build costs about one US cent). `instanceType`
 * also sets the container the build actually runs on. Catalog CI copies both,
 * defaults filled in, into the index entry's `build` block. Optional for the
 * same reason as `fixedWorkerName`.
 */
export const catalogSandboxSchema = z
  .object({
    expectedMinutes: expectedBuildMinutesSchema
      .describe(
        "About how many minutes one build of this app takes, measured on a `standard-1` build " +
          "(or `instanceType`, when set). The manager multiplies it by the container's rates to " +
          "show what each install or update costs before the admin confirms it. Whole minutes, " +
          `1 to ${MAX_EXPECTED_BUILD_MINUTES}; defaults to ${DEFAULT_EXPECTED_BUILD_MINUTES}.`,
      )
      .optional(),
    instanceType: sandboxInstanceTypeSchema
      .describe(
        "The container the build runs on: `standard-1` (1/2 vCPU, 4 GiB memory, 8 GB disk) or " +
          "`standard-2` (1 vCPU, 6 GiB, 12 GB) for builds that run out of memory or disk on the " +
          "smaller one. The larger container costs more per minute, which the manager's cost " +
          'estimate reflects. Defaults to `"standard-1"`.',
      )
      .optional(),
  })
  .describe(
    "How this app is built in the user's account, for `sandbox` tier entries only. Both fields " +
      "feed the build cost the manager shows before each install and update.",
  );
export type CatalogSandbox = z.infer<typeof catalogSandboxSchema>;

/** A sandbox build's settings, defaults filled in. */
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
     * `fixedWorkerName`.
     */
    emailRouting: catalogEmailRoutingSchema.optional(),
    /**
     * Build settings of a `sandbox` tier entry; see {@link catalogSandboxSchema}.
     * Refused on other tiers, where nothing is built in the user's account.
     */
    sandbox: catalogSandboxSchema.optional(),
  })
  .superRefine((install, ctx) => {
    if (install.sandbox !== undefined && install.tier !== "sandbox") {
      ctx.addIssue({
        code: "custom",
        path: ["sandbox"],
        message: `install.sandbox is only for sandbox tier entries; this entry's tier is ${install.tier}`,
      });
    }
  })
  // The refinement does not reach the JSON Schema; `anyOf` states it there
  // (no `sandbox`, or tier `sandbox`), so editors refuse it on other tiers too.
  .meta({
    anyOf: [{ not: { required: ["sandbox"] } }, { properties: { tier: { const: "sandbox" } } }],
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

/** The full catalog manifest, `appflare.jsonc`. */
export const catalogManifestSchema = z.object({
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
});
export type CatalogManifest = z.infer<typeof catalogManifestSchema>;
