import { passkeyClient } from "@better-auth/passkey/client";
import { adminClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { accessControl, roles } from "./roles";

/**
 * Browser-side Better Auth client: sign-in, sign-out, and the browser half of
 * the passkey ceremonies (sign in with a passkey, add one). Session state, user
 * management, and listing or removing passkeys go through server functions,
 * which enforce the guards. Same-origin, so no base URL is needed.
 */
export const authClient = createAuthClient({
  plugins: [adminClient({ ac: accessControl, roles }), passkeyClient()],
});
