import type { FetchLike } from "@appflare/cf-api";

/**
 * Proving that an address serves this installation. The manager holds
 * `APPFLARE_HANDOFF = v1.<sha256 of the handoff secret>` and answers
 * `GET /api/handoff?challenge=<c>` with
 * `proof = base64url(HMAC-SHA256(key = the raw sha256 bytes, "appflare-handoff:" + c))`.
 * The installer knows that sha256 (the deploy page sent it) and computes the
 * same proof; any other page, an unrelated 200 included, cannot.
 */

export const HANDOFF_PATH = "/api/handoff";
const PROOF_PREFIX = "appflare-handoff:";

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A fresh challenge: 24 random bytes, 32 base64url characters. */
export function newChallenge(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(24)));
}

export async function expectedProof(handoffHash: string, challenge: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    hexToBytes(handoffHash),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(PROOF_PREFIX + challenge),
  );
  return base64url(new Uint8Array(mac));
}

/** Constant-time equality of two strings (both are short, public-length values). */
async function sameText(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(x, y);
}

export type HandoffState = "waiting" | "received" | "done";

export type ProbeResult =
  | { kind: "verified"; state: HandoffState; version: string | null }
  | { kind: "pending"; reason: PendingReason };

/**
 * Why the address does not prove itself yet. Every one is "keep waiting":
 * a new hostname takes a while for its DNS record and certificate, and a new
 * workers.dev route answers 404 before it answers at all.
 */
export type PendingReason =
  /** No connection, DNS or TLS failure, timeout. */
  | "unreachable"
  /** Cloudflare's own error page or a 404/5xx: the route or Worker is not live there yet. */
  | "not-live"
  /** A redirect instead of an answer. */
  | "redirect"
  /** Something answers, but not this installation. */
  | "other-page";

const PENDING_MESSAGES: Record<PendingReason, string> = {
  unreachable:
    "The address does not answer yet. A new address needs a minute or two for its DNS record and security certificate.",
  "not-live": "Cloudflare is still putting Appflare live at the address.",
  redirect:
    "The address answers with a redirect instead of Appflare. Still waiting for it to update.",
  "other-page":
    "Something answers at the address, but not this Appflare installation yet. Still waiting for it to update.",
};

export function pendingMessage(reason: PendingReason): string {
  return PENDING_MESSAGES[reason];
}

/** The handoff answer is a short JSON object; a longer body is not Appflare's. */
export const MAX_ANSWER_BYTES = 16 * 1024;

/**
 * The body as text, or null when it is longer than `limit` bytes. Reads at
 * most `limit` bytes (plus the chunk that passes it) and cancels the rest,
 * so an address that answers with something huge costs nothing more.
 */
export async function readAtMost(response: Response, limit: number): Promise<string | null> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) return null;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** One check of `address`, a single fetch that never follows redirects. */
export async function probeHandoff(
  fetch: FetchLike,
  address: string,
  handoffHash: string,
): Promise<ProbeResult> {
  const challenge = newChallenge();
  let response: Response;
  try {
    response = await fetch(`${address}${HANDOFF_PATH}?challenge=${challenge}`, {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/json", "user-agent": "appflare-installer" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "BudgetExceededError") throw error;
    return { kind: "pending", reason: "unreachable" };
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    return { kind: "pending", reason: "redirect" };
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    return { kind: "pending", reason: "not-live" };
  }
  let body: unknown;
  try {
    const text = await readAtMost(response, MAX_ANSWER_BYTES);
    body = text === null ? null : JSON.parse(text);
  } catch {
    return { kind: "pending", reason: "other-page" };
  }
  if (typeof body !== "object" || body === null) return { kind: "pending", reason: "other-page" };
  const { app, proof, state, version } = body as Record<string, unknown>;
  if (app !== "appflare" || typeof proof !== "string") {
    return { kind: "pending", reason: "other-page" };
  }
  const expected = await expectedProof(handoffHash, challenge);
  if (!(await sameText(proof.replace(/=+$/, ""), expected))) {
    return { kind: "pending", reason: "other-page" };
  }
  return {
    kind: "verified",
    state: state === "received" || state === "done" ? state : "waiting",
    version: typeof version === "string" ? version : null,
  };
}

/** The wait before the next check: short at first, then up to 15 seconds. */
export function proofRetryAfterMs(attempts: number): number {
  if (attempts <= 5) return 3_000;
  if (attempts <= 15) return 5_000;
  if (attempts <= 40) return 10_000;
  return 15_000;
}
