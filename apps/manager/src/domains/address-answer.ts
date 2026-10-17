import { ACCESS_CHALLENGE_DETAIL } from "../jobs/install/health";

/**
 * What the new address answered instead of this Appflare, as a fixed word:
 * the job's wait reads it, and so does the anonymous usage report, which
 * never carries the answer itself. From the verdicts `managerVerdict` and
 * `identityVerdict` write:
 * - `address_no_connection`: no connection at all (no certificate yet, or no DNS record);
 * - `address_certificate`: Cloudflare's 525 or 526 (the TLS handshake or the certificate);
 * - `address_not_attached`: an edge error page Cloudflare shows while it attaches a
 *   hostname to a Worker (530, and error codes 1001, 1016, 1018, 522 and 1042);
 * - `address_access_sign_in`: Cloudflare Access asked for a sign-in;
 * - `address_redirect`: a redirect (a zone rule, or something else at the hostname);
 * - `address_http_error`: any other HTTP error status;
 * - `address_not_appflare`: HTTP 200 from something that is not Appflare;
 * - `address_other_appflare`: another Appflare (its handoff proof differs);
 * - `address_other_version`: Appflare of another version;
 * - `address_other`: anything else.
 */
export const ADDRESS_ANSWERS = [
  "address_no_connection",
  "address_certificate",
  "address_not_attached",
  "address_access_sign_in",
  "address_redirect",
  "address_http_error",
  "address_not_appflare",
  "address_other_appflare",
  "address_other_version",
  "address_other",
] as const;
export type AddressAnswer = (typeof ADDRESS_ANSWERS)[number];

const NOT_ATTACHED_CODES: ReadonlySet<string> = new Set(["1001", "1016", "1018", "1042", "522"]);

export function addressAnswerOf(last: string): AddressAnswer {
  if (last.startsWith("no connection")) return "address_no_connection";
  if (last === ACCESS_CHALLENGE_DETAIL) return "address_access_sign_in";
  if (last === "HTTP 200 from something that is not Appflare") return "address_not_appflare";
  if (last.startsWith("another Appflare")) return "address_other_appflare";
  if (/^Appflare \S+, not \S+$/.test(last)) return "address_other_version";
  const http = /^HTTP (\d{3})(?:, error code (\d+))?$/.exec(last);
  if (http === null) return "address_other";
  const status = Number(http[1]);
  if (status === 525 || status === 526) return "address_certificate";
  if (status === 530 || (http[2] !== undefined && NOT_ATTACHED_CODES.has(http[2]))) {
    return "address_not_attached";
  }
  if (status >= 300 && status < 400) return "address_redirect";
  return "address_http_error";
}

/** Whether the answer says the certificate or the address is still on its way, so waiting longer may help. */
export function answerStillComing(last: string): boolean {
  const answer = addressAnswerOf(last);
  return (
    answer === "address_no_connection" ||
    answer === "address_certificate" ||
    answer === "address_not_attached"
  );
}
