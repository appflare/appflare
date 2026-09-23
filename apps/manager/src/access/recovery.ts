/**
 * How an admin who is locked out of an Access-protected manager gets back in.
 * Client-safe (no server imports): shown both in the settings dialog before
 * protection is turned on and on the manager's own 403 page.
 *
 * A locked-out admin usually fails the Access sign-in and sees Cloudflare's
 * page, not the manager's, so the Access application goes first; after that
 * the manager still requires Access tokens until its settings rows are gone.
 */

/** The name the Access application protecting `hostname` is created with. */
export function accessAppName(hostname: string): string {
  return `Appflare (${hostname})`;
}

/** Deletes the manager's Access settings; `DATABASE` is the manager's D1 database name. */
export const ACCESS_RECOVERY_COMMAND = `npx wrangler d1 execute DATABASE --remote --command "DELETE FROM settings WHERE key LIKE 'access_%'"`;

export function accessRecoverySteps(hostname: string | null): [string, string] {
  const app = hostname ? `"${accessAppName(hostname)}"` : `"Appflare (<the manager's hostname>)"`;
  return [
    `In the Zero Trust dashboard, under Access applications, delete the application named ${app}. Access then stops asking for a sign-in.`,
    "From a terminal where wrangler is signed in to this account, run the command below, replacing DATABASE with the manager's D1 database name (the DB binding on its Worker). The manager stops checking Access tokens within about 15 seconds.",
  ];
}
