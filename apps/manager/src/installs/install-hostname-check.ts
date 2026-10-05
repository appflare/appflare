import { z } from "zod";

/**
 * The install form's live check of a custom domain's hostname (a name in one
 * of the account's domains), as the admin types it: whether the install job
 * could attach it. The job never fails over a domain: a name with DNS
 * records of its own, or one that serves another Worker, is left alone and
 * the app is installed on workers.dev only, with a warning in the log. So
 * the form warns about those and still lets the install start. A name
 * another app here holds is refused when the install starts, so the form
 * holds Install for it. Only a hint: the job checks again. Client-safe.
 */

/** How long typing pauses before the hostname is checked. */
export const HOSTNAME_CHECK_DELAY_MS = 400;

export const installHostnameInput = z.object({
  zoneId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  hostname: z.string().min(1).max(253),
  /** The Worker the domain would serve: a domain it has already is no conflict. */
  workerName: z.string().min(1).max(64),
  /** "Install again": the failed install whose removal first frees its domains. */
  replaces: z.string().min(1).max(64).optional(),
});
export type InstallHostnameInput = z.infer<typeof installHostnameInput>;

/** What the server answers about a hostname. */
export type InstallHostnameAnswer =
  | { state: "free" }
  /** DNS address records of its own (A, AAAA, CNAME) that the install would not replace. */
  | { state: "records"; records: Array<{ type: string; content: string | null }> }
  /**
   * The token lacks a permission Cloudflare needs to attach a name to a
   * Worker (Workers Routes: Edit), so the job's attach would be refused.
   */
  | { state: "cannot-attach"; missing: string[] }
  /** A custom domain of another Worker, which Appflare never moves. */
  | { state: "other-worker"; worker: string }
  /** A domain another app installed here records; starting the install refuses it. */
  | { state: "other-app" }
  /** The token could not read what the check needs (zone, Workers domains or DNS records). */
  | { state: "unknown" };

export type InstallHostnameCheck = InstallHostnameAnswer | { state: "checking" };

/** Whether the install may start with this check: not while another app holds the name. */
export function hostnameAllowsInstall(check: InstallHostnameCheck | null): boolean {
  return check?.state !== "other-app";
}

/** Whether the install job would leave the domain out and finish on workers.dev only. */
export function hostnameLeftOut(check: InstallHostnameCheck | null): boolean {
  return (
    check?.state === "records" ||
    check?.state === "other-worker" ||
    check?.state === "cannot-attach"
  );
}

/** "a CNAME record", "A and AAAA records": the kinds of records, for the tray. */
function recordWords(records: ReadonlyArray<{ type: string }>): string {
  const types = [...new Set(records.map((r) => r.type))];
  if (types.length === 0) return "DNS records";
  const list =
    types.length === 1 ? types[0] : `${types.slice(0, -1).join(", ")} and ${types.at(-1)}`;
  return types.length === 1 ? `a DNS record (${list})` : `DNS records (${list})`;
}

/**
 * The tray's one line about the hostname: green when it is free, amber when
 * the install would leave it out, red when another app holds it, a spinner
 * while it is checked, a quiet note when it could not be checked.
 */
export function hostnameStatus(
  check: InstallHostnameCheck | null,
): { tone: "success" | "warning" | "danger" | "pending" | "neutral"; text: string } | null {
  switch (check?.state) {
    case "checking":
      return { tone: "pending", text: "Checking the name…" };
    case "free":
      return { tone: "success", text: "Available" };
    case "records":
      return { tone: "warning", text: `This name already has ${recordWords(check.records)}.` };
    case "other-worker":
      return { tone: "warning", text: `This name already serves the Worker ${check.worker}.` };
    case "cannot-attach":
      return { tone: "warning", text: "The Cloudflare token cannot add domains to apps yet." };
    case "other-app":
      return { tone: "danger", text: "Another app here already uses this name. Choose another." };
    case "unknown":
      return { tone: "neutral", text: "Could not check whether the name is in use." };
    default:
      return null;
  }
}

/** The title of the note under the address while the install would leave the name out. */
export const LEFT_OUT_TITLE = "The install will leave this name out";

/**
 * What a name the install would leave out means, and the choices, for the
 * note under the address: what Cloudflare and the install do, then the ways
 * forward. Null for a name the install can use, and while a name is checked.
 */
export function hostnameConsequence(
  check: InstallHostnameCheck | null,
): { title: string; description: string } | null {
  const after = "so the app answers on its workers.dev address only.";
  switch (check?.state) {
    case "records":
      return {
        title: LEFT_OUT_TITLE,
        description: `It already has DNS records, which Cloudflare does not replace unless asked, ${after} Choose another name; delete the records in Cloudflare, then install; or install anyway and add the domain from the app's page later, where you can choose to replace them.`,
      };
    case "other-worker":
      return {
        title: LEFT_OUT_TITLE,
        description: `It already serves the Worker ${check.worker}, and Appflare never moves a domain away from another Worker, ${after} Choose another name, or remove the domain from ${check.worker} in Cloudflare, then install; you can also install anyway and add the domain from the app's page later.`,
      };
    case "cannot-attach":
      return {
        title: LEFT_OUT_TITLE,
        description: `Cloudflare needs ${check.missing.join(", ")} on this domain to add a name to an app, and the Appflare token does not have it, ${after} Add it to the token in Cloudflare (API Tokens, edit the Appflare token), then install; or install anyway and add the domain from the app's page once it is added.`,
      };
    default:
      return null;
  }
}
