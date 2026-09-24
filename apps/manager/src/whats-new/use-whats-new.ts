import { useCallback, useEffect, useState } from "react";
import { newestVersion, unreadCount } from "./release-notes";
import { getWhatsNew, markWhatsNewSeen, type WhatsNew } from "./whats-new.functions";

export interface WhatsNewState {
  /** Null until loaded (or when loading failed: the menu then shows no count). */
  data: WhatsNew | null;
  unread: number;
  /** What the viewer had seen before the last `markAllSeen`, for the "New" badges. */
  seenBefore: string | null;
  /** Marks every stored release as seen; the count drops to zero at once. */
  markAllSeen(): void;
}

/**
 * The account menu's "What's new": loads the stored release notes once per
 * page load (the sidebar stays mounted while pages change) and records what
 * the viewer has read. The count comes from the manager, never from GitHub.
 */
export function useWhatsNew(): WhatsNewState {
  const [data, setData] = useState<WhatsNew | null>(null);
  const [seenBefore, setSeenBefore] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getWhatsNew()
      .then((loaded) => {
        if (cancelled) return;
        setData(loaded);
        setSeenBefore(loaded.seen);
      })
      .catch(() => {
        // No count and an empty dialog; the rest of the menu works.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const markAllSeen = useCallback(() => {
    if (data === null) return;
    const newest = newestVersion(data.releases);
    setSeenBefore(data.seen);
    if (newest === null || unreadCount(data.releases, data.seen, data.current) === 0) return;
    setData({ ...data, seen: newest });
    markWhatsNewSeen({ data: { version: newest } }).catch(() => {
      // Not recorded: the count comes back on the next page load.
    });
  }, [data]);

  return {
    data,
    unread: data === null ? 0 : unreadCount(data.releases, data.seen, data.current),
    seenBefore,
    markAllSeen,
  };
}
