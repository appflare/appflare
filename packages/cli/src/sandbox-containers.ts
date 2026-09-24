import { z } from "zod";
import { type ApiAccess, CLOUDFLARE_API, wranglerApiToken } from "./api-token.ts";
import type { FetchLike } from "./release.ts";
import type { Wrangler } from "./wrangler.ts";

/**
 * Finds container applications by exact name. `wrangler containers list
 * --json` returns only its first page (25 applications), so an account with
 * more could hide the sandbox Worker's; the Containers API filters by name on
 * the server instead: `GET /accounts/{account}/containers/applications?name=`.
 * Authenticated with wrangler's own credential, which is never shown.
 */

const applicationSchema = z.looseObject({ id: z.string(), name: z.string() });
/** A bare list, or the list in the usual `{ result }` envelope. */
const listSchema = z.union([
  z.array(applicationSchema),
  z.looseObject({ result: z.array(applicationSchema) }).transform((body) => body.result),
]);

export type ContainerApplication = z.infer<typeof applicationSchema>;

export async function findContainerApplications(
  wrangler: Wrangler,
  fetchFn: FetchLike,
  names: readonly string[],
): Promise<
  | { ok: true; applications: ContainerApplication[] }
  /** `status` is the HTTP status when Cloudflare answered with an error. */
  | { ok: false; reason: string; status?: number }
> {
  const accountId = wrangler.accountId;
  if (!accountId) {
    return { ok: false, reason: "no account is selected" };
  }
  const token = await wranglerApiToken(wrangler);
  if (!token) {
    return { ok: false, reason: "wrangler has no API credential to give (`wrangler auth token`)" };
  }
  const applications: ContainerApplication[] = [];
  try {
    for (const name of names) {
      const url = `${CLOUDFLARE_API}/accounts/${encodeURIComponent(accountId)}/containers/applications?name=${encodeURIComponent(name)}`;
      const response = await fetchFn(url, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        return {
          ok: false,
          reason: `listing container applications answered HTTP ${response.status}`,
          status: response.status,
        };
      }
      const parsed = listSchema.safeParse(await response.json());
      if (!parsed.success) {
        return { ok: false, reason: "the container application list was not readable" };
      }
      // Exact names only, whatever the filter matched.
      applications.push(...parsed.data.filter((app) => app.name === name));
    }
  } catch (error) {
    // Never the credential: only the error's own message.
    return {
      ok: false,
      reason: `the Cloudflare API call failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { ok: true, applications };
}

export type ContainersAccess =
  | { kind: "ok" }
  /** Cloudflare answered 401 or 403: no Workers Paid, or a token without Containers. */
  | { kind: "denied"; status: number }
  | { kind: "unknown"; reason: string };

/**
 * Whether a credential may use Containers, with the cheapest read there is:
 * the first container application list wrangler's deploy makes itself
 * (`GET /accounts/{account}/containers/applications`), filtered to one name.
 * Nothing is created or changed.
 */
export async function checkContainersAccess(
  fetchFn: FetchLike,
  access: ApiAccess,
  name: string,
): Promise<ContainersAccess> {
  const url = `${CLOUDFLARE_API}/accounts/${encodeURIComponent(access.accountId)}/containers/applications?name=${encodeURIComponent(name)}`;
  try {
    const response = await fetchFn(url, {
      headers: { authorization: `Bearer ${access.token}` },
      signal: AbortSignal.timeout(30_000),
    });
    // The body is not needed; drain it so the connection is released.
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403) {
      return { kind: "denied", status: response.status };
    }
    if (!response.ok) {
      return {
        kind: "unknown",
        reason: `listing container applications answered HTTP ${response.status}`,
      };
    }
    return { kind: "ok" };
  } catch (error) {
    // Never the credential: only the error's own message.
    return {
      kind: "unknown",
      reason: `the Cloudflare API call failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
