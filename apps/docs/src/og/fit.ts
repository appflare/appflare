/**
 * Picks the font size a line of text is drawn at on an OpenGraph card, so a
 * short title is large and a long one still fits its lines. The renderer has
 * no auto-fit of its own, so the width of the text is estimated from the
 * advance widths of Geist (the card font), and the words are wrapped the way
 * the renderer wraps them: greedily, at spaces.
 */

/** Advance width of a character in Geist, as a fraction of the font size. */
function advance(char: string, bold: boolean): number {
  const scale = bold ? 1.06 : 1;
  if (char === " ") return 0.26 * scale;
  if (/[.,:;'!|ilj]/.test(char)) return 0.26 * scale;
  if (/[ftr()[\]/-]/.test(char)) return 0.36 * scale;
  if (/[mwMW]/.test(char)) return 0.84 * scale;
  if (/[A-Z0-9]/.test(char)) return 0.66 * scale;
  return 0.56 * scale;
}

/** The estimated width of `text` at `size` pixels. */
export function textWidth(text: string, size: number, bold = false): number {
  let em = 0;
  for (const char of text) em += advance(char, bold);
  return em * size;
}

/** How many lines `text` wraps to within `width` at `size`, wrapping at spaces. */
export function lineCount(text: string, width: number, size: number, bold = false): number {
  const words = text
    .trim()
    .split(/\s+/)
    .filter((word) => word !== "");
  if (words.length === 0) return 0;
  let lines = 1;
  let line = "";
  for (const word of words) {
    const next = line === "" ? word : `${line} ${word}`;
    if (line !== "" && textWidth(next, size, bold) > width) {
      lines += 1;
      line = word;
    } else {
      line = next;
    }
  }
  return lines;
}

export interface FitOptions {
  /** The width the text may take, in pixels. */
  width: number;
  /** The most lines it may wrap to. */
  lines: number;
  /** The size it is drawn at when it fits. */
  max: number;
  /** The smallest size it may shrink to; below this it is clamped instead. */
  min: number;
  bold?: boolean;
}

/**
 * The largest size, from `max` down to `min` in steps of 2, at which `text`
 * wraps to at most `lines` lines within `width`; `min` when none does (the
 * card then clamps the text to its lines).
 */
export function fitText(
  text: string,
  { width, lines, max, min, bold = false }: FitOptions,
): number {
  // A little room for the estimate being short of the real width.
  const room = width * 0.95;
  for (let size = max; size > min; size -= 2) {
    if (lineCount(text, room, size, bold) <= lines) return size;
  }
  return min;
}
