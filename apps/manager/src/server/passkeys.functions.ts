import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { listOwnPasskeys, type PasskeyRow, removeOwnPasskey } from "../auth/passkeys.server";
import { currentAuth, requireSession } from "./auth.server";
import { removePasskeyInput } from "./schemas";
import { authErrorMessage } from "./users.server";

export type { PasskeyRow } from "../auth/passkeys.server";

/**
 * Settings → Passkeys. Any signed-in user, members included, manages their own
 * passkeys: a passkey is a way to sign in to their own account, not a change to
 * the manager. Adding one needs the browser's WebAuthn prompt, so that goes
 * through the auth client directly (`authClient.passkey.addPasskey`).
 */
export const listPasskeys = createServerFn({ method: "GET" }).handler(
  async (): Promise<PasskeyRow[]> => {
    await requireSession();
    return listOwnPasskeys(currentAuth(), getRequest().headers);
  },
);

export const removePasskey = createServerFn({ method: "POST" })
  .validator(removePasskeyInput)
  .handler(async ({ data }) => {
    await requireSession();
    try {
      await removeOwnPasskey(currentAuth(), getRequest().headers, data.id);
    } catch (error) {
      throw new Error(authErrorMessage(error, "Could not remove the passkey."));
    }
  });
