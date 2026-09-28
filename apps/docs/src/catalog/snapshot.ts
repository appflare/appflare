import {
  CATALOG_SLUG_PATTERN,
  catalogStatsSchema,
  indexJsonSchema,
  ownerRepoSchema,
} from "@appflare/schema";
import { z } from "zod";

/**
 * The catalog as the site is built from it: the published `index.json` and
 * `stats.json`, plus each app's source repository and homepage, which the
 * index does not carry (they are in each app's catalog manifest). The build
 * checks all of it against `@appflare/schema` before any page is made, so a
 * catalog the manager would refuse never reaches the site either.
 */

const httpsUrlSchema = z
  .url({ protocol: /^https$/, error: "must be an https:// URL" })
  .regex(/^https:\/\//, "must be an https:// URL");

/** Where an app's code and home live, from its catalog manifest. */
export const appLinksSchema = z.object({
  repo: ownerRepoSchema,
  homepage: httpsUrlSchema,
});
export type AppLinks = z.infer<typeof appLinksSchema>;

export const catalogSnapshotSchema = z
  .object({
    /** When the snapshot was taken; the site's "now" for every date rule. */
    takenAt: z.iso.datetime(),
    index: indexJsonSchema,
    /** Null when the index names no stats file. */
    stats: catalogStatsSchema.nullable(),
    /** Each app's links, keyed by slug. */
    links: z.record(z.string(), appLinksSchema),
  })
  .superRefine((snapshot, ctx) => {
    const seen = new Set<string>();
    snapshot.index.apps.forEach((app, i) => {
      const path = ["index", "apps", i, "slug"];
      // Slugs become page addresses, so only the strict form is accepted.
      if (!CATALOG_SLUG_PATTERN.test(app.slug)) {
        ctx.addIssue({
          code: "custom",
          path,
          message: `"${app.slug}" is not a catalog slug: lowercase letters, digits and dashes`,
        });
      }
      if (seen.has(app.slug)) {
        ctx.addIssue({ code: "custom", path, message: `"${app.slug}" is listed twice` });
      }
      seen.add(app.slug);
      // Categories become page addresses too.
      (app.categories ?? []).forEach((category, j) => {
        if (!CATALOG_SLUG_PATTERN.test(category)) {
          ctx.addIssue({
            code: "custom",
            path: ["index", "apps", i, "categories", j],
            message: `"${category}" is not a category id: lowercase letters, digits and dashes`,
          });
        }
      });
      if (!Object.hasOwn(snapshot.links, app.slug)) {
        ctx.addIssue({
          code: "custom",
          path: ["links", app.slug],
          message: `no repository or homepage for "${app.slug}"`,
        });
      }
    });
    for (const slug of Object.keys(snapshot.links)) {
      if (!seen.has(slug)) {
        ctx.addIssue({ code: "custom", path: ["links", slug], message: `no app "${slug}"` });
      }
    }
  });

export type CatalogSnapshot = z.infer<typeof catalogSnapshotSchema>;

/** One line per problem, each with where it is: `index.apps.3.slug: …`. */
export function snapshotProblems(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
}

/** Checks a snapshot, throwing an error that lists every problem. */
export function parseCatalogSnapshot(value: unknown, source: string): CatalogSnapshot {
  const result = catalogSnapshotSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `The catalog snapshot from ${source} is not valid:\n  ${snapshotProblems(result.error).join("\n  ")}`,
    );
  }
  return result.data;
}
