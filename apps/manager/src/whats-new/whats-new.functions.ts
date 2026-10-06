import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createDb } from "../db/client";
import { requireSession } from "../server/auth.server";
import { runningVersion } from "../server/build-version";
import type { ReleaseNote } from "./release-notes";
import { readReleaseNotes } from "./release-notes.server";
import { markSeen, readSeenVersion } from "./seen.server";

/** "What's new" in the account menu: Appflare's release notes and what the viewer has read. */

export interface WhatsNew {
  /** The running Appflare version (`runningVersion`). */
  current: string;
  /** Newest first; empty until the release check has run. */
  releases: ReleaseNote[];
  /** The newest version the viewer has seen here, or null before their first look. */
  seen: string | null;
}

/** Any signed-in user: the stored release notes (never fetched from GitHub here). */
export const getWhatsNew = createServerFn({ method: "GET" }).handler(
  async (): Promise<WhatsNew> => {
    const session = await requireSession();
    const [releases, seen] = await Promise.all([
      readReleaseNotes(env.KV),
      readSeenVersion(createDb(env.DB), session.user.id),
    ]);
    return { current: runningVersion(env), releases, seen };
  },
);

/**
 * Any signed-in user: records that they have read the notes up to
 * `version` (the newest release they were shown). Never moves backwards.
 */
export const markWhatsNewSeen = createServerFn({ method: "POST" })
  .validator(z.object({ version: z.string().min(1).max(64) }))
  .handler(async ({ data }): Promise<{ seen: string }> => {
    const session = await requireSession();
    const seen = await markSeen(createDb(env.DB), session.user.id, data.version);
    return { seen };
  });
