import { and, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import { install_access } from "../db/schema";

/**
 * The public paths an admin accepted for a protected app
 * (`install_access.accepted_bypass_json`). A catalog revision may change the
 * paths an entry lists without a new version or a job. Taking one off makes
 * the app more private, so it applies on its own; adding one would open part
 * of the app to everyone, so it waits for an admin: only paths the entry
 * lists *and* an admin accepted are made public (bypass.server.ts).
 *
 * Every admin action that carries the entry's paths accepts them: installing
 * the app protected, protecting it or protecting it again, an update, a
 * rollback, and "Make public" on the app's page. Null (no row, or none
 * recorded) reads as none, so nothing is ever made public by default.
 */

const pathsSchema = z.array(z.string());

function parsePaths(json: string | null | undefined): string[] {
  if (json == null) return [];
  try {
    const parsed = pathsSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** The paths an admin accepted for the install; empty when none are recorded. */
export async function readAcceptedBypass(orm: Database, installId: string): Promise<string[]> {
  const [row] = await orm
    .select({ json: install_access.accepted_bypass_json })
    .from(install_access)
    .where(eq(install_access.install_id, installId))
    .limit(1);
  return parsePaths(row?.json);
}

/**
 * Records `paths` as accepted for a protected install (each once, in order).
 * Does nothing for an install Appflare does not protect.
 */
export async function writeAcceptedBypass(
  orm: Database,
  installId: string,
  paths: readonly string[],
): Promise<void> {
  await orm
    .update(install_access)
    .set({ accepted_bypass_json: JSON.stringify([...new Set(paths)]) })
    .where(and(eq(install_access.install_id, installId), isNotNull(install_access.access_app_id)));
}

/** The listed paths that may be public: those an admin accepted. */
export function acceptedOf(listed: readonly string[], accepted: readonly string[]): string[] {
  const ok = new Set(accepted);
  return listed.filter((p) => ok.has(p));
}

/** The listed paths still waiting for an admin to make them public. */
export function pendingOf(listed: readonly string[], accepted: readonly string[]): string[] {
  const ok = new Set(accepted);
  return listed.filter((p) => !ok.has(p));
}
