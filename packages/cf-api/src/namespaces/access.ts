import { z } from "zod";
import { CloudflareApiError } from "../errors";
import type { FetchLike, HttpApi } from "../http";
import type {
  AccessApp,
  AccessAppCoverage,
  AccessCerts,
  AccessIdentityProvider,
  AccessOrganization,
  AccessPolicy,
  AccessPolicyArgs,
  AccessReusablePolicy,
  AccessReusablePolicyArgs,
  AccessServiceToken,
  AccessServiceTokenWithSecret,
  CreateAccessAppArgs,
  CreateAccessServiceTokenArgs,
} from "../types";

const enc = encodeURIComponent;

/**
 * Deleting a service token that a policy still names is refused with this
 * code (`access.api.error.service_token_in_use`): take the token out of every
 * policy first, then delete it.
 */
export const ACCESS_SERVICE_TOKEN_IN_USE = 12139;

/** True when `error` is Cloudflare refusing to delete a service token a policy still uses. */
export function isServiceTokenInUse(error: unknown): boolean {
  return (
    error instanceof CloudflareApiError &&
    error.errors.some(
      (e) =>
        e.code === ACCESS_SERVICE_TOKEN_IN_USE ||
        e.message === "access.api.error.service_token_in_use",
    )
  );
}

/**
 * Cloudflare Access: the account's Zero Trust organization, self-hosted
 * applications, their policies (application-scoped and reusable), and service
 * tokens. Used by the manager's "Protect with Cloudflare Access" settings.
 *
 * Permissions: the organization and its identity providers need "Access:
 * Organizations, Identity Providers, and Groups" Read; applications and
 * policies need "Access: Apps and Policies" (Read to list, Edit to change);
 * service tokens need "Access: Service Tokens" (Read to list, Edit to change).
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

    /**
     * `POST /access/apps`. A self-hosted application protects one `domain` or
     * a list of `destinations`: `public` hostnames (with an optional path;
     * `host/open/*` covers everything under `/open/` on that host only) and
     * `worker` destinations (by script tag), which cover the Worker's
     * workers.dev URL, all its preview URLs, later ones included, and its
     * custom domains. A hostname no Worker serves yet is accepted and
     * protected from the first request. `policies` may reference reusable
     * policies by `{ id, precedence }`. Created from `destinations`, the
     * answer has `domain: null` and echoes `destinations`.
     */
    createApp(app: CreateAccessAppArgs): Promise<AccessApp> {
      return http.result("POST", http.acct("/access/apps"), { json: app });
    },

    /**
     * `PUT /access/apps/{id}`: replaces the application's settings with `app`
     * (to move it to another hostname, for one). Settings left out take their
     * defaults, so send every one the application was created with. Without
     * `policies` in the body the application keeps its policies, its id and
     * its audience tag; the answer lists its policies. Changing
     * `destinations` keeps the audience tag and the reusable policy
     * references too.
     */
    updateApp(appId: string, app: CreateAccessAppArgs): Promise<AccessApp> {
      return http.result("PUT", http.acct(`/access/apps/${enc(appId)}`), { json: app });
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

    /** `GET /access/policies` (paginated): the account's reusable policies. */
    listReusablePolicies(): Promise<AccessReusablePolicy[]> {
      return http.list("GET", http.acct("/access/policies"));
    },

    /** `GET /access/policies/{id}`. */
    getReusablePolicy(policyId: string): Promise<AccessReusablePolicy> {
      return http.result("GET", http.acct(`/access/policies/${enc(policyId)}`));
    },

    /**
     * `POST /access/policies`: a reusable policy, which applications then
     * reference as `{ id, precedence }` in their `policies`. For people:
     * `decision: "allow"` with `email` rules; for the manager's own requests:
     * `decision: "non_identity"` with a `service_token` rule.
     */
    createReusablePolicy(policy: AccessReusablePolicyArgs): Promise<AccessReusablePolicy> {
      return http.result("POST", http.acct("/access/policies"), { json: policy });
    },

    /**
     * `PUT /access/policies/{id}`: replaces the whole policy; every
     * application referencing it follows. The answer includes `app_count`.
     */
    updateReusablePolicy(
      policyId: string,
      policy: AccessReusablePolicyArgs,
    ): Promise<AccessReusablePolicy> {
      return http.result("PUT", http.acct(`/access/policies/${enc(policyId)}`), { json: policy });
    },

    /** `DELETE /access/policies/{id}`. */
    deleteReusablePolicy(policyId: string): Promise<{ id: string }> {
      return http.result("DELETE", http.acct(`/access/policies/${enc(policyId)}`));
    },

    /** `GET /access/service_tokens` (paginated). Never includes a secret. */
    listServiceTokens(): Promise<AccessServiceToken[]> {
      return http.list("GET", http.acct("/access/service_tokens"));
    },

    /**
     * `POST /access/service_tokens`. The answer is the only one that carries
     * `client_secret`; it cannot be read again, only replaced with
     * `rotateServiceToken`.
     */
    createServiceToken(token: CreateAccessServiceTokenArgs): Promise<AccessServiceTokenWithSecret> {
      return http.result("POST", http.acct("/access/service_tokens"), { json: token });
    },

    /**
     * `DELETE /access/service_tokens/{id}`. Refused with
     * {@link ACCESS_SERVICE_TOKEN_IN_USE} while a policy still names the
     * token (see {@link isServiceTokenInUse}).
     */
    deleteServiceToken(tokenId: string): Promise<AccessServiceToken> {
      return http.result("DELETE", http.acct(`/access/service_tokens/${enc(tokenId)}`));
    },

    /**
     * `POST /access/service_tokens/{id}/refresh`: renews the token's expiry
     * ("Refreshes the expiration of a service token"). The answer carries no
     * secret; the client id and secret stay as they were.
     */
    refreshServiceToken(tokenId: string): Promise<AccessServiceToken> {
      return http.result("POST", http.acct(`/access/service_tokens/${enc(tokenId)}/refresh`));
    },

    /**
     * `POST /access/service_tokens/{id}/rotate`: a new `client_secret`, in
     * this answer only. The previous secret stops working at
     * `previousSecretExpiresAt` (an ISO date-time), or at once without it.
     */
    rotateServiceToken(
      tokenId: string,
      options: { previousSecretExpiresAt?: string } = {},
    ): Promise<AccessServiceTokenWithSecret> {
      const json =
        options.previousSecretExpiresAt === undefined
          ? {}
          : { previous_client_secret_expires_at: options.previousSecretExpiresAt };
      return http.result("POST", http.acct(`/access/service_tokens/${enc(tokenId)}/rotate`), {
        json,
      });
    },
  };
}

/** `host/path` with the host lower-cased and the path as written. */
function normalizeAccessUri(uri: string): string {
  const trimmed = uri.trim();
  const slash = trimmed.indexOf("/");
  return slash === -1
    ? trimmed.toLowerCase()
    : `${trimmed.slice(0, slash).toLowerCase()}${trimmed.slice(slash)}`;
}

/**
 * Everything an Access application protects, from `domain`,
 * `self_hosted_domains` and its `public` destinations (an application created
 * from destinations has `domain: null`, so reading `domain` alone misses it).
 * `worker` destinations come back separately as script tags: which hostnames
 * they cover depends on the Worker. Other destination kinds are ignored.
 * Wildcards (`*.example.com`) are returned as written, not expanded.
 */
export function accessAppCoverage(
  app: Pick<AccessApp, "domain" | "self_hosted_domains" | "destinations">,
): AccessAppCoverage {
  const uris = new Set<string>();
  const workerIds = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    const uri = normalizeAccessUri(value);
    if (uri.length > 0) uris.add(uri);
  };
  add(app.domain);
  for (const domain of app.self_hosted_domains ?? []) add(domain);
  for (const destination of app.destinations ?? []) {
    if (destination.type === "public") add(destination.uri);
    else if (destination.type === "worker" && typeof destination.worker_id === "string") {
      if (destination.worker_id.length > 0) workerIds.add(destination.worker_id);
    }
  }
  const hostnames = new Set([...uris].map((uri) => uri.split("/", 1)[0] as string));
  return { uris: [...uris], hostnames: [...hostnames], workerIds: [...workerIds] };
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
