import type { TelemetryLock } from "@appflare/schema";
import { z } from "zod";

/**
 * Anonymous usage data: what the setup step, the home page notice and
 * Settings show. Client-safe (no bindings).
 *
 * Nothing is sent until an admin has seen the notice: on a new manager in
 * the setup step, on a manager updated from a version without usage data in
 * a notice on the home page. Seeing it once records the choice; Settings
 * changes it later. A Worker variable (`APPFLARE_TELEMETRY=off`, or
 * `DO_NOT_TRACK=1`) turns it off for good, whatever is stored.
 */

/** `unset` until an admin has seen the notice. */
export type TelemetryState = "on" | "off" | "unset";

export interface TelemetryStatus {
  state: TelemetryState;
  /** The Worker variable that turns usage data off, or null. */
  lockedBy: TelemetryLock | null;
  /** A development build (`0.0.0…`) never sends anything. */
  devBuild: boolean;
}

/** Where the admin saw the notice. */
export const NOTICE_SURFACES = ["setup", "banner"] as const;
export type NoticeSurface = (typeof NOTICE_SURFACES)[number];

export const acknowledgeNoticeInput = z.object({
  enabled: z.boolean(),
  via: z.enum(NOTICE_SURFACES),
});
export type AcknowledgeNoticeInput = z.infer<typeof acknowledgeNoticeInput>;

export const setTelemetryInput = z.object({ enabled: z.boolean() });

export const TELEMETRY_COPY = {
  title: "Anonymous usage data",
  notice:
    "Appflare sends a small daily report so we can see which versions and features are used and where installs and updates fail. It contains counts, versions, settings such as whether passkeys are on, and error categories. It never contains your Cloudflare account, email addresses, names, domains, secrets or tokens. It is sent from this Worker, not your browser, to PostHog's EU region, where the project is set to discard IP addresses.",
  switchLabel: "Send anonymous usage data",
  scope:
    "This switch covers this manager's reports. The installer (create-appflare) has its own: --no-telemetry, APPFLARE_TELEMETRY=off or DO_NOT_TRACK=1.",
  whatIsSent: "What is sent",
  continue: "Continue",
  lockedBy: (variable: TelemetryLock) =>
    `Turned off by the ${variable} variable on this Worker. Remove the variable to change this here.`,
  devBuild:
    "This is a development build of Appflare, which never sends usage data, whatever this switch says.",
  membersOnly: "Only admins can change it.",
  unanswered:
    "No admin has answered the usage-data notice yet, so nothing is sent. Turning the switch on here answers it.",
  preview: "Preview",
  previewDescription:
    "The next daily report, built now the same way the scheduled report builds it. Job events and the daily opened event are sent alongside it.",
} as const;
