import { adminClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { accessControl, roles } from "./roles";

/**
 * Browser-side Better Auth client: sign-in and sign-out only. Session state and
 * user management go through server functions, which enforce the guards.
 * Same-origin, so no base URL is needed.
 */
export const authClient = createAuthClient({
  plugins: [adminClient({ ac: accessControl, roles })],
});
