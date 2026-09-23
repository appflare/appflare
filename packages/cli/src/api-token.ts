import { z } from "zod";
import { parseJsonOutput, type Wrangler, wranglerArgs } from "./wrangler.ts";

export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

const authTokenSchema = z.looseObject({ type: z.string(), token: z.string().optional() });

/**
 * The credential wrangler already holds (`wrangler auth token --json`), for
 * the few Cloudflare API calls no wrangler command makes. It stays in memory:
 * never printed, logged, or put in an error message. Null when wrangler has
 * none to give.
 */
export async function wranglerApiToken(wrangler: Wrangler): Promise<string | null> {
  const result = await wrangler.run(wranglerArgs.authToken());
  if (result.code !== 0) {
    return null;
  }
  try {
    return authTokenSchema.parse(parseJsonOutput("auth token", result.stdout)).token ?? null;
  } catch {
    return null;
  }
}
