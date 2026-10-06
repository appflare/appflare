import { z } from "zod";
import { handoffProof, newChallenge } from "./handoff-secret.ts";
import type { FetchLike } from "./installer-api.ts";

/**
 * The new Appflare's handoff API, called from the browser at the address
 * the visitor chose. Nothing is sent to an address until it proves it is
 * this installation: `GET /api/handoff?challenge=` must return the HMAC that
 * only a Worker holding this secret's hash can compute. A page that merely
 * answers, or a redirect, does not count. Requests send no cookies and no
 * referrer, and never follow a redirect.
 */

export const HANDOFF_PATH = "/api/handoff";

export type HandoffState = "waiting" | "received" | "done";

export type ProbeResult =
  | { kind: "verified"; state: HandoffState }
  /** `unreachable`: no answer (DNS, certificate, network). `other`: an answer that is not this installation's proof. */
  | { kind: "unverified"; reason: "unreachable" | "other" };

/** What the browser hands over. The access token is not part of it. */
export interface HandoffRequest {
  secret: string;
  grant: { refreshToken: string; clientId: string; scopes: string[] };
  accountId: string;
  /** Where Appflare reports, once its owner exists, so the installer forgets the record. */
  installer: { url: string; installationId: string; key: string };
}

export type HandoffFailure =
  /** An owner exists already. */
  | "done"
  /** The secret was refused. */
  | "refused"
  /** Too many attempts from this address; wait. */
  | "rate-limited"
  /** No answer, or a server error. */
  | "unreachable"
  /** An answer that is not a valid handoff answer for this address. */
  | "invalid";

export class HandoffError extends Error {
  override name = "HandoffError";
  constructor(readonly kind: HandoffFailure) {
    super(`The handoff failed: ${kind}`);
  }
}

export interface ManagerApi {
  probe(address: string, secret: string): Promise<ProbeResult>;
  /** Returns the owner setup URL, already checked to be on `address`. */
  handOff(address: string, request: HandoffRequest): Promise<string>;
}

const proofSchema = z.object({
  app: z.literal("appflare"),
  proof: z.string().min(1).max(200),
  state: z.enum(["waiting", "received", "done"]),
});

const handoffAnswerSchema = z.object({ ok: z.literal(true), ownerSetupUrl: z.string() });

/** Constant-time comparison of two short strings of public length. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Whether `url` is the owner setup page on `address` with a claim in its
 * fragment: the only place the page sends the visitor afterwards.
 */
export function isOwnerSetupUrl(url: string, address: string): boolean {
  let target: URL;
  let origin: string;
  try {
    target = new URL(url);
    origin = new URL(address).origin;
  } catch {
    return false;
  }
  return (
    target.protocol === "https:" &&
    target.origin === origin &&
    target.pathname === "/setup" &&
    target.search === "" &&
    /^#claim=[A-Za-z0-9_-]{16,256}$/.test(target.hash)
  );
}

const MAX_ANSWER_LENGTH = 16 * 1024;

async function readJson(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    return text.length > MAX_ANSWER_LENGTH ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

const requestDefaults = {
  credentials: "omit",
  redirect: "error",
  referrerPolicy: "no-referrer",
  cache: "no-store",
  mode: "cors",
} as const satisfies RequestInit;

export function managerApi(fetch: FetchLike): ManagerApi {
  return {
    async probe(address, secret) {
      const challenge = newChallenge();
      let response: Response;
      try {
        response = await fetch(`${address}${HANDOFF_PATH}?challenge=${challenge}`, {
          ...requestDefaults,
          method: "GET",
          headers: { accept: "application/json" },
        });
      } catch {
        return { kind: "unverified", reason: "unreachable" };
      }
      if (response.status !== 200) return { kind: "unverified", reason: "other" };
      const parsed = proofSchema.safeParse(await readJson(response));
      if (!parsed.success) return { kind: "unverified", reason: "other" };
      const expected = await handoffProof(secret, challenge);
      if (!sameText(parsed.data.proof.replace(/=+$/, ""), expected)) {
        return { kind: "unverified", reason: "other" };
      }
      return { kind: "verified", state: parsed.data.state };
    },

    async handOff(address, request) {
      let response: Response;
      try {
        response = await fetch(`${address}${HANDOFF_PATH}`, {
          ...requestDefaults,
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(request),
        });
      } catch {
        throw new HandoffError("unreachable");
      }
      const body = await readJson(response);
      if (response.status === 409) throw new HandoffError("done");
      if (response.status === 403) throw new HandoffError("refused");
      if (response.status === 429) throw new HandoffError("rate-limited");
      if (response.status >= 500) throw new HandoffError("unreachable");
      const parsed = handoffAnswerSchema.safeParse(body);
      if (!response.ok || !parsed.success) throw new HandoffError("invalid");
      if (!isOwnerSetupUrl(parsed.data.ownerSetupUrl, address)) throw new HandoffError("invalid");
      return parsed.data.ownerSetupUrl;
    },
  };
}
