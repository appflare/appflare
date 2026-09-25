import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { runningVersion } from "./build-version";

/**
 * The running Appflare version, for the footer of the sign-in and setup
 * screens. No session needed: `/api/health` already answers it to anyone.
 */
export const getAppflareVersion = createServerFn({ method: "GET" }).handler(
  async (): Promise<string> => runningVersion(env),
);

/**
 * `getAppflareVersion` for a loader: null when the call fails or answers
 * something else (a Cloudflare Access refusal comes back as a JSON body), so a
 * missing version never keeps a sign-in screen from rendering.
 */
export async function loadAppflareVersion(): Promise<string | null> {
  try {
    const version: unknown = await getAppflareVersion();
    return typeof version === "string" && version.length > 0 ? version : null;
  } catch {
    return null;
  }
}
