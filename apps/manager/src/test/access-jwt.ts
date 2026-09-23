import type { AccessJwk } from "@appflare/cf-api";

/**
 * Test-only stand-in for a Cloudflare Access team: an RSA key pair, its JWK
 * set (what `/cdn-cgi/access/certs` serves), and a signer for
 * `Cf-Access-Jwt-Assertion` tokens with any claims.
 */

export const TEAM_DOMAIN = "appflare-test.cloudflareaccess.com";
export const AUD = "4714c1358e65fe4b408ad6d432a5f878f08194bdb4752441fd56faefa9b2b6f2";

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

export interface TestAccessTeam {
  kid: string;
  jwks: { keys: AccessJwk[] };
  sign(claims: Record<string, unknown>, header?: Record<string, unknown>): Promise<string>;
  /** Claims Access puts in a token for this application, valid for an hour from `nowMs`. */
  claims(nowMs: number, overrides?: Record<string, unknown>): Record<string, unknown>;
}

export async function createTestAccessTeam(kid = "test-kid-1"): Promise<TestAccessTeam> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const jwk: AccessJwk = {
    kid,
    kty: "RSA",
    alg: "RS256",
    use: "sig",
    n: publicJwk.n ?? "",
    e: publicJwk.e ?? "",
  };

  return {
    kid,
    jwks: { keys: [jwk] },
    async sign(claims, header = {}) {
      const head = base64UrlJson({ alg: "RS256", kid, typ: "JWT", ...header });
      const body = base64UrlJson(claims);
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        pair.privateKey,
        new TextEncoder().encode(`${head}.${body}`),
      );
      return `${head}.${body}.${base64Url(new Uint8Array(signature))}`;
    },
    claims(nowMs, overrides = {}) {
      const iat = Math.floor(nowMs / 1000);
      return {
        aud: [AUD],
        email: "admin@example.com",
        exp: iat + 3600,
        iat,
        nbf: iat,
        iss: `https://${TEAM_DOMAIN}`,
        type: "app",
        identity_nonce: "nonce",
        sub: "7335d417-61da-459d-899c-0a01c76a2f94",
        country: "US",
        ...overrides,
      };
    },
  };
}

/** A fetch that serves the given teams' keys at `/cdn-cgi/access/certs`, counting calls. */
export function certsFetch(jwks: () => { keys: AccessJwk[] }) {
  const calls: string[] = [];
  const fetch = async (input: string): Promise<Response> => {
    calls.push(input);
    return Response.json({ ...jwks(), public_cert: { kid: "x", cert: "pem" }, public_certs: [] });
  };
  return { fetch, calls };
}
