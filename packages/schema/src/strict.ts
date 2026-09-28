import { z } from "zod";

/**
 * Strict parsing for the places manifests are written: the packer, the
 * catalog checks and the CLI. The schemas themselves strip keys they do not
 * know, so a manager keeps reading a manifest written for a later version;
 * where a manifest is written, a key the schema does not know is almost
 * always a misspelling (`instal`, `healthpath`, `optinal`) that would
 * otherwise be dropped without a word.
 */

/** One key a schema would strip, with where it is. */
export interface UnknownKey {
  path: Array<string | number>;
  key: string;
}

/** A dotted path as a manifest author reads it: `install.workers[0].name`. */
export function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = "";
  for (const part of path) {
    if (typeof part === "number") out += `[${part}]`;
    else out += out === "" ? String(part) : `.${String(part)}`;
  }
  return out;
}

/** The parts of a Zod definition the walk reads. */
interface WalkDef {
  type: string;
  shape?: Record<string, z.core.$ZodType>;
  catchall?: z.core.$ZodType;
  element?: z.core.$ZodType;
  valueType?: z.core.$ZodType;
  options?: readonly z.core.$ZodType[];
  innerType?: z.core.$ZodType;
  in?: z.core.$ZodType;
  left?: z.core.$ZodType;
  right?: z.core.$ZodType;
  getter?: () => z.core.$ZodType;
}

function defOf(schema: z.core.$ZodType): WalkDef {
  return schema._zod.def as unknown as WalkDef;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The keys of `value` that `schema` would strip: keys of a plain object
 * (`z.object`, not a loose, strict or catch-all one) that its shape does not
 * name, at any depth. Unions are followed into the option the value parses
 * under; when it parses under none, a key counts only when no option knows
 * it. Anything the walk cannot see into (a transform, a custom check) is
 * skipped, so it never reports a key the schema keeps.
 */
export function unknownKeys(schema: z.core.$ZodType, value: unknown): UnknownKey[] {
  const found: UnknownKey[] = [];
  walk(schema, value, [], found);
  return found;
}

function walk(
  schema: z.core.$ZodType,
  value: unknown,
  path: Array<string | number>,
  found: UnknownKey[],
): void {
  const def = defOf(schema);
  switch (def.type) {
    case "object": {
      if (!isPlainObject(value)) return;
      const shape = def.shape ?? {};
      for (const [key, item] of Object.entries(value)) {
        const field = Object.hasOwn(shape, key) ? shape[key] : undefined;
        if (field !== undefined) walk(field, item, [...path, key], found);
        else if (def.catchall === undefined) found.push({ path: [...path, key], key });
        else walk(def.catchall, item, [...path, key], found);
      }
      return;
    }
    case "array":
      if (Array.isArray(value) && def.element !== undefined) {
        const element = def.element;
        value.forEach((item, i) => {
          walk(element, item, [...path, i], found);
        });
      }
      return;
    case "record":
      if (isPlainObject(value) && def.valueType !== undefined) {
        const valueType = def.valueType;
        for (const [key, item] of Object.entries(value))
          walk(valueType, item, [...path, key], found);
      }
      return;
    case "union": {
      const options = def.options ?? [];
      const match = options.find((option) => z.safeParse(option, value).success);
      if (match !== undefined) {
        walk(match, value, path, found);
        return;
      }
      // No option fits: report a key only when every option would strip it.
      const perOption = options.map((option) => {
        const keys: UnknownKey[] = [];
        walk(option, value, path, keys);
        return new Set(keys.map((k) => formatPath(k.path)));
      });
      const first: UnknownKey[] = [];
      if (options[0] !== undefined) walk(options[0], value, path, first);
      for (const key of first) {
        if (perOption.every((set) => set.has(formatPath(key.path)))) found.push(key);
      }
      return;
    }
    case "intersection":
      // Each side strips what the other knows; neither alone can say.
      return;
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "catch":
    case "readonly":
    case "nonoptional":
      if (def.innerType !== undefined) walk(def.innerType, value, path, found);
      return;
    case "pipe":
      if (def.in !== undefined && defOf(def.in).type !== "transform") {
        walk(def.in, value, path, found);
      }
      return;
    case "lazy":
      if (def.getter !== undefined) walk(def.getter(), value, path, found);
      return;
    default:
      return;
  }
}

/** One problem a strict parse adds, with its path from the value's root. */
export interface StrictProblem {
  path: Array<string | number>;
  message: string;
}

/**
 * `schema`, refusing every key it would strip (the message names the key's
 * path), and whatever `extra` finds in the input, beside the schema's own
 * problems, so one run reports them all. The result is what `schema` gives.
 * For tools that write manifests; readers use `schema` itself.
 */
export function strictSchema<T extends z.ZodType>(
  schema: T,
  extra?: (input: unknown) => StrictProblem[],
): z.ZodType<z.output<T>, unknown> {
  return z.unknown().transform((input, ctx) => {
    const result = schema.safeParse(input);
    const unknown = unknownKeys(schema, input);
    for (const { path } of unknown) {
      ctx.addIssue({
        code: "custom",
        path,
        message: `${formatPath(path)} is not a field here; check its spelling`,
      });
    }
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
      }
    }
    const problems = extra?.(input) ?? [];
    for (const problem of problems) ctx.addIssue({ code: "custom", ...problem });
    if (!result.success || unknown.length > 0 || problems.length > 0) return z.NEVER;
    return result.data;
  });
}
