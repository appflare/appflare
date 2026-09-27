import { z } from "zod";

/**
 * Lifecycle rules for the R2 buckets an app binds (`resources.r2[binding]`),
 * which the manager sets when it creates the bucket: an app that keeps
 * uploads for a while, or temporary files, says how long, and the bucket
 * deletes them on its own. Wrangler's config has no place for them
 * (`wrangler r2 bucket lifecycle add` sets them on a bucket that exists).
 *
 * Every condition is an age in days, counted from each object's upload (or
 * from the start of a multipart upload). A rule applies to the objects whose
 * keys start with its `prefix`, every object when it has none.
 *
 * This module imports nothing but zod: `catalog.ts` imports it, and the JSON
 * Schema export runs `catalog.ts` directly under Node's type stripping.
 */

/** The most lifecycle rules an app may declare for one bucket. */
export const MAX_R2_LIFECYCLE_RULES = 20;

/** The longest age a rule may give, in days (100 years). */
export const MAX_R2_LIFECYCLE_DAYS = 36_500;

/** A rule id: what the bucket's settings show for it. */
export const R2_LIFECYCLE_RULE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

/**
 * The id of the rule Cloudflare gives every new bucket (abort multipart
 * uploads after seven days). The manager keeps it; a declared rule of that
 * id would replace it without a word, so the schema refuses the id.
 */
export const R2_DEFAULT_LIFECYCLE_RULE_ID = "Default Multipart Abort Rule";

const days = (what: string) =>
  z
    .int()
    .min(1)
    .max(MAX_R2_LIFECYCLE_DAYS)
    .describe(`${what}, in whole days (1 to ${MAX_R2_LIFECYCLE_DAYS}).`);

/** One lifecycle rule of a bucket. */
export const r2LifecycleRuleSchema = z
  .object({
    id: z
      .string()
      .regex(
        R2_LIFECYCLE_RULE_ID_PATTERN,
        "a rule id is 1 to 64 letters, digits, spaces and . _ -, starting with a letter or digit",
      )
      .refine(
        (id) => id !== R2_DEFAULT_LIFECYCLE_RULE_ID,
        `"${R2_DEFAULT_LIFECYCLE_RULE_ID}" is the id of Cloudflare's own rule for unfinished multipart uploads, which Appflare keeps on every bucket; give the rule another id (use abortMultipartUploadsAfterDays in it to change when uploads are aborted)`,
      )
      .meta({ not: { const: R2_DEFAULT_LIFECYCLE_RULE_ID } })
      .describe(
        "The rule's name, shown in the bucket's settings, for example \"Delete temporary files\".",
      ),
    prefix: z
      .string()
      .min(1)
      .max(1024)
      .describe(
        "Apply the rule to objects whose keys start with this, for example `tmp/`. Omitted, it applies to every object.",
      )
      .optional(),
    deleteAfterDays: days("Delete an object this long after it was uploaded").optional(),
    infrequentAccessAfterDays: days(
      "Move an object to Infrequent Access storage this long after it was uploaded",
    ).optional(),
    abortMultipartUploadsAfterDays: days(
      "Abort a multipart upload still unfinished this long after it started",
    ).optional(),
  })
  .refine(
    (rule) =>
      rule.deleteAfterDays !== undefined ||
      rule.infrequentAccessAfterDays !== undefined ||
      rule.abortMultipartUploadsAfterDays !== undefined,
    "a lifecycle rule needs at least one of deleteAfterDays, infrequentAccessAfterDays and abortMultipartUploadsAfterDays",
  )
  .meta({
    anyOf: [
      { required: ["deleteAfterDays"] },
      { required: ["infrequentAccessAfterDays"] },
      { required: ["abortMultipartUploadsAfterDays"] },
    ],
  });
export type R2LifecycleRule = z.infer<typeof r2LifecycleRuleSchema>;

/** `resources.r2[binding]`: settings of the bucket the manager creates for one R2 binding. */
export const catalogR2BucketSchema = z.object({
  lifecycle: z
    .array(r2LifecycleRuleSchema)
    .min(1)
    .max(MAX_R2_LIFECYCLE_RULES)
    .superRefine((rules, ctx) => {
      const seen = new Set<string>();
      rules.forEach((rule, index) => {
        if (seen.has(rule.id)) {
          ctx.addIssue({
            code: "custom",
            path: [index, "id"],
            message: `the rule id "${rule.id}" is used twice; each rule of a bucket needs its own`,
          });
        }
        seen.add(rule.id);
      });
    })
    .describe(
      "Lifecycle rules Appflare sets on the bucket when it creates it, beside Cloudflare's default " +
        `rule for unfinished multipart uploads. At most ${MAX_R2_LIFECYCLE_RULES}, each with a unique id.`,
    ),
});
export type CatalogR2Bucket = z.infer<typeof catalogR2BucketSchema>;

/** `resources.r2`: bucket settings by R2 binding name. */
export const catalogR2Schema = z.record(z.string().min(1), catalogR2BucketSchema);
export type CatalogR2 = z.infer<typeof catalogR2Schema>;

/** One lifecycle rule as Cloudflare's API takes it (`PUT /r2/buckets/{name}/lifecycle`). */
export interface R2LifecycleApiRule {
  id: string;
  enabled: boolean;
  conditions: { prefix: string };
  deleteObjectsTransition?: { condition: { type: "Age"; maxAge: number } };
  abortMultipartUploadsTransition?: { condition: { type: "Age"; maxAge: number } };
  storageClassTransitions?: Array<{
    condition: { type: "Age"; maxAge: number };
    storageClass: "InfrequentAccess";
  }>;
}

const DAY_SECONDS = 86_400;

/**
 * A declared rule in the API's shape, as `wrangler r2 bucket lifecycle add`
 * (wrangler 4.136.2) builds one: ages in seconds, `type: "Age"`, and an
 * empty prefix for a rule over every object, which the API documents.
 */
export function r2LifecycleApiRule(rule: R2LifecycleRule): R2LifecycleApiRule {
  const age = (d: number) => ({ condition: { type: "Age" as const, maxAge: d * DAY_SECONDS } });
  return {
    id: rule.id,
    enabled: true,
    conditions: { prefix: rule.prefix ?? "" },
    ...(rule.deleteAfterDays === undefined
      ? {}
      : { deleteObjectsTransition: age(rule.deleteAfterDays) }),
    ...(rule.abortMultipartUploadsAfterDays === undefined
      ? {}
      : { abortMultipartUploadsTransition: age(rule.abortMultipartUploadsAfterDays) }),
    ...(rule.infrequentAccessAfterDays === undefined
      ? {}
      : {
          storageClassTransitions: [
            { ...age(rule.infrequentAccessAfterDays), storageClass: "InfrequentAccess" as const },
          ],
        }),
  };
}

/**
 * The rules to put on a bucket: the ones it has (Cloudflare gives a new
 * bucket a rule that aborts multipart uploads after seven days), then the
 * declared ones. A rule it has under a declared rule's id is replaced, so
 * setting them again changes nothing.
 */
export function mergeR2LifecycleRules(
  existing: readonly unknown[],
  declared: readonly R2LifecycleRule[],
): unknown[] {
  const ids = new Set(declared.map((r) => r.id));
  const kept = existing.filter((rule) => {
    const id =
      typeof rule === "object" && rule !== null ? (rule as { id?: unknown }).id : undefined;
    return typeof id !== "string" || !ids.has(id);
  });
  return [...kept, ...declared.map(r2LifecycleApiRule)];
}
