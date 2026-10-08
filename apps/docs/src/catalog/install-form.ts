import { ACCESS_MODES, catalogFieldLinkSchema, databaseProtocolName } from "@appflare/schema";
import { z } from "zod";

/**
 * What Appflare's install form will ask of a person for one app, worked out
 * from its catalog manifest the way the manager lays the form out: the
 * secrets, database connections and settings that need a value typed in,
 * whether it asks for a domain that receives email, the generated values it
 * fills in by itself, how many optional fields it folds away, whether it
 * puts the app behind Cloudflare Access and what stays public then, and how
 * many notes it shows after the install. The app's page turns it into its
 * "Deploy on Cloudflare" steps.
 */

/** A field's link to where its value comes from ("Get a key"). */
export type FieldLink = z.infer<typeof catalogFieldLinkSchema>;

/** One field a person fills in. */
export const askedFieldSchema = z.object({
  label: z.string().min(1),
  link: catalogFieldLinkSchema.nullable(),
  /** Asked once, at install, and never again (a first admin's password, say). */
  seedOnly: z.boolean(),
});
export type AskedField = z.infer<typeof askedFieldSchema>;

export const installFormSchema = z.object({
  /**
   * What the person types in, in the form's order: the secrets it must have
   * that it does not generate, each database's connection string, then the
   * required settings with nothing to start from. Seed-only fields are
   * always asked up front, optional or not.
   */
  asks: z.array(askedFieldSchema),
  /** The databases elsewhere it asks a connection string for, by label (also in `asks`). */
  databases: z.array(z.string().min(1)),
  /** It asks for a domain of the account that can receive email. */
  emailDomain: z.boolean(),
  /** The secrets the form generates (a password, a key), by label. */
  generated: z.array(z.string().min(1)),
  /** Optional secrets and settings, which the form folds away. */
  optional: z.number().int().min(0),
  /**
   * How the form offers Cloudflare Access: always on (`required`), on unless
   * switched off (`recommended`), off unless switched on (`offered`), or
   * null when the app's own installer decides (a self-deploying app) or the
   * entry names a mode this version does not know.
   */
  access: z.enum([...ACCESS_MODES, "offered"]).nullable(),
  /** The paths that stay public while the app is behind Access. */
  publicPaths: z.array(z.string().min(1)),
  /** The notes Appflare shows once the app is installed. */
  postInstallSteps: z.number().int().min(0),
});
export type InstallForm = z.infer<typeof installFormSchema>;

/**
 * The parts of a catalog manifest the form reads. Lenient on purpose: a
 * field this version does not know is ignored, and a malformed link is left
 * out rather than failing the build, since the manifest was already checked
 * by the catalog and its digest by the index.
 */
const optionalLink = catalogFieldLinkSchema.optional().catch(undefined);
const manifestSchema = z.object({
  install: z
    .object({ tier: z.string().optional(), emailRouting: z.unknown().optional() })
    .optional(),
  access: z
    .object({
      mode: z.string().optional(),
      bypass: z.array(z.string().min(1)).optional().catch(undefined),
    })
    .optional(),
  resources: z
    .object({
      hyperdrive: z
        .record(
          z.string(),
          z.object({
            protocol: z.enum(["postgres", "mysql"]),
            label: z.string().min(1).optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  secrets: z
    .array(
      z.object({
        label: z.string().min(1),
        link: optionalLink,
        generate: z.string().optional(),
        derive: z.unknown().optional(),
        optional: z.boolean().optional(),
        seedOnly: z.boolean().optional(),
      }),
    )
    .optional(),
  vars: z
    .array(
      z.object({
        name: z.string(),
        label: z.string().min(1),
        link: optionalLink,
        default: z.string().optional(),
        derive: z.unknown().optional(),
        optional: z.boolean().optional(),
        seedOnly: z.boolean().optional(),
        type: z.string().optional(),
        options: z.array(z.object({ value: z.string() })).optional(),
      }),
    )
    .optional(),
  postInstall: z.array(z.unknown()).optional(),
});

/**
 * The values the app's own wrangler config gives its settings, by name, from
 * the bindings of a release's `manifest.json` (`worker.bindings`, and each
 * other Worker's). A setting without a catalog `default` starts from this
 * value on the form.
 */
export type WranglerVars = ReadonlyMap<string, string>;

const bindingSchema = z.object({ type: z.string(), name: z.string() }).loose();
const releaseSchema = z.object({
  worker: z.object({ bindings: z.array(bindingSchema) }),
  workers: z.array(z.object({ worker: z.object({ bindings: z.array(bindingSchema) }) })).optional(),
});

/** The wrangler config's own settings in a release manifest, or null when it lists none. */
export function wranglerVarsOf(release: unknown): WranglerVars | null {
  const parsed = releaseSchema.safeParse(release);
  if (!parsed.success) return null;
  const vars = new Map<string, string>();
  const read = (bindings: ReadonlyArray<z.infer<typeof bindingSchema>>) => {
    for (const binding of bindings) {
      if (vars.has(binding.name)) continue;
      if (binding.type === "plain_text" && typeof binding.text === "string") {
        vars.set(binding.name, binding.text);
      } else if (binding.type === "json" && binding.json !== undefined) {
        vars.set(binding.name, JSON.stringify(binding.json));
      }
    }
  };
  read(parsed.data.worker.bindings);
  for (const other of parsed.data.workers ?? []) read(other.worker.bindings);
  return vars;
}

type ManifestVar = NonNullable<z.infer<typeof manifestSchema>["vars"]>[number];

/** Whether a setting has a value the form starts from: its default, else the wrangler config's. */
function hasStartingValue(v: ManifestVar, wrangler: WranglerVars | null): boolean {
  if (v.default !== undefined) return v.default.trim() !== "";
  const own = wrangler?.get(v.name) ?? "";
  // A choice starts from the wrangler config's value only when it is one of the options.
  const usable = v.type === "select" ? (v.options ?? []).some((o) => o.value === own) : true;
  return usable && own.trim() !== "";
}

/**
 * Whether a setting is left for the person to fill in: it is not computed,
 * it is required or seed-only (asked up front either way), and nothing
 * fills it in. Without the wrangler config (`null`) a setting with no
 * default counts as asked.
 */
function settingIsAsked(v: ManifestVar, wrangler: WranglerVars | null): boolean {
  if (v.derive !== undefined) return false;
  if (v.optional === true && v.seedOnly !== true) return false;
  return !hasStartingValue(v, wrangler);
}

/** Whether `settingIsAsked` needs the wrangler config to decide for this manifest. */
export function needsWranglerVars(manifest: unknown): boolean {
  const parsed = manifestSchema.safeParse(manifest);
  if (!parsed.success) return false;
  return (parsed.data.vars ?? []).some(
    (v) =>
      (v.optional !== true || v.seedOnly === true) &&
      v.derive === undefined &&
      v.default === undefined,
  );
}

export interface InstallFormOptions {
  /** The settings the app's wrangler config gives, when known. */
  wrangler?: WranglerVars | null;
  /** The tier the catalog index lists, which wins over the manifest's. */
  tier?: string;
}

/** How the form offers Access for an entry's mode; null for a mode this version does not know. */
function accessOf(mode: string | undefined): InstallForm["access"] {
  if (mode === undefined) return "offered";
  return (ACCESS_MODES as readonly string[]).includes(mode)
    ? (mode as (typeof ACCESS_MODES)[number])
    : null;
}

/**
 * The install form of a catalog manifest. A manifest this cannot read gives
 * null, and the page then words its steps without the form's fields.
 */
export function installFormOf(
  manifest: unknown,
  { wrangler = null, tier }: InstallFormOptions = {},
): InstallForm | null {
  const parsed = manifestSchema.safeParse(manifest);
  if (!parsed.success) return null;
  const { install, access, resources, secrets = [], vars = [], postInstall = [] } = parsed.data;
  // Derived secrets are computed by Appflare, never shown.
  const entered = secrets.filter((s) => s.derive === undefined);
  const generated = entered.filter((s) => s.generate !== undefined);
  const typed = entered.filter((s) => s.generate === undefined);
  const databases = Object.values(resources?.hyperdrive ?? {}).map((db) => {
    const kind = `${databaseProtocolName(db.protocol)} connection string`;
    return db.label === undefined ? kind : `${db.label} (${kind})`;
  });
  const asks: AskedField[] = [
    ...typed
      .filter((s) => s.optional !== true || s.seedOnly === true)
      .map((s) => ({ label: s.label, link: s.link ?? null, seedOnly: s.seedOnly === true })),
    ...databases.map((label) => ({ label, link: null, seedOnly: false })),
    ...vars
      .filter((v) => settingIsAsked(v, wrangler))
      .map((v) => ({ label: v.label, link: v.link ?? null, seedOnly: v.seedOnly === true })),
  ];
  // Folded away: optional fields that are not seed-only, not generated and not computed.
  const optional =
    typed.filter((s) => s.optional === true && s.seedOnly !== true).length +
    vars.filter((v) => v.optional === true && v.seedOnly !== true && v.derive === undefined).length;
  // A self-deploying app's own installer decides where it answers, so the form offers no Access.
  const selfDeploying = (tier ?? install?.tier) === "self-deploying";
  const offer = selfDeploying ? null : accessOf(access?.mode);
  return {
    asks,
    databases,
    emailDomain: install?.emailRouting !== undefined,
    generated: generated.map((s) => s.label),
    optional,
    access: offer,
    publicPaths: offer === null ? [] : (access?.bypass ?? []),
    postInstallSteps: postInstall.length,
  };
}
