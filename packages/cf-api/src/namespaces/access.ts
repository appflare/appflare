import { z } from "zod";
import type { FetchLike, HttpApi } from "../http";
import type {
  AccessApp,
  AccessCerts,
  AccessIdentityProvider,
  AccessOrganization,
  AccessPolicy,
  AccessPolicyArgs,
  CreateAccessAppArgs,
} from "../types";

const enc = encodeURIComponent;

/**
 * Cloudflare Access: the account's Zero Trust organization, self-hosted
 * applications, and their application-scoped policies. Used by the manager's
 * optional "Protect with Cloudflare Access" setting.
 *
 * Permissions: the organization and its identity providers need "Access:
 * Organizations, Identity Providers, and Groups" Read; applications and policies need "Access: Apps
 * and Policies" (Read to list, Edit to change).
 */
export function createAccess(http: HttpApi) {
  return {
    /**
     * `GET /access/organizations`. Answers 404 when the account has no Zero
     * Trust organization yet.
     */
    getOrganization(): Promise<AccessOrganization> {
      return http.result("GET", http.acct("/access/organizations"));
    },

    /**
     * `GET /access/identity_providers`: the login methods the organization
     * offers (One-time PIN, the Cloudflare account, an identity provider).
     */
    listIdentityProviders(): Promise<AccessIdentityProvider[]> {
      return http.list("GET", http.acct("/access/identity_providers"));
    },

    /** `GET /access/apps` (paginated). */
    listApps(): Promise<AccessApp[]> {
      return http.list("GET", http.acct("/access/apps"));
    },

    /** `GET /access/apps/{id}`. */
    getApp(appId: string): Promise<AccessApp> {
      return http.result("GET", http.acct(`/access/apps/${enc(appId)}`));
    },

    /** `POST /access/apps`. */
    createApp(app: CreateAccessAppArgs): Promise<AccessApp> {
      return http.result("POST", http.acct("/access/apps"), { json: app });
    },

    /** `DELETE /access/apps/{id}`. Also removes the application's own policies. */
    deleteApp(appId: string): Promise<{ id: string }> {
      return http.result("DELETE", http.acct(`/access/apps/${enc(appId)}`));
    },

    /** `POST /access/apps/{id}/policies`: an application-scoped policy. */
    createPolicy(appId: string, policy: AccessPolicyArgs): Promise<AccessPolicy> {
      return http.result("POST", http.acct(`/access/apps/${enc(appId)}/policies`), {
        json: policy,
      });
    },

    /** `PUT /access/apps/{id}/policies/{policy_id}`: replaces the whole policy. */
    updatePolicy(appId: string, policyId: string, policy: AccessPolicyArgs): Promise<AccessPolicy> {
      return http.result("PUT", http.acct(`/access/apps/${enc(appId)}/policies/${enc(policyId)}`), {
        json: policy,
      });
    },
  };
}

/**
 * A team domain as the organization reports it (`auth_domain`). Only
 * `<team>.cloudflareaccess.com` is accepted, so a stored value can never point
 * the key fetch at another host.
 */
const TEAM_DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;

export function isAccessTeamDomain(value: string): boolean {
  return TEAM_DOMAIN.test(value);
}

/** The team's public signing keys: `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`. */
export function accessCertsUrl(teamDomain: string): string {
  if (!isAccessTeamDomain(teamDomain)) {
    throw new Error(`Not a Cloudflare Access team domain: ${teamDomain}`);
  }
  return `https://${teamDomain}/cdn-cgi/access/certs`;
}

const certsSchema = z.object({
  keys: z.array(
    z.looseObject({
      kid: z.string().min(1),
      kty: z.literal("RSA"),
      alg: z.string().optional(),
      use: z.string().optional(),
      n: z.string().min(1),
      e: z.string().min(1),
    }),
  ),
});

/** Thrown when the team's keys cannot be fetched or are not the expected shape. */
export class AccessCertsError extends Error {
  override name = "AccessCertsError";
}

/**
 * Fetches the RSA keys Access signs `Cf-Access-Jwt-Assertion` with. Not a
 * Cloudflare REST API call: the URL is public and takes no token. The response
 * also carries PEM copies of the same keys (`public_cert`, `public_certs`);
 * only the JWKs are read.
 */
export async function fetchAccessCerts(
  teamDomain: string,
  options: { fetch?: FetchLike } = {},
): Promise<AccessCerts> {
  const url = accessCertsUrl(teamDomain);
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const res = await fetchImpl(url, { method: "GET", headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new AccessCertsError(`GET ${url} -> ${res.status}`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new AccessCertsError(`GET ${url} returned a body that is not JSON`);
  }
  const parsed = certsSchema.safeParse(body);
  if (!parsed.success) {
    throw new AccessCertsError(`GET ${url} returned keys in an unexpected shape`);
  }
  return {
    keys: parsed.data.keys.map(({ kid, kty, alg, use, n, e }) => ({
      kid,
      kty,
      n,
      e,
      ...(alg === undefined ? {} : { alg }),
      ...(use === undefined ? {} : { use }),
    })),
  };
}
