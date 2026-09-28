import { z } from "zod";
import { sha256Schema } from "./artifact";
import {
  catalogAuthorSchema,
  catalogRevisionSchema,
  catalogSlugSchema,
  expectedBuildMinutesSchema,
  gitShaSchema,
  installTierSchema,
  planSchema,
  requirementSchema,
  sandboxInstanceTypeSchema,
} from "./catalog";
import { MAX_ENTRY_CATEGORIES } from "./category-list";
import { licenseNoteSchema, licenseSchema } from "./license";
import { MAX_SCREENSHOTS } from "./media";
import { taglineSchema } from "./tagline";

/**
 * Schema for the generated `index.json` published to GitHub Pages.
 * One row per app plus a top-level `generatedAt`.
 */

/** An https:// URL (the regex keeps the rule in any exported JSON Schema). */
const httpsUrlSchema = z
  .url({ protocol: /^https$/, error: "must be an https:// URL" })
  .regex(/^https:\/\//, "must be an https:// URL");

/**
 * One image the catalog site hosts next to `index.json`, pinned by the
 * sha256 of its exact bytes. The manager serves an image only when its URL is
 * on the index's own origin and the bytes it fetched match the digest, so an
 * index can never make a manager's users load images from anywhere else.
 */
export const indexMediaFileSchema = z.object({
  url: httpsUrlSchema,
  sha256: sha256Schema,
});
export type IndexMediaFile = z.infer<typeof indexMediaFileSchema>;

/** A screenshot, with the text a screen reader reads for it. */
export const indexScreenshotSchema = indexMediaFileSchema.extend({
  alt: z.string().min(1).max(200),
});
export type IndexScreenshot = z.infer<typeof indexScreenshotSchema>;

/**
 * An entry's images: `icon` (square, for lists), `cover` (1200x630, also the
 * size of an OpenGraph image) and `screenshots`, in display order.
 */
export const indexMediaSchema = z.object({
  icon: indexMediaFileSchema.optional(),
  cover: indexMediaFileSchema.optional(),
  screenshots: z.array(indexScreenshotSchema).max(MAX_SCREENSHOTS).default([]),
});
export type IndexMedia = z.infer<typeof indexMediaSchema>;

/** Release-asset URLs for one app version, and the digest of its manifest. */
export const indexArtifactsSchema = z.object({
  zip: z.url(),
  manifest: z.url(),
  sig: z.url(),
  /** sha256 of the exact bytes of the release's `manifest.json`. */
  digest: sha256Schema,
});
export type IndexArtifacts = z.infer<typeof indexArtifactsSchema>;

/**
 * How a `sandbox` or `self-deploying` tier entry runs in the user's account:
 * catalog CI does not publish a prebuilt artifact for either, so the manager
 * asks its sandbox Worker to build the pinned commit (`sandbox`) or to run the
 * app's own installer there (`self-deploying`). The entry's catalog manifest
 * is published next to the index, addressed by its sha256, because the
 * request carries it verbatim and the install form is generated from it.
 * `expectedMinutes` and `instanceType` are the entry's `install.container`,
 * copied for the cost estimate the manager shows before each run.
 */
export const indexBuildSchema = z.object({
  /** The exact commit the build checks out; equals the catalog manifest's `source.sha`. */
  pin: gitShaSchema,
  /** URL of the entry's catalog manifest as JSON. */
  manifest: z.url(),
  /** sha256 of the exact bytes at `manifest`. */
  manifestDigest: sha256Schema,
  /** The entry's `install.buildCommand`, repeated for display. */
  buildCommand: z.string().min(1).optional(),
  /** Wall-clock minutes a run (build or installer) usually takes, for the cost estimate. */
  expectedMinutes: expectedBuildMinutesSchema.optional(),
  /** Container size the run needs; `standard-1` when omitted. */
  instanceType: sandboxInstanceTypeSchema.optional(),
});
export type IndexBuild = z.infer<typeof indexBuildSchema>;

/**
 * The revised catalog manifest of an `artifact` tier entry (see
 * `revision.ts`): the catalog publishes it next to the index when the entry's
 * `revision` is above the one its release was built with, signed by the key
 * that signs its releases. The manager uses it for the forms and copy of that
 * release only after checking its bytes against `sha256`, the signature with
 * the embedded keys (`keyId` must be the release's), and its fields against
 * the signed artifact manifest.
 */
export const indexCatalogManifestSchema = z.object({
  /** URL of the revised catalog manifest as JSON. */
  url: httpsUrlSchema,
  /** sha256 of the exact bytes at `url`. */
  sha256: sha256Schema,
  /** The signing key, as in `manifest.json`'s `keyId`: the key that signed the release. */
  keyId: z.string().min(1),
  /** Base64 Ed25519 signature over the exact bytes at `url` (also served at `<url>.sig`). */
  signature: z.string().min(1),
});
export type IndexCatalogManifest = z.infer<typeof indexCatalogManifestSchema>;

/**
 * One app entry in the published catalog index. `artifact` tier entries
 * carry the release URLs and the manifest digest (`artifacts`); `sandbox` and
 * `self-deploying` tier entries carry `build` instead and may omit both (a
 * self-deploying entry's `build` points at the catalog manifest that holds
 * its installer's commands; `expectedMinutes` and `instanceType` size the
 * container the installer runs in).
 */
export const indexAppSchema = z
  .object({
    slug: catalogSlugSchema,
    name: z.string().min(1),
    summary: z.string().min(1),
    /** The catalog manifest's `tagline`, the pitch on catalog tiles. */
    tagline: taglineSchema,
    /**
     * When the entry first appeared in the catalog (the commit that added its
     * manifest), for "New this week".
     */
    addedAt: z.iso.datetime({ offset: true }),
    version: z.string().min(1),
    artifacts: indexArtifactsSchema.optional(),
    tier: installTierSchema,
    plan: planSchema,
    requires: z.array(requirementSchema),
    lastVerified: z.iso.datetime().nullable(),
    /**
     * Who wrote the app: the catalog manifest's `authors`, or the owner of its
     * `repo` when it lists none.
     */
    authors: z.array(catalogAuthorSchema).min(1),
    /** Who packages the app for the catalog. */
    maintainers: z.array(z.string().min(1)),
    build: indexBuildSchema.optional(),
    /** The entry's images, when it has any. */
    media: indexMediaSchema.optional(),
    /**
     * The Cloudflare services the app uses (`SERVICE_IDS`), as
     * `appServices()` works them out: from the artifact's Worker and the
     * catalog manifest for an `artifact` tier entry, from the catalog
     * manifest alone for the others. Plain strings, not the enum, so a manager
     * still reads rows naming services added after it was released (it skips
     * those).
     */
    services: z.array(z.string().min(1)),
    /**
     * The app declares key-value backed Durable Objects, which need Workers
     * Paid. Written only when true.
     */
    keyValueDurableObjects: z.boolean().optional(),
    /**
     * The catalog manifest's `categories`. Plain strings, not the list's ids,
     * so a manager still reads a custom catalog's row that names a category
     * it does not know (it lists that row under no category). At most
     * {@link MAX_ENTRY_CATEGORIES}, as in the manifest.
     */
    categories: z.array(z.string().min(1)).min(1).max(MAX_ENTRY_CATEGORIES),
    /** The catalog manifest's `license` and `licenseNote`, for the catalog card. */
    license: licenseSchema,
    licenseNote: licenseNoteSchema.optional(),
    /** The catalog manifest's `revision`: with `version`, which edit of the entry this row describes. */
    revision: catalogRevisionSchema,
    /**
     * For an `artifact` tier entry whose `revision` is above the one its
     * release was built with: the revised catalog manifest, which replaces the
     * release's copy for the forms and copy. Absent when the release's own
     * copy is current.
     */
    catalogManifest: indexCatalogManifestSchema.optional(),
  })
  .superRefine((app, ctx) => {
    if (app.tier === "artifact" && app.artifacts === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["artifacts"],
        message: "an artifact tier entry needs its release artifacts",
      });
    }
    if (app.tier === "sandbox" && app.build === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["build"],
        message: "a sandbox tier entry needs a build block",
      });
    }
    // Only a release has a catalog manifest to revise; the other tiers
    // publish their current catalog manifest in `build` on every edit.
    if (
      app.catalogManifest !== undefined &&
      (app.tier !== "artifact" || app.artifacts === undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["catalogManifest"],
        message: "a revised catalog manifest belongs to an artifact tier entry with its release",
      });
    }
    // A self-deploying entry has no artifact either: the manager reads its
    // catalog manifest (the installer's commands) from the same block.
    if (app.tier === "self-deploying" && app.build === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["build"],
        message: "a self-deploying tier entry needs a build block",
      });
    }
  });
export type IndexApp = z.infer<typeof indexAppSchema>;

/** The prebuilt artifact of an entry, or null when it has none (a sandbox tier entry). */
export function indexAppArtifact(app: Pick<IndexApp, "artifacts">): IndexArtifacts | null {
  return app.artifacts ?? null;
}

/**
 * Catalog manifest fields that change only what the index shows, never what
 * an artifact installs: a catalog builds its index from the current
 * manifest, so an edit to these alone needs no new release and no revision.
 *
 * - `authors`: the catalog card and app page.
 * - `tagline`: the line under the name on a catalog tile; managers read it
 *   from the index row only.
 * - `licenseNote`: shown next to the license; managers read it from the
 *   index row, and an installed app does not use it.
 */
export const INDEX_ONLY_CATALOG_FIELDS: readonly string[] = ["authors", "tagline", "licenseNote"];

/**
 * One item of the catalog's sponsored slot. It can promote anything, an app
 * in the catalog or not. The manager always labels it "Sponsored" (the label
 * lives in the manager, so no index can remove it), shows at most one item at
 * a time on the catalog page, and lets each user hide it.
 */
export const featuredItemSchema = z
  .object({
    /** Stable id; hiding an item keys on it. Never reused: a new campaign gets a new id. */
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "must be lowercase letters, digits and dashes"),
    title: z.string().min(1).max(60),
    /** Plain text, no markdown or HTML, rendered as text. */
    text: z.string().min(1).max(200),
    sponsor: z.object({
      name: z.string().min(1).max(60),
      url: httpsUrlSchema.optional(),
    }),
    /** 1200x630, like an app cover; hosted on the catalog site itself and pinned by digest. */
    image: indexMediaFileSchema.extend({ alt: z.string().min(1).max(200) }).optional(),
    link: z.object({ url: httpsUrlSchema, label: z.string().min(1).max(30) }).optional(),
    /** A catalog app this item promotes; the card then opens that app's page. */
    slug: z.string().min(1).optional(),
    startsAt: z.iso.datetime().optional(),
    endsAt: z.iso.datetime().optional(),
  })
  .refine((item) => item.link !== undefined || item.slug !== undefined, {
    message: "an item needs a link or a slug",
    path: ["link"],
  })
  .refine(
    (item) =>
      item.startsAt === undefined ||
      item.endsAt === undefined ||
      Date.parse(item.startsAt) < Date.parse(item.endsAt),
    { message: "endsAt must be after startsAt", path: ["endsAt"] },
  );
export type FeaturedItem = z.infer<typeof featuredItemSchema>;

/** Whether a featured item is inside its `startsAt`..`endsAt` window at `now`. */
export function isFeaturedItemActive(
  item: Pick<FeaturedItem, "startsAt" | "endsAt">,
  now: Date,
): boolean {
  const t = now.getTime();
  if (item.startsAt !== undefined && t < Date.parse(item.startsAt)) return false;
  if (item.endsAt !== undefined && t >= Date.parse(item.endsAt)) return false;
  return true;
}

/**
 * The published catalog index, `index.json`. `featured` is always written,
 * as an empty array while there is no sponsor; `stats` is the URL of the
 * catalog's popularity file (`catalogStatsSchema`), fetched with the index.
 */
export const indexJsonSchema = z
  .object({
    generatedAt: z.iso.datetime(),
    apps: z.array(indexAppSchema),
    featured: z.array(featuredItemSchema).default([]),
    stats: httpsUrlSchema.optional(),
  })
  .superRefine((index, ctx) => {
    const ids = new Set<string>();
    const slugs = new Set(index.apps.map((app) => app.slug));
    index.featured.forEach((item, i) => {
      if (ids.has(item.id)) {
        ctx.addIssue({ code: "custom", path: ["featured", i, "id"], message: "duplicate id" });
      }
      ids.add(item.id);
      if (item.slug !== undefined && !slugs.has(item.slug)) {
        ctx.addIssue({
          code: "custom",
          path: ["featured", i, "slug"],
          message: `no app "${item.slug}" in the index`,
        });
      }
    });
  });
export type IndexJson = z.infer<typeof indexJsonSchema>;
