import type { TelemetryLock } from "@appflare/schema";
import { z } from "zod";

/**
 * Anonymous usage data: what Settings, Usage data shows. Client-safe (no bindings).
 *
 * On by default: the scheduled report starts with the first run after setup
 * (and, on a manager updated from a version without usage data, the first
 * run after the update). No banner in the app announces it: Settings, the
 * docs and the installer's console notice disclose it. Settings turns it off;
 * a Worker variable (`APPFLARE_TELEMETRY=off`, or `DO_NOT_TRACK=1`) turns it
 * off for good, whatever is stored.
 */

/** The stored choice; with none stored, usage data is on. */
export type TelemetryState = "on" | "off";

export interface TelemetryStatus {
  state: TelemetryState;
  /** The Worker variable that turns usage data off, or null. */
  lockedBy: TelemetryLock | null;
  /** A development build (`0.0.0…`) never sends anything. */
  devBuild: boolean;
}

export const setTelemetryInput = z.object({ enabled: z.boolean() });

/**
 * Settings reads in one order: what leaving it on does for the people who
 * run Appflare, then the switch, then exactly what is and is not sent.
 */
export const TELEMETRY_COPY = {
  title: "Anonymous usage data",
  benefitsIntro: "Leaving this on helps everyone who runs Appflare. It lets the maintainers:",
  benefits: [
    "see which versions are in use, so they know which ones to keep supporting and test updates against;",
    "learn which install paths and apps fail, so fixes land sooner and updates break less often;",
    "know which features people use, so work goes where it matters.",
  ],
  sent: "What is sent: one small report a day with counts, versions, settings such as whether passkeys are on, and error categories, plus how each install and update went.",
  neverSent:
    "Never sent: your Cloudflare account, email addresses, names, domains, secrets or tokens. Reports go from this Worker, not your browser, to PostHog's EU region, where the project is set to discard IP addresses.",
  switchLabel: "Send anonymous usage data",
  scope:
    "This switch covers this manager's reports. The installer (create-appflare) has its own: --no-telemetry, APPFLARE_TELEMETRY=off or DO_NOT_TRACK=1.",
  whatIsSent: "What is sent",
  lockedBy: (variable: TelemetryLock) =>
    `Turned off by the ${variable} variable on this Worker. Remove the variable to change this here.`,
  devBuild:
    "This is a development build of Appflare, which never sends usage data, whatever this switch says.",
  membersOnly: "Only admins can change it.",
  preview: "Preview",
  previewDescription:
    "The next daily report, built now the same way the scheduled report builds it. Job events and the daily opened event are sent alongside it.",
} as const;
