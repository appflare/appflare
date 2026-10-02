import type { CloudflareClient } from "@appflare/cf-api";
import { eq } from "drizzle-orm";
import { createDb } from "../db/client";
import { installs } from "../db/schema";
import {
  acceptedOf,
  pendingOf,
  readAcceptedBypass,
  writeAcceptedBypass,
} from "./accepted-paths.server";
import { accessAddressSync } from "./address-sync.server";
import { readInstallProtection } from "./protect.server";
import { storedBypassPaths } from "./stored-access.server";
import { AccessToggleError, withAccessLock } from "./toggle.server";

/**
 * "Make public" on a protected app's page: an admin accepts the paths the
 * card showed as waiting (`shown`), and only those the app's catalog entry
 * still lists when the click arrives (`access.bypass`, from the newest
 * revision recorded for its release), under the Access lock; then its Access
 * applications are brought in step. A path a revision added after the page
 * loaded is not accepted: it stays waiting, and the card shows it after the
 * reload. Until accepted, a path a revision added asks for a sign-in like
 * the rest of the app (accepted-paths.server.ts). Answers why the sync
 * failed (the cron tries again), or null, and what still waits.
 */
export async function makePublicPathsCore(
  deps: { db: D1Database; client: () => Promise<CloudflareClient>; now?: () => Date },
  installId: string,
  shown: readonly string[],
): Promise<{ problem: string | null; accepted: string[]; pending: string[] }> {
  if ((await readInstallProtection(deps.db, installId)) === null) {
    throw new AccessToggleError(
      "This app is not protected with Cloudflare Access, so every path of it is public already.",
    );
  }
  const { accepted, pending } = await withAccessLock(deps.db, async () => {
    const orm = createDb(deps.db);
    const [install] = await orm
      .select({ manifestJson: installs.manifest_json, artifactDigest: installs.artifact_digest })
      .from(installs)
      .where(eq(installs.id, installId))
      .limit(1);
    if (install === undefined) throw new AccessToggleError("This app no longer exists.");
    const listed = await storedBypassPaths(orm, install);
    const before = await readAcceptedBypass(orm, installId);
    const now = acceptedOf(listed, [...before, ...shown]);
    await writeAcceptedBypass(orm, installId, now);
    return { accepted: now, pending: pendingOf(listed, now) };
  });
  const problem = await accessAddressSync(deps.db, deps.client, deps.now)(installId);
  return { problem, accepted, pending };
}
