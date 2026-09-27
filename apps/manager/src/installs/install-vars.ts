import {
  type ArtifactManifest,
  boundToWorker,
  type CatalogVar,
  type CatalogVarOption,
  catalogVarOptions,
  isJsonVarBinding,
  isSeedOnly,
  type JsonValue,
  jsonTextProblem,
  type PlaceholderValues,
  renderJsonPlaceholders,
  renderPlaceholders,
} from "@appflare/schema";

/**
 * The vars of an app: what the install form shows for each catalog var, and
 * what the Worker receives. A var is text (a `plain_text` binding) unless the
 * app's wrangler config gives it a value that is not a string; then it is
 * JSON (a `json` binding) and the form takes JSON text. `{{workerUrl}}`,
 * `{{workerName}}` and `{{accountId}}` are filled in wherever a value comes
 * from: the wrangler config, the catalog default, or what the admin entered,
 * on every install, update and settings change (the form, which does not know
 * the account id, shows `{{accountId}}` as written). Pure, so the form, the
 * server's input checks, and the jobs share it.
 */

export type VarKind = "text" | "json";

/** One var of the install form. */
export interface InstallVarField {
  name: string;
  label: string;
  help?: string;
  required: boolean;
  kind: VarKind;
  /**
   * What the field starts with, placeholders not filled in yet: the catalog
   * default, else the wrangler config's value (as JSON text for a JSON var),
   * else nothing. For a choice, the wrangler config's value counts only when
   * it is one of the choices.
   */
  shownDefault: string;
  /** The values it can take (a catalog `type: "select"` var); null for any value. */
  options: CatalogVarOption[] | null;
  /**
   * For a derived var (the catalog's `derive`): the secret it is computed
   * from. The forms show it read-only; the manager sets it, never the admin.
   */
  derivedFrom?: string;
  /**
   * A seed-only var (the catalog's `seedOnly`): the install form asks for it
   * once, for the app's D1 seed statements; the Worker never gets it, and
   * neither settings nor updates show it ({@link settingsVarFields}).
   */
  seedOnly?: true;
}

/** The fields a settings form or an update shows: every one but the seed-only ones. */
export function settingsVarFields<T extends Pick<InstallVarField, "seedOnly">>(
  fields: readonly T[],
): T[] {
  return fields.filter((f) => f.seedOnly !== true);
}

/** The fields the admin fills in: every one but the derived ones. */
export function enteredVarFields<T extends Pick<InstallVarField, "derivedFrom">>(
  fields: readonly T[],
): T[] {
  return fields.filter((f) => f.derivedFrom === undefined);
}

/**
 * Why `names`, as a form sent them, cannot be taken, one sentence each: a
 * derived var is computed from its source secret, never entered.
 */
export function enteredDerivedVarProblems(
  names: Iterable<string>,
  fields: readonly Pick<InstallVarField, "name" | "derivedFrom">[],
): string[] {
  const byName = new Map(fields.map((f) => [f.name, f]));
  return [...names].flatMap((name) => {
    const from = byName.get(name)?.derivedFrom;
    return from === undefined
      ? []
      : [`${name} is computed from ${from}; give ${from} a new value instead.`];
  });
}

/** A choice with at most this many options is shown as cards; one with more as a dropdown. */
export const MAX_CARD_OPTIONS = 4;

/** Whether `value` is one of the choices of a `type: "select"` var (always true for other vars). */
export function isVarOption(v: Pick<CatalogVar, "type" | "options">, value: string): boolean {
  const options = catalogVarOptions(v);
  return options === null || options.some((o) => o.value === value);
}

/** A var as the Worker upload sends it. */
export type VarBinding =
  | { type: "plain_text"; name: string; text: string }
  | { type: "json"; name: string; json: JsonValue };

/** The vars the Worker gets, and what was set aside to get them. */
export interface ResolvedVars {
  vars: VarBinding[];
  /**
   * One sentence per stored value that could not be used (a JSON var whose
   * value is not JSON) and what the Worker gets instead.
   */
  warnings: string[];
}

/** What the vars need of a manifest: the catalog vars and the wrangler config's bindings. */
type VarManifest = Pick<ArtifactManifest, "catalog"> & {
  worker: Pick<ArtifactManifest["worker"], "bindings">;
};

/** The wrangler config's own vars, by name, placeholders not filled in. */
function recordedVars(manifest: VarManifest): Map<string, VarBinding> {
  const vars = new Map<string, VarBinding>();
  for (const binding of manifest.worker.bindings) {
    if (binding.type === "plain_text" && typeof binding.text === "string") {
      vars.set(binding.name, { type: "plain_text", name: binding.name, text: binding.text });
    } else if (isJsonVarBinding(binding)) {
      vars.set(binding.name, { type: "json", name: binding.name, json: binding.json as JsonValue });
    }
  }
  return vars;
}

/**
 * The fields of the install form, one per catalog var, in the catalog's
 * order. For an app of several Workers a var the primary Worker's wrangler
 * config lacks takes its kind and value from the first other Worker that
 * declares it.
 */
export function installVarFields(
  manifest: VarManifest & {
    workers?: ReadonlyArray<{ worker: Pick<ArtifactManifest["worker"], "bindings"> }>;
  },
): InstallVarField[] {
  const recorded = recordedVars(manifest);
  for (const other of manifest.workers ?? []) {
    for (const [name, v] of recordedVars({ catalog: manifest.catalog, worker: other.worker })) {
      if (!recorded.has(name)) recorded.set(name, v);
    }
  }
  return manifest.catalog.vars.map((v) => {
    const own = recorded.get(v.name);
    const kind: VarKind = own?.type === "json" ? "json" : "text";
    const ownText =
      own === undefined ? "" : own.type === "json" ? JSON.stringify(own.json) : own.text;
    const options = catalogVarOptions(v);
    return {
      name: v.name,
      label: v.label,
      ...(v.help === undefined ? {} : { help: v.help }),
      required: v.required,
      kind,
      // A derived var shows what the manager computed, never the wrangler config's own value.
      shownDefault:
        v.derive !== undefined ? "" : (v.default ?? (isVarOption(v, ownText) ? ownText : "")),
      options: options === null ? null : [...options],
      ...(v.derive === undefined ? {} : { derivedFrom: v.derive.from }),
      ...(isSeedOnly(v) ? { seedOnly: true as const } : {}),
    };
  });
}

/**
 * Why `value`, as the admin entered it, cannot be the field's value, or null
 * when it can. Empty means "use the default" and is judged by
 * {@link missingRequiredVar}.
 */
export function varValueProblem(
  field: Pick<InstallVarField, "name" | "label" | "kind" | "options">,
  value: string,
): string | null {
  if (value.trim().length === 0) return null;
  if (field.options !== null && !field.options.some((o) => o.value === value)) {
    return `${field.label} (${field.name}) must be one of: ${field.options.map((o) => o.label).join(", ")}.`;
  }
  if (field.kind !== "json") return null;
  const problem = jsonTextProblem(value);
  return problem === null ? null : `${field.label} (${field.name}) ${problem}.`;
}

/** Whether a required field is empty with nothing to fall back to. */
export function missingRequiredVar(field: InstallVarField, value: string): boolean {
  return field.required && value.trim().length === 0 && field.shownDefault.trim().length === 0;
}

function parseJson(text: string): JsonValue | undefined {
  return jsonTextProblem(text) === null ? (JSON.parse(text) as JsonValue) : undefined;
}

/**
 * Every var the Worker gets, with placeholders filled in: the wrangler
 * config's vars, each overridden by the catalog var of the same name with
 * the admin's value, else its catalog default. A catalog var with neither is
 * left as the wrangler config has it, or not sent at all.
 *
 * A stored value that is not JSON for a var this version reads as JSON (the
 * var was text in the version it was entered for) never fails the job: the
 * var falls back to the catalog default, else the wrangler config's value,
 * and a warning names it.
 *
 * A name the catalog declares as a secret is never a var, whatever the
 * wrangler config or the catalog vars say: Cloudflare refuses to set a
 * secret over a var of its name (code 10053), and a version upload that
 * sends a var over a kept secret replaces the secret. Current artifacts
 * record no such var; older ones may.
 */
export function resolveVars(
  manifest: VarManifest,
  userVars: Readonly<Record<string, string>>,
  placeholders: PlaceholderValues,
): ResolvedVars {
  const vars = recordedVars(manifest);
  const warnings: string[] = [];
  const jsonNames = new Set([...vars.values()].filter((v) => v.type === "json").map((v) => v.name));
  // A seed-only var is for the install's seed statements alone: whatever was
  // entered for it never reaches the Worker.
  for (const v of boundToWorker(manifest.catalog.vars)) {
    let entered = userVars[v.name];
    if (entered !== undefined && entered.length > 0 && !isVarOption(v, entered)) {
      // A choice stored for another version, which offered other choices.
      const instead =
        v.default !== undefined ? "the catalog default" : "the wrangler config's value";
      warnings.push(
        `The stored value of ${v.name} is not one of the choices this version of the app offers; the Worker gets ${instead} instead.`,
      );
      entered = undefined;
    }
    const candidates = [
      ...(entered !== undefined && entered.length > 0 ? [{ text: entered, entered: true }] : []),
      ...(v.default !== undefined ? [{ text: v.default, entered: false }] : []),
    ];
    if (!jsonNames.has(v.name)) {
      const first = candidates[0];
      if (first !== undefined)
        vars.set(v.name, { type: "plain_text", name: v.name, text: first.text });
      continue;
    }
    const used = candidates.find((c) => parseJson(c.text) !== undefined);
    if (used !== undefined) {
      vars.set(v.name, { type: "json", name: v.name, json: parseJson(used.text) as JsonValue });
    }
    const skipped = candidates.filter((c) => c !== used && (used === undefined || c.entered));
    if (skipped.length > 0) {
      const what = skipped
        .map((c) => (c.entered ? "stored value" : "catalog default"))
        .join(" and ");
      // A JSON var always has the wrangler config's value to fall back to.
      const instead = used !== undefined ? "the catalog default" : "the wrangler config's value";
      warnings.push(
        `The ${what} of ${v.name} ${skipped.length > 1 ? "are" : "is"} not valid JSON, but this version of the app ` +
          `reads ${v.name} as JSON; the Worker gets ${instead} instead.`,
      );
    }
  }
  // A seed-only secret is never set on the Worker, so it takes no var's place.
  for (const secret of boundToWorker(manifest.catalog.secrets)) vars.delete(secret.name);
  return {
    vars: [...vars.values()].map((v) =>
      v.type === "json"
        ? { ...v, json: renderJsonPlaceholders(v.json, placeholders) }
        : { ...v, text: renderPlaceholders(v.text, placeholders) },
    ),
    warnings,
  };
}

/** Stands in for the Worker's URL while looking for where it ends up. */
const WORKER_URL_MARKER = "https://worker-url.appflare.invalid";

/**
 * Whether any var the Worker gets is filled in with its URL
 * (`{{workerUrl}}`), from the wrangler config, a catalog default, or what the
 * admin entered.
 */
export function varsUseWorkerUrl(
  manifest: VarManifest,
  userVars: Readonly<Record<string, string>>,
): boolean {
  const { vars } = resolveVars(manifest, userVars, {
    workerUrl: WORKER_URL_MARKER,
    workerName: "",
  });
  return vars.some((v) =>
    (v.type === "json" ? JSON.stringify(v.json) : v.text).includes(WORKER_URL_MARKER),
  );
}
