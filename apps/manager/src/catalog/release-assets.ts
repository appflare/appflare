import { indexArtifactsSchema } from "@appflare/schema";
import type { z } from "zod";

/**
 * The three assets of a release on GitHub (Appflare's own `manager@<version>`,
 * the sandbox Worker's `sandbox@<version>`, or a catalog app's): the zip, its
 * `manifest.json` and `manifest.sig`, as the catalog index lists them without
 * the manifest's digest, which a release feed does not carry. A job that has
 * the digest carries it beside them. Client-safe.
 */
export const releaseAssetsSchema = indexArtifactsSchema.omit({ digest: true });
export type ReleaseAssets = z.infer<typeof releaseAssetsSchema>;
