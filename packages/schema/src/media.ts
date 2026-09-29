/**
 * Limits for a catalog entry's images, which a catalog publishes next to its
 * index (`media` on an index row): an icon, a cover and screenshots. Any
 * catalog, the official one or a custom one, checks its images against these
 * before it publishes them, so every manager can show them the same way.
 *
 * - Icon: an SVG, or a square PNG of {@link MIN_ICON_PX} to
 *   {@link MAX_ICON_PX} pixels a side; at most {@link MAX_ICON_BYTES}.
 * - Cover: a PNG of exactly {@link COVER_WIDTH} by {@link COVER_HEIGHT}
 *   pixels (the size of an OpenGraph preview); at most {@link MAX_COVER_BYTES}.
 * - Screenshots: at most {@link MAX_SCREENSHOTS} PNGs, each side
 *   {@link MIN_SCREENSHOT_PX} to {@link MAX_SCREENSHOT_PX} pixels, each at
 *   most {@link MAX_SCREENSHOT_BYTES}.
 */

/** A cover's width in pixels. */
export const COVER_WIDTH = 1200;

/** A cover's height in pixels. */
export const COVER_HEIGHT = 630;

/** The smallest side of a PNG icon, in pixels. */
export const MIN_ICON_PX = 64;

/** The largest side of a PNG icon, in pixels. */
export const MAX_ICON_PX = 1024;

/** Most screenshots one entry lists. */
export const MAX_SCREENSHOTS = 8;

/** The largest icon file, SVG or PNG: 256 KiB. */
export const MAX_ICON_BYTES = 256 * 1024;

/** The largest cover file: 1 MiB. */
export const MAX_COVER_BYTES = 1024 * 1024;

/** The largest screenshot file: 2 MiB. */
export const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;

/** The smallest side of a screenshot, in pixels. */
export const MIN_SCREENSHOT_PX = 320;

/** The largest side of a screenshot, in pixels. */
export const MAX_SCREENSHOT_PX = 2560;
