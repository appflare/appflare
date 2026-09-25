import {
  type ArtifactManifest,
  type CatalogVar,
  type CatalogVarOption,
  catalogVarOptions,
  isJsonVarBinding,
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
 * JSON (a `json` binding) and the form takes JSON text. `{{workerUrl}}` and
 * `{{workerName}}` are filled in wherever a value comes from: the wrangler
 * config, the catalog default, or what the admin entered, on every install and
 * update. Pure, so the form, the server's input checks, and the jobs share it.
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

/** The fields of the install form, one per catalog var, in the catalog's order. */
export function installVarFields(manifest: VarManifest): InstallVarField[] {
  const recorded = recordedVars(manifest);
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
      shownDefault: v.default ?? (isVarOption(v, ownText) ? ownText : ""),
      options: options === null ? null : [...options],
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
 */
export function resolveVars(
  manifest: VarManifest,
  userVars: Readonly<Record<string, string>>,
  placeholders: PlaceholderValues,
): ResolvedVars {
  const vars = recordedVars(manifest);
  const warnings: string[] = [];
  const jsonNames = new Set([...vars.values()].filter((v) => v.type === "json").map((v) => v.name));
  for (const v of manifest.catalog.vars) {
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
  return {
    vars: [...vars.values()].map((v) =>
      v.type === "json"
        ? { ...v, json: renderJsonPlaceholders(v.json, placeholders) }
        : { ...v, text: renderPlaceholders(v.text, placeholders) },
    ),
    warnings,
  };
}
