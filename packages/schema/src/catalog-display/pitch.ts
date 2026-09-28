/**
 * The one line under an app's name on a catalog tile: the catalog's
 * `tagline`. Every entry has one, checked when the manifest is written (one
 * line, at most 80 characters, no trailing period), so it is shown as it is.
 */
export function appPitch(app: { tagline: string }): string {
  return app.tagline;
}
