/**
 * The owner claim in `/setup#claim=<code>`: the one-time code the handoff
 * gives the page that installed this manager, which opens owner setup with
 * it. A fragment never reaches a server or a `Referer`; `/setup` takes it
 * out of the address bar before anything else and exchanges it for the
 * setup claim cookie. Client-safe.
 */

/** What a code looks like (43 characters as issued; the installing page accepts 16 to 256). */
export const OWNER_CLAIM_FORMAT = /^[A-Za-z0-9_-]{16,256}$/;

/** The code in a `#claim=<code>` fragment, or null when there is none or it is malformed. */
export function ownerClaimFromHash(hash: string): string | null {
  if (!hash.startsWith("#")) return null;
  const code = new URLSearchParams(hash.slice(1)).get("claim");
  return code !== null && OWNER_CLAIM_FORMAT.test(code) ? code : null;
}

/** What exchanging a code came to: done, refused for good, or no definite answer yet. */
export type RedeemResult = "ok" | "refused" | "retry";

/**
 * Exchanges `code` with `call` (the server function). `refused` only when
 * the server said so (used, expired, malformed); no connection, an error,
 * or a request to wait is `retry`, and the code is kept for Try again.
 */
export async function redeemOwnerClaimWith(
  call: (code: string) => Promise<{ outcome: "ok" | "refused" | "rate-limited" }>,
  code: string | null,
): Promise<RedeemResult> {
  if (code === null) return "refused";
  try {
    const { outcome } = await call(code);
    return outcome === "rate-limited" ? "retry" : outcome;
  } catch {
    return "retry";
  }
}

/** What `/setup` says about a code that did not go through: refused, or Try again. */
export type ClaimNotice = { kind: "refused" } | { kind: "retry"; code: string };

/**
 * The notice for the first step, where a code that went through would have
 * led past (none on any other step, and none when it went through).
 */
export function claimNoticeFor(
  taken: { code: string | null } | null,
  result: RedeemResult | null,
  firstStep: boolean,
): ClaimNotice | null {
  if (!firstStep || taken === null || result === null || result === "ok") return null;
  if (result === "retry" && taken.code !== null) return { kind: "retry", code: taken.code };
  return { kind: "refused" };
}

/**
 * Removes a `#claim=` fragment from the address bar (so it stays in
 * neither history nor a later page's view). Null when the address had
 * none; else its code, or null `code` when it was malformed.
 */
export function takeOwnerClaimFromAddressBar(
  w: Pick<Window, "location" | "history"> | undefined = typeof window === "undefined"
    ? undefined
    : window,
): { code: string | null } | null {
  if (w === undefined) return null;
  const { hash, pathname, search } = w.location;
  if (!hash.startsWith("#") || !new URLSearchParams(hash.slice(1)).has("claim")) return null;
  w.history.replaceState(w.history.state, "", pathname + search);
  return { code: ownerClaimFromHash(hash) };
}
