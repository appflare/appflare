import { z } from "zod";

/**
 * Verification of the `Cf-Access-Jwt-Assertion` header Cloudflare Access adds
 * to every request it lets through: an RS256 JWT signed by the team's keys.
 * Framework-free; the signing keys come from a lookup so tests can supply
 * their own. The token itself never appears in a result, error, or log line.
 */

export const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

/** Why a request's token was refused. Safe to log: no token material. */
export type AccessJwtFailure =
  | "missing"
  | "malformed"
  | "unsupported-algorithm"
  | "unknown-key"
  | "bad-signature"
  | "expired"
  | "not-yet-valid"
  | "wrong-audience"
  | "wrong-issuer"
  | "keys-unavailable";

export interface AccessJwtExpectation {
  /** The application audience tag. */
  aud: string;
  /** `<team>.cloudflareaccess.com`; the issuer is `https://` + this. */
  teamDomain: string;
}

export interface AccessIdentity {
  email: string | null;
  sub: string | null;
}

export type AccessJwtResult =
  | { ok: true; identity: AccessIdentity }
  | { ok: false; reason: AccessJwtFailure };

/**
 * Resolves a key id to a verification key. Returns null when the team has no
 * such key (after any refresh the lookup chooses to do); throws when the keys
 * cannot be fetched at all.
 */
export type AccessKeyLookup = (kid: string) => Promise<CryptoKey | null>;

/** Seconds of clock difference tolerated on `exp` and `nbf`. */
const CLOCK_SKEW_S = 30;

const headerSchema = z.looseObject({ alg: z.string(), kid: z.string().min(1) });

const payloadSchema = z.looseObject({
  aud: z.union([z.string(), z.array(z.string())]),
  iss: z.string(),
  exp: z.number(),
  nbf: z.number().optional(),
  email: z.string().optional(),
  sub: z.string().optional(),
});

export function base64UrlDecode(input: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(input)) throw new Error("not base64url");
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJson(part: string): unknown {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(part)));
}

export async function verifyAccessJwt(
  token: string | null | undefined,
  expected: AccessJwtExpectation,
  keys: AccessKeyLookup,
  nowMs: number = Date.now(),
): Promise<AccessJwtResult> {
  if (token === null || token === undefined || token.length === 0) {
    return { ok: false, reason: "missing" };
  }
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [headerPart = "", payloadPart = "", signaturePart = ""] = parts;

  let header: z.infer<typeof headerSchema>;
  let payload: z.infer<typeof payloadSchema>;
  let signature: Uint8Array<ArrayBuffer>;
  try {
    const parsedHeader = headerSchema.safeParse(decodeJson(headerPart));
    const parsedPayload = payloadSchema.safeParse(decodeJson(payloadPart));
    if (!parsedHeader.success || !parsedPayload.success) return { ok: false, reason: "malformed" };
    header = parsedHeader.data;
    payload = parsedPayload.data;
    signature = base64UrlDecode(signaturePart);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  // Only RS256: Access signs with RSA keys, and accepting the header's choice
  // of algorithm (`none`, HS256 with the public key) is the classic JWT bypass.
  if (header.alg !== "RS256") return { ok: false, reason: "unsupported-algorithm" };

  let key: CryptoKey | null;
  try {
    key = await keys(header.kid);
  } catch {
    return { ok: false, reason: "keys-unavailable" };
  }
  if (key === null) return { ok: false, reason: "unknown-key" };

  const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signed);
  if (!valid) return { ok: false, reason: "bad-signature" };

  // Claims are checked only once the signature proves Access issued them.
  const nowS = nowMs / 1000;
  if (payload.exp + CLOCK_SKEW_S <= nowS) return { ok: false, reason: "expired" };
  if (payload.nbf !== undefined && payload.nbf - CLOCK_SKEW_S > nowS) {
    return { ok: false, reason: "not-yet-valid" };
  }
  if (payload.iss !== `https://${expected.teamDomain}`) {
    return { ok: false, reason: "wrong-issuer" };
  }
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (expected.aud.length === 0 || !audiences.includes(expected.aud)) {
    return { ok: false, reason: "wrong-audience" };
  }
  return { ok: true, identity: { email: payload.email ?? null, sub: payload.sub ?? null } };
}
