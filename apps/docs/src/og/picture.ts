import { pngSize } from "./png-size.ts";

/**
 * A picture a card draws in a window: a PNG as a data URI, with its size in
 * pixels so the card can scale and crop it without decoding it first.
 */
export interface OgPicture {
  src: string;
  width: number;
  height: number;
}

/** A PNG's bytes as a picture, or null when they are not a PNG. */
export function pngPicture(bytes: Uint8Array): OgPicture | null {
  const size = pngSize(bytes);
  if (size === null) return null;
  return { src: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`, ...size };
}
