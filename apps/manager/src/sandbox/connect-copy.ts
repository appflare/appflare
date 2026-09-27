import { settingsPlace } from "../components/settings-links";

/**
 * Where an admin enables, updates and disables sandbox builds in the manager,
 * as a link inside a message ("Enable sandbox builds in <link> first").
 * Client-safe.
 */
export const ENABLE_SANDBOX_PLACE = settingsPlace(
  "building",
  "sandbox",
  "the Building apps settings",
);

/** How messages tell an admin to bring the sandbox Worker up to this manager's release. */
export const UPDATE_SANDBOX_HINT = `choose Update sandbox in ${ENABLE_SANDBOX_PLACE}`;
