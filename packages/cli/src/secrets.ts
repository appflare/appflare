import { randomBytes } from "node:crypto";

/** `BETTER_AUTH_SECRET`: 32 random bytes, base64url (43 characters). */
export function generateBetterAuthSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** `SETUP_TOKEN`: 24 random bytes as 48 lowercase hex characters. */
export function generateSetupToken(): string {
  return randomBytes(24).toString("hex");
}

/**
 * The link that opens the manager's first-run wizard:
 * `https://<name>.<subdomain>.workers.dev/setup?token=<SETUP_TOKEN>`.
 */
export function formatSetupUrl(workerUrl: string, setupToken: string): string {
  const url = new URL(workerUrl);
  if (url.protocol !== "https:") {
    throw new Error(`expected an https:// Worker URL, got ${workerUrl}`);
  }
  url.pathname = "/setup";
  url.search = "";
  url.hash = "";
  url.searchParams.set("token", setupToken);
  return url.toString();
}
