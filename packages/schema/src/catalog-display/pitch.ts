/**
 * The one line under an app's name on a catalog tile. The catalog's
 * `tagline` when the entry has one; otherwise the first clause of its
 * summary, which is usually what the app does: "A Memos-compatible notes
 * app. Runs on D1 and R2." becomes "A Memos-compatible notes app".
 */

/** Where a summary's first clause ends: a sentence end, a colon or semicolon, a dash, or a "built on" tail. */
const CLAUSE_END = /[:;](\s|$)|\.(\s|$)| [—–] |, (on|with|using|built on) /;

/** A clause shorter than this is too little to stand alone, so the whole summary is kept. */
const MIN_CLAUSE_LENGTH = 12;

/** The first clause of `summary`, without its closing punctuation. */
export function pitchFromSummary(summary: string): string {
  const text = summary.trim();
  const cut = text.search(CLAUSE_END);
  const clause = cut >= MIN_CLAUSE_LENGTH ? text.slice(0, cut) : text;
  return clause.replace(/[.\s]+$/, "");
}

/** The pitch of an app: its tagline, else the first clause of its summary. */
export function appPitch(app: { tagline?: string | undefined; summary: string }): string {
  const tagline = app.tagline?.trim();
  return tagline !== undefined && tagline !== "" ? tagline : pitchFromSummary(app.summary);
}
