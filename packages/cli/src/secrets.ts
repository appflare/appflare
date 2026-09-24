import { randomBytes } from "node:crypto";

/** `BETTER_AUTH_SECRET`: 32 random bytes, base64url (43 characters). */
export function generateBetterAuthSecret(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The address to open to finish setup: the manager's own URL,
 * `https://<name>.<subdomain>.workers.dev/`. It carries no secret: the setup
 * page asks for a Cloudflare API token for the account the manager runs in.
 */
export function formatManagerUrl(workerUrl: string): string {
  const url = new URL(workerUrl);
  if (url.protocol !== "https:") {
    throw new Error(`expected an https:// Worker URL, got ${workerUrl}`);
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}
