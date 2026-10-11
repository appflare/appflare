/**
 * Moving a page to another browser or device: its address on this site, the
 * clipboard, and the system's share sheet. Each reads the browser only when
 * called, so a page can be prerendered with them.
 */

/** The full address of `path` on the site the page was opened from. */
export function pageUrl(path: string): string {
  return new URL(path, window.location.origin).href;
}

/** Puts `text` on the clipboard. False where the browser refuses (some in-app browsers do). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Whether this browser has a share sheet the page can open. */
export function canShare(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.share === "function";
}

export type ShareOutcome =
  /** The visitor sent it somewhere from the share sheet. */
  | "shared"
  /** They closed the share sheet without choosing anything. */
  | "cancelled"
  /** There was no share sheet, or it failed, so the link was copied instead. */
  | "copied"
  /** Neither worked. */
  | "failed";

/** Opens the share sheet with `url`; where there is none, or it fails, copies the link. */
export async function shareOrCopy(url: string, title: string): Promise<ShareOutcome> {
  if (canShare()) {
    try {
      await navigator.share({ url, title });
      return "shared";
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return "cancelled";
    }
  }
  return (await copyText(url)) ? "copied" : "failed";
}
