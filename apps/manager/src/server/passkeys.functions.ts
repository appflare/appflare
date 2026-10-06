import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import {
  listOwnPasskeys,
  type PasskeyRow,
  removeOwnPasskey,
  withPasskeyHosts,
} from "../auth/passkeys.server";
import { readPasskeyHosts } from "../domains/manager-address.server";
import { passkeyMoveNotice } from "../domains/pending-address.server";
import { currentAuth, requireSession } from "./auth.server";
import { removePasskeyInput } from "./schemas";
import { authErrorMessage } from "./users.server";

export type { PasskeyRow } from "../auth/passkeys.server";

/**
 * Settings → Passkeys. Any signed-in user, members included, manages their own
 * passkeys: a passkey is a way to sign in to their own account, not a change to
 * the manager. Adding one needs the browser's WebAuthn prompt, so that goes
 * through the auth client directly (`authClient.passkey.addPasskey`).
 *
 * A passkey added at an address Appflare has since left names that address
 * (`worksAt`): the browser offers it only there.
 */
export const listPasskeys = createServerFn({ method: "GET" }).handler(
  async (): Promise<PasskeyRow[]> => {
    await requireSession();
    const request = getRequest();
    const rows = await listOwnPasskeys(currentAuth(), request.headers);
    const hosts = await readPasskeyHosts(
      env.DB,
      rows.map((r) => r.id),
    );
    return withPasskeyHosts(rows, hosts, new URL(request.url).hostname);
  },
);

/**
 * The domain Appflare is about to move to, while this request comes to its
 * workers.dev address: a passkey made here would work only here, so none is
 * offered until the move. Null otherwise.
 */
export const getPasskeyMoveNotice = createServerFn({ method: "GET" }).handler(
  async (): Promise<string | null> => {
    await requireSession();
    return passkeyMoveNotice(env.DB, new URL(getRequest().url).hostname);
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
