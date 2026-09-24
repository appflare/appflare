import { appSecretSecretName, appTokenSecretName } from "@appflare/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createDb } from "../db/client";
import { installs, resources } from "../db/schema";
import { resourceId } from "../jobs/install/phases";
import { recordedCatalog } from "../jobs/self-deploying/phases";
import { activeSandboxJob, sandboxBusyMessage } from "../sandbox/busy";

/**
 * Entering a self-deploying app's own token (and secret values) again: when
 * it was rotated, or the sandbox Worker lost it (it was deleted and enabled
 * again). The values are stored as secrets on the sandbox Worker, exactly
 * where the install put them, with the manager's token; Appflare keeps no
 * copy, and the next update or uninstall uses them.
 */

export class AppCredentialsError extends Error {
  override name = "AppCredentialsError";
}

export const replaceAppCredentialsInput = z.object({
  installId: z.string().min(1).max(64),
  /** The app's new token; empty or absent keeps the one the sandbox Worker holds. */
  appToken: z.string().max(1024).optional(),
  /** New values of the app's secrets, by name; only names its catalog entry declares. */
  secrets: z.record(z.string().max(200), z.string().max(4096)).default({}),
});
export type ReplaceAppCredentialsInput = z.input<typeof replaceAppCredentialsInput>;

export interface AppCredentialsDeps {
  db: D1Database;
  /** `PUT /workers/scripts/appflare-sandbox/secrets` with the manager's token. */
  putSandboxSecret(name: string, value: string): Promise<void>;
  now?: () => Date;
}

/** Stores what the admin entered on the sandbox Worker; returns the names stored. */
export async function replaceAppCredentialsCore(
  deps: AppCredentialsDeps,
  raw: ReplaceAppCredentialsInput,
): Promise<{ stored: string[] }> {
  const input = replaceAppCredentialsInput.parse(raw);
  const orm = createDb(deps.db);
  const [install] = await orm
    .select({
      status: installs.status,
      buildKind: installs.build_kind,
      manifestJson: installs.manifest_json,
    })
    .from(installs)
    .where(eq(installs.id, input.installId))
    .limit(1);
  if (install === undefined) throw new AppCredentialsError("There is no such install.");
  if (install.buildKind !== "self-deploying") {
    throw new AppCredentialsError("Only apps that deploy themselves have a token in Appflare.");
  }
  if (install.status === "uninstalled") {
    throw new AppCredentialsError("This install is uninstalled.");
  }
  const catalog = recordedCatalog(install.manifestJson);
  if (catalog === null) {
    throw new AppCredentialsError(
      "The install never got as far as its installer; install the app again instead.",
    );
  }
  const declared = new Set(catalog.secrets.map((s) => s.name));
  const unknown = Object.keys(input.secrets).filter((name) => !declared.has(name));
  if (unknown.length > 0) {
    throw new AppCredentialsError(`${catalog.name} does not take: ${unknown.join(", ")}.`);
  }
  const token = input.appToken?.trim() ?? "";
  const secrets = Object.entries(input.secrets).filter(([, value]) => value.length > 0);
  if (token.length === 0 && secrets.length === 0) {
    throw new AppCredentialsError("Enter the token, a secret, or both.");
  }
  // Each secret change restarts the sandbox Worker, killing any run in it.
  const busy = await activeSandboxJob(orm);
  if (busy !== null) {
    const message = sandboxBusyMessage(busy);
    throw new AppCredentialsError(`${message[0]?.toUpperCase() ?? ""}${message.slice(1)}.`);
  }
  const stored: string[] = [];
  if (token.length > 0) {
    await deps.putSandboxSecret(appTokenSecretName(input.installId), token);
    stored.push("app token");
  }
  const at = (deps.now ?? (() => new Date()))();
  for (const [name, value] of secrets) {
    await deps.putSandboxSecret(appSecretSecretName(input.installId, name), value);
    await orm
      .insert(resources)
      .values({
        id: resourceId(input.installId, "secret", name),
        install_id: input.installId,
        kind: "secret",
        binding: name,
        name,
        cf_id: null,
        created_at: at,
        managed_by: "app",
      })
      .onConflictDoNothing();
    stored.push(name);
  }
  return { stored };
}
