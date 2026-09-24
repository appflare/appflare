import { z } from "zod";
import { parseJsonOutput, type Wrangler, wranglerArgs } from "./wrangler.ts";

export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

/** An account id and the bearer token to call the Cloudflare API with for it. */
export interface ApiAccess {
  accountId: string;
  token: string;
}

const authTokenSchema = z.looseObject({ type: z.string(), token: z.string().optional() });

/**
 * The credential wrangler already holds (`wrangler auth token --json`) and its
 * kind: `oauth` for a `wrangler login`, `api_token` for `CLOUDFLARE_API_TOKEN`
 * in the environment, `api_key` for a global API key (which has no bearer
 * token). The token stays in memory: never printed, logged, or put in an
 * error message. Null when wrangler has none to give.
 */
export interface WranglerCredential {
  type: "oauth" | "api_token" | "api_key" | (string & {});
  token: string | null;
}

export async function wranglerCredential(wrangler: Wrangler): Promise<WranglerCredential | null> {
  const result = await wrangler.run(wranglerArgs.authToken());
  if (result.code !== 0) {
    return null;
  }
  try {
    const parsed = authTokenSchema.parse(parseJsonOutput("auth token", result.stdout));
    return { type: parsed.type, token: parsed.token ?? null };
  } catch {
    return null;
  }
}

/**
 * The bearer token wrangler holds, for the few Cloudflare API calls no
 * wrangler command makes. Null when wrangler has none to give.
 */
export async function wranglerApiToken(wrangler: Wrangler): Promise<string | null> {
  return (await wranglerCredential(wrangler))?.token ?? null;
}
