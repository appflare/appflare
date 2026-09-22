import { z } from "zod";
import type { FetchLike } from "./release.ts";
import { parseJsonOutput, type Wrangler, wranglerArgs } from "./wrangler.ts";

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

const authTokenSchema = z.looseObject({ type: z.string(), token: z.string().optional() });
const subdomainSchema = z.looseObject({
  success: z.boolean(),
  result: z.looseObject({ subdomain: z.string().min(1) }).nullable(),
});

/**
 * The workers.dev URL of `worker` in the chosen account, for `status`. No
 * wrangler command prints it without deploying, so this reads the account's
 * workers.dev subdomain with one GET, authenticated with the credential
 * wrangler already holds (`wrangler auth token --json`). The credential stays
 * in memory: it is never printed, logged, or put in an error message.
 * Returns null when it cannot be determined.
 */
export async function resolveWorkersDevUrl(
  wrangler: Wrangler,
  fetchFn: FetchLike,
  worker: string,
): Promise<string | null> {
  if (!wrangler.accountId) {
    return null;
  }
  const result = await wrangler.run(wranglerArgs.authToken());
  if (result.code !== 0) {
    return null;
  }
  let token: string | undefined;
  try {
    token = authTokenSchema.parse(parseJsonOutput("auth token", result.stdout)).token;
  } catch {
    return null;
  }
  if (!token) {
    return null;
  }
  try {
    const response = await fetchFn(
      `${CLOUDFLARE_API}/accounts/${encodeURIComponent(wrangler.accountId)}/workers/subdomain`,
      { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) {
      return null;
    }
    const body = subdomainSchema.parse(await response.json());
    return body.result ? `https://${worker}.${body.result.subdomain}.workers.dev` : null;
  } catch {
    return null;
  }
}
