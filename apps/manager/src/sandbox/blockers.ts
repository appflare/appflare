import { and, inArray, ne } from "drizzle-orm";
import type { Database } from "../db/client";
import { installs } from "../db/schema";

/**
 * The installs that still need the sandbox Worker: every install built by it
 * (`sandbox`) or deployed by an installer it runs (`self-deploying`) that is
 * not uninstalled. Their updates, reinstalls and uninstalls run there, and a
 * sandbox build's artifact lives in its bucket, so sandbox builds cannot be
 * disabled while any exists.
 */
export interface SandboxInstall {
  id: string;
  /** What Settings calls it: the admin's name for it, else its Worker. */
  label: string;
}

export async function installsNeedingSandbox(orm: Database): Promise<SandboxInstall[]> {
  const rows = await orm
    .select({
      id: installs.id,
      workerName: installs.worker_name,
      displayName: installs.display_name,
    })
    .from(installs)
    .where(
      and(
        inArray(installs.build_kind, ["sandbox", "self-deploying"]),
        ne(installs.status, "uninstalled"),
      ),
    );
  return rows.map((r) => ({ id: r.id, label: r.displayName ?? r.workerName }));
}

/** Why disabling is refused while `blocking` exist. */
export function sandboxInUseMessage(blocking: readonly SandboxInstall[]): string {
  const names = blocking.map((i) => i.label);
  return `Sandbox builds are in use by ${names.length === 1 ? "the app" : `${names.length} apps`} ${names.join(", ")}, built or deployed in the sandbox Worker. Uninstall ${names.length === 1 ? "it" : "them"} first, then disable sandbox builds.`;
}
