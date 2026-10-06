import { constantTimeEquals } from "../auth/constant-time";
import { HANDOFF_PATH, handoffProof } from "../handoff/handoff-proof";
import { probeHealth } from "../jobs/install/health";
import { managerVerdict } from "./manager-address.server";

/**
 * Whether a hostname "answers as this Appflare", before Appflare moves there.
 *
 * - Every manager: `https://<host>/api/health` answers HTTP 200 with JSON
 *   whose `version` is the version this manager runs. That shows an
 *   Appflare of the same version serves the hostname; it does not show it
 *   is this one, since any Appflare of that version answers the same.
 * - A manager installed from the browser (`APPFLARE_HANDOFF` is bound) also
 *   proves it is this installation: `https://<host>/api/handoff?challenge=<random>`
 *   must answer HTTP 200 with `app: "appflare"`, the same `version`, and a
 *   `proof` equal to the HMAC this manager computes from its own handoff
 *   hash and the fresh challenge (handoff/handoff-proof.ts). Only a Worker
 *   holding the same `APPFLARE_HANDOFF`, which is this manager's Worker, can
 *   answer that. It replaces the health probe for such a manager.
 *
 * Null when it does; otherwise what answered instead, in a few words.
 */
export async function identityVerdict(
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
  hostname: string,
  expected: { version: string; handoffHash: string | null },
): Promise<string | null> {
  if (expected.handoffHash === null) {
    return managerVerdict(
      await probeHealth(fetchImpl, `https://${hostname}/api/health`),
      expected.version,
    );
  }
  const challenge = randomChallenge();
  const probe = await probeHealth(
    fetchImpl,
    `https://${hostname}${HANDOFF_PATH}?challenge=${challenge}`,
  );
  // The status, the edge's error codes and the version, as for the health probe.
  const verdict = managerVerdict(probe, expected.version);
  if (verdict !== null || probe.kind !== "response") return verdict;
  // managerVerdict parsed this JSON already, so it parses here too.
  const answer = JSON.parse(probe.body ?? probe.bodyStart) as {
    app?: unknown;
    proof?: unknown;
  } | null;
  if (answer?.app !== "appflare" || typeof answer.proof !== "string") {
    return "HTTP 200 from something that is not Appflare";
  }
  const proof = await handoffProof(expected.handoffHash, challenge);
  return (await constantTimeEquals(answer.proof, proof))
    ? null
    : "another Appflare, not this one (its handoff proof differs)";
}

/** 32 random base64url characters: a fresh challenge for each probe. */
function randomChallenge(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
