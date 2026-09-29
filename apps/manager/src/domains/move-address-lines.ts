import { settingsPlace } from "../components/settings-links";

/**
 * What the job that moves Appflare's address says, shared by the job and the
 * pages that follow it. Client-safe: no bindings.
 */

/** How long the job waits for the new address to answer as this Appflare. */
export const MOVE_WAIT_MINUTES = 15;
export const MOVE_WAIT_MS = MOVE_WAIT_MINUTES * 60_000;

/** The job's steps, as its log and its failure messages name them. */
export const MOVE_STEPS = {
  wait: "Waiting for the certificate and the new address",
  access: "Moving Cloudflare Access",
  switch: "Switching the address",
  detach: "Detaching the old domain",
} as const;

/** Where a move is started again. */
const DOMAINS_SETTINGS = settingsPlace("domains", "address");

export const MOVE_LINES = {
  start: (hostname: string, from: string | null) =>
    from === null
      ? `Moving Appflare to ${hostname}.`
      : `Moving Appflare from ${from} to ${hostname}.`,
  waiting: (hostname: string, version: string) =>
    `${MOVE_STEPS.wait}: https://${hostname}/api/health must answer as Appflare ${version}.`,
  notYet: (last: string) =>
    `Not answering yet; certificates can take a few minutes (last answer: ${last}).`,
  answers: (hostname: string) => `${hostname} answers as this Appflare.`,
  access: (hostname: string) => `${MOVE_STEPS.access} to ${hostname}.`,
  accessMoved: (hostname: string) => `Cloudflare Access now protects ${hostname}.`,
  switched: (hostname: string, from: string) =>
    from === hostname
      ? `${MOVE_STEPS.switch}: Appflare now lives at ${hostname}.`
      : `${MOVE_STEPS.switch}: Appflare now lives at ${hostname}, and ${from} sends page visits there.`,
  detach: (hostname: string) => `${MOVE_STEPS.detach} ${hostname}.`,
  detachFailed: (hostname: string) =>
    `Could not detach ${hostname}; it still points at Appflare's Worker. Remove it from the Worker's domains in the Cloudflare dashboard.`,
  done: (hostname: string) => `Appflare now lives at ${hostname}. Everyone signs in again there.`,
} as const;

/** The sentence every failed move ends with: the new domain stays, and the move can start again. */
function staysAttached(hostname: string, replacedRecords: boolean): string {
  const records = replacedRecords
    ? " The DNS records it replaced are gone, and Appflare cannot put them back."
    : "";
  return `${hostname} stays attached to Appflare's Worker.${records} Start the move again from ${DOMAINS_SETTINGS}.`;
}

export const MOVE_FAILURES = {
  /** The new address never answered as this Appflare within the wait. */
  neverAnswered: (hostname: string, last: string, replacedRecords: boolean) =>
    `${hostname} never answered as this Appflare within ${MOVE_WAIT_MINUTES} minutes (last answer: ${last}), so Appflare stays at its current address. ${staysAttached(hostname, replacedRecords)} A new domain's certificate sometimes takes longer; a new move waits another ${MOVE_WAIT_MINUTES} minutes.`,
  /** A step failed before the switch. */
  stopped: (step: string, message: string, hostname: string, replacedRecords: boolean) =>
    `${step}: ${sentence(message)} Appflare stays at its current address. ${staysAttached(hostname, replacedRecords)}`,
  /** A step failed after the switch (recording the end of the job). */
  afterSwitch: (step: string, message: string, hostname: string) =>
    `${step}: ${sentence(message)} Appflare already lives at ${hostname}.`,
} as const;

function sentence(message: string): string {
  const trimmed = message.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** What a move job's `input_json` records (no secrets: names and ids only). */
export interface MoveJobInput {
  hostname: string;
  zoneId: string;
  /** The custom domain a change leaves; null for a move from workers.dev. */
  from: string | null;
  /** The sign-in page at the new address, where the browser goes once the job succeeded. */
  url: string;
}

export function moveInputOf(json: string | null): MoveJobInput {
  let input: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(json ?? "{}");
    if (typeof value === "object" && value !== null) input = value as Record<string, unknown>;
  } catch {
    // An unreadable input names nothing; the fields below fall back.
  }
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    hostname: str(input.hostname),
    zoneId: str(input.zoneId),
    from: typeof input.from === "string" ? input.from : null,
    url: str(input.url),
  };
}
