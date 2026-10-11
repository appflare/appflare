import { useEffect } from "react";
import { track } from "../../analytics/analytics.ts";
import { useBrowser } from "../../in-app/use-browser.ts";
import { LinkToCopy, useLinkActions } from "./link-actions.tsx";

/** The pages that counted the line once already, while this page is open. */
const counted = new Set<string>();

/** For tests: as if no page had shown the line yet. */
export function resetShareLinkCount(): void {
  counted.clear();
}

/** The line's height (its button's 44px tap target), on screens narrower than Tailwind's `sm`. */
const RESERVED = "max-sm:min-h-11";

/**
 * Under an install button, on a phone's own browser only: one quiet line to
 * send the page to a computer, where installing is easier. Its share sheet
 * where the browser has one, else it copies the link. Nothing anywhere else,
 * nor while the page is prerendered; an app's own browser gets the sheet the
 * install button opens instead (see `open-in-browser.tsx`).
 *
 * The built page is the same for every browser, so the line can only appear
 * once the page runs. With `reserve` (the default) the line's room is kept
 * free on a phone-sized screen from the first paint, so its appearance moves
 * nothing below it; where it does not appear (an app's own browser) that room
 * stays empty. `reserve={false}` for a line drawn only after the page runs,
 * or far below the first screen.
 */
export function ShareLinkLine({
  path,
  title,
  reserve = true,
  className = "",
}: {
  /** The page to send: see `OpenInBrowserSheet`. */
  path: string;
  title: string;
  reserve?: boolean;
  className?: string;
}) {
  const browser = useBrowser();
  const phone = browser?.kind === "phone";
  const { state, sharing, copy, share } = useLinkActions(path, title, "mobile");

  useEffect(() => {
    if (!phone) return;
    const page = window.location.pathname;
    if (counted.has(page)) return;
    counted.add(page);
    track("handoff_shown", { reason: "mobile", app: null, page });
  }, [phone]);

  if (!phone && !reserve) return null;
  const label = state === "copied" ? "Link copied" : sharing ? "Share this link" : "Copy this link";
  return (
    <div
      className={`not-prose grid gap-2 text-fd-muted-foreground text-sm ${reserve ? RESERVED : ""} ${className}`}
    >
      {phone && (
        <>
          <p className="m-0">
            Not at your computer?{" "}
            <button
              type="button"
              onClick={() => void (sharing ? share() : copy())}
              className="inline-flex min-h-11 cursor-pointer items-center rounded-sm font-medium text-fd-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-fd-ring focus-visible:outline-offset-2"
            >
              {label}
            </button>
            <span role="status" className="sr-only">
              {state === "copied" ? "Link copied" : ""}
            </span>
          </p>
          {state === "failed" && <LinkToCopy path={path} />}
        </>
      )}
    </div>
  );
}
