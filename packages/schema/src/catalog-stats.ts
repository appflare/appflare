import { z } from "zod";

/**
 * Schema for the catalog's popularity file, `stats.json`, published next to
 * `index.json` (whose `stats` field holds its URL). The catalog rebuilds it
 * about hourly from GitHub stars and from the anonymous install events
 * managers send; managers fetch it with the index and never query GitHub or
 * the analytics service themselves.
 *
 * Popularity is a hint for sorting and nothing else: stars can be bought and
 * events can be forged, so no decision (the sponsored slot, install checks,
 * what gets installed) depends on it.
 */

/**
 * Install counts below this are published as null ("fewer than 10"), so a
 * handful of installs never identifies anyone and a few forged events move
 * nothing.
 */
export const MIN_PUBLISHED_INSTALLS = 10;

const publishedCountSchema = z.number().int().min(MIN_PUBLISHED_INSTALLS).nullable();

/** One app's numbers. Each source says when it was last read successfully. */
export const catalogAppStatsSchema = z.object({
  /** Stargazers of the app's upstream repository; null when never read (or not the app's own repository). */
  stars: z
    .object({
      count: z.number().int().nonnegative(),
      fetchedAt: z.iso.datetime(),
    })
    .nullable(),
  /** Install counts from the managers' anonymous events; null when never read. */
  installs: z
    .object({
      /** Distinct managers that installed the app in the last 30 days; null below the floor. */
      last30d: publishedCountSchema,
      /** Distinct managers whose latest daily report in 7 days lists the app; null below the floor. */
      active: publishedCountSchema,
      fetchedAt: z.iso.datetime(),
    })
    .nullable(),
});
export type CatalogAppStats = z.infer<typeof catalogAppStatsSchema>;

/** Whether the last read of a source worked, and when it last did. */
export const catalogStatsSourceSchema = z.object({
  ok: z.boolean(),
  /** The last successful read; null when there has never been one. */
  at: z.iso.datetime().nullable(),
});
export type CatalogStatsSource = z.infer<typeof catalogStatsSourceSchema>;

/** `stats.json`. `apps` is keyed by slug. */
export const catalogStatsSchema = z.object({
  generatedAt: z.iso.datetime(),
  apps: z.record(z.string().min(1), catalogAppStatsSchema),
  sources: z.object({
    github: catalogStatsSourceSchema,
    telemetry: catalogStatsSourceSchema,
  }),
});
export type CatalogStats = z.infer<typeof catalogStatsSchema>;
