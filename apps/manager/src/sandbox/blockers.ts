import { ne } from "drizzle-orm";
import type { Database } from "../db/client";
import { installs } from "../db/schema";
import { distinctLabels } from "../installs/display-name";
import { namedInstall } from "../installs/install-names.server";

/**
 * The installs that still need the sandbox Worker: every install built by it
 * (`sandbox`) or deployed by an installer it runs (`self-deploying`) that is
 * not uninstalled. Their updates, reinstalls and uninstalls run there, and a
 * sandbox build's artifact lives in its bucket, so sandbox builds cannot be
 * disabled while any exists.
 */
export interface SandboxInstall {
  id: string;
  /** What Settings calls it (`distinctLabels`): its display name, else the app's name. */
  label: string;
}

export async function installsNeedingSandbox(orm: Database): Promise<SandboxInstall[]> {
  const rows = await orm
    .select({
      id: installs.id,
      app_slug: installs.app_slug,
      worker_name: installs.worker_name,
      display_name: installs.display_name,
      manifest_json: installs.manifest_json,
      build_kind: installs.build_kind,
    })
    .from(installs)
    .where(ne(installs.status, "uninstalled"));
  // Every install is read so the labels match the sidebar's, which tells apart all of them.
  const labels = distinctLabels(rows.map(namedInstall));
  return rows
    .filter((r) => r.build_kind === "sandbox" || r.build_kind === "self-deploying")
    .map((r) => ({ id: r.id, label: labels.get(r.id) ?? r.worker_name }));
}

/** Why disabling is refused while `blocking` exist. */
export function sandboxInUseMessage(blocking: readonly SandboxInstall[]): string {
  const names = blocking.map((i) => i.label);
  return `Sandbox builds are in use by ${names.length === 1 ? "the app" : `${names.length} apps`} ${names.join(", ")}, built or deployed in the sandbox Worker. Uninstall ${names.length === 1 ? "it" : "them"} first, then disable sandbox builds.`;
}
