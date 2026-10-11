import { useEffect, useState } from "react";
import { type SiteEvents, track } from "../../analytics/analytics.ts";
import { canShare, copyText, pageUrl, shareOrCopy } from "../../in-app/share.ts";

/** How long a button says the link was copied. */
export const COPIED_MS = 2000;

export type LinkActionState = "idle" | "copied" | "failed";

type Reason = SiteEvents["handoff_action"]["reason"];

/**
 * Copy and share for the page at `path`, counted as {@link SiteEvents.handoff_action}.
 * `state` says the link was just copied (for {@link COPIED_MS}), or that
 * neither the clipboard nor the share sheet worked, so the page should show
 * the link to copy by hand.
 */
export function useLinkActions(path: string, title: string, reason: Reason) {
  const [state, setState] = useState<LinkActionState>("idle");
  // Read once the page runs; empty while it is prerendered.
  const [sharing, setSharing] = useState(false);
  useEffect(() => setSharing(canShare()), []);

  useEffect(() => {
    if (state !== "copied") return;
    const timer = setTimeout(() => setState("idle"), COPIED_MS);
    return () => clearTimeout(timer);
  }, [state]);

  const page = () => window.location.pathname;

  async function copy() {
    if (await copyText(pageUrl(path))) {
      setState("copied");
      track("handoff_action", { action: "copy", reason, page: page() });
    } else {
      setState("failed");
    }
  }

  async function share() {
    const outcome = await shareOrCopy(pageUrl(path), title);
    if (outcome === "shared") track("handoff_action", { action: "share", reason, page: page() });
    else if (outcome === "copied") {
      setState("copied");
      track("handoff_action", { action: "copy", reason, page: page() });
    } else if (outcome === "failed") setState("failed");
  }

  return { state, sharing, copy, share };
}

/** The link, selected at a tap, for a browser that lets the page neither copy nor share. */
export function LinkToCopy({ path }: { path: string }) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="text-fd-muted-foreground">Copy the link from here:</span>
      <input
        type="text"
        readOnly
        value={pageUrl(path)}
        onFocus={(event) => event.currentTarget.select()}
        className="h-11 w-full rounded-lg border border-fd-border bg-fd-secondary px-3 font-mono text-[16px] text-fd-foreground outline-none focus-visible:ring-2 focus-visible:ring-fd-ring"
      />
    </label>
  );
}
