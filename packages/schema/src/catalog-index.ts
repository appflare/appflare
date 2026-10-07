import { z } from "zod";
import { ACCESS_REQUIREMENT, type AccessOffer, accessOfferOf, type CatalogAccess } from "./access";
import { sha256Schema } from "./artifact";
import {
  type CatalogManifest,
  catalogAuthorSchema,
  catalogRevisionSchema,
  catalogSlugSchema,
  expectedBuildMinutesSchema,
  gitShaSchema,
  installTierSchema,
  ownerRepoSchema,
  planSchema,
  type Requirement,
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
 * What an index row's `requires` may list besides the account capabilities
 * of the entry's own `requires`: a feature the manager needs to install the
 * entry. A manager reads `requires` against the values it knows and leaves
 * out a row with one it does not, asking to be updated ("could not be
 * shown"), so a manager from before a feature never offers an entry that
 * needs it. The schema keeps the value, so an index parsed and written again
 * still carries it; a manager or site that reads the index drops the
 * features it has with {@link readIndexApp}. Only index rows carry these; a
 * catalog manifest never does.
 */
export const MANAGER_FEATURES = {
  /**
   * The manager spreads one job over several Worker invocations: an entry of
   * more than {@link ONE_INVOCATION_FREE_WORKERS} Workers with
   * `"plan": "free"`. Managers before it ran a job in one invocation of the
   * 50 requests Workers Free allows, refused such an entry's release, and
   * refused to install more than three Workers on Workers Free.
   */
  spreadJobs: "manager:spread-jobs",
} as const;

export type ManagerFeature = (typeof MANAGER_FEATURES)[keyof typeof MANAGER_FEATURES];

const managerFeatureSchema = z.enum(Object.values(MANAGER_FEATURES) as [ManagerFeature]);

/** The most Workers of an entry with `"plan": "free"` a manager without `MANAGER_FEATURES.spreadJobs` installs. */
export const ONE_INVOCATION_FREE_WORKERS = 3;

/**
 * An index row's `requires` for a catalog manifest (the current one, which is
 * the revised one when the entry has a revision): the entry's own, then the
 * manager features it needs ({@link MANAGER_FEATURES}). Code that writes a
 * catalog index writes this, not the manifest's `requires` alone.
 */
export function indexRequires(manifest: {
  plan: CatalogManifest["plan"];
  requires: readonly string[];
  install: { workers?: readonly unknown[] | undefined };
}): string[] {
  const workers = manifest.install.workers?.length ?? 1;
  const spread = manifest.plan === "free" && workers > ONE_INVOCATION_FREE_WORKERS;
  return [...manifest.requires, ...(spread ? [MANAGER_FEATURES.spreadJobs] : [])];
}

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
    /** The manifest's public repository; absent in older catalog indexes. */
    repo: ownerRepoSchema.optional(),
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
    /**
     * The entry's account capabilities ({@link requirementSchema}), and the
     * manager features it needs ({@link MANAGER_FEATURES}). Kept as written,
     * so a catalog that parses its index and writes it again keeps them; a
     * reader drops the features with {@link readIndexApp}.
     */
    requires: z.array(z.union([requirementSchema, managerFeatureSchema])),
    lastVerified: z.iso.datetime().nullable(),
    /**
     * Who wrote the app: the catalog manifest's `authors`, or the owner of its
     * public repository when it lists none.
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
    /**
     * How the entry offers Cloudflare Access protection, from its (revised)
     * catalog manifest: `"required"`, `"recommended"` or `"offered"`
     * ({@link indexAccessOffer}); absent for a self-deploying entry, and in
     * rows written before this field. A plain string, not the enum, so a
     * manager still reads a row with a value added later (anything but
     * `"required"` is read as protection being optional). Managers that
     * predate it strip it. It tells an app that needs Cloudflare Access
     * only while protected from one that always does
     * ({@link indexAccessNeededOnlyIfProtected}).
     */
    accessOffer: z.string().min(1).optional(),
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
/** An index row as published, manager features in `requires` included. */
export type PublishedIndexApp = z.infer<typeof indexAppSchema>;

/**
 * An index row as a manager or the site reads it: `requires` lists the
 * entry's account capabilities only ({@link readIndexApp}).
 */
export type IndexApp = Omit<PublishedIndexApp, "requires"> & { requires: Requirement[] };

/**
 * A parsed row as its reader uses it: the manager features in `requires`
 * dropped. Parsing already refused a feature this release does not know, so
 * every one left is one it has.
 */
export function readIndexApp(row: PublishedIndexApp): IndexApp {
  return {
    ...row,
    requires: row.requires.filter((v): v is Requirement => requirementSchema.safeParse(v).success),
  };
}

/**
 * The index row's `accessOffer` for a catalog manifest (the revised one when
 * the entry has a revision): how it offers Cloudflare Access protection, or
 * undefined for a self-deploying entry, which cannot be protected.
 */
export function indexAccessOffer(catalog: {
  access?: CatalogAccess | undefined;
  install: { tier: string };
}): AccessOffer | undefined {
  return catalog.install.tier === "self-deploying" ? undefined : accessOfferOf(catalog);
}

/**
 * Whether an index row's app needs Cloudflare Access only while it is
 * protected: it lists `"access"` in `requires` and its row says protection
 * is not required. A row without `accessOffer` (written before the field)
 * says nothing, so its `"access"` counts as always needed.
 */
export function indexAccessNeededOnlyIfProtected(
  app: Pick<IndexApp, "requires"> & { accessOffer?: string | undefined },
): boolean {
  return (
    app.requires.includes(ACCESS_REQUIREMENT) &&
    app.accessOffer !== undefined &&
    app.accessOffer !== "required"
  );
}

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
/** The index as published. */
export type PublishedIndexJson = z.infer<typeof indexJsonSchema>;

/** The index as a manager or the site reads it ({@link readIndexApp} for each row). */
export type IndexJson = Omit<PublishedIndexJson, "apps"> & { apps: IndexApp[] };

/** A parsed index as its reader uses it. */
export function readIndexJson(index: PublishedIndexJson): IndexJson {
  return { ...index, apps: index.apps.map(readIndexApp) };
}
