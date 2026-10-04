import { SITE_URL } from "@appflare/schema/links";
import { z } from "zod";
import { appLink } from "../components/app-links";
import { settingsLink } from "../components/settings-links";
import { managerSiteLink } from "../site-links";
import type { NOTIFICATION_EVENTS } from "./schema";

/**
 * What a notification says. Facts are stored with the event
 * (`notification_events.facts_json`) and rendered per channel kind when it
 * is delivered. They hold only what a message may show: app and instance
 * names, versions, the Worker name, ids that form links into the manager.
 * Never a secret, a token, an account id, or a job's error text (which can
 * name secrets and request paths): a failed job links to its log instead.
 */

const appRef = z.object({
  installId: z.string(),
  /** The catalog app's name ("Cut"). */
  app: z.string(),
  /**
   * What the UI calls the install (`distinctLabels`): its display name, else
   * the app's name, with its Worker name in parentheses when another install
   * reads the same. Events stored by older versions hold the Worker name.
   */
  instance: z.string(),
  workerName: z.string(),
});
export type AppRef = z.infer<typeof appRef>;

const outcome = z.enum(["succeeded", "failed"]);
const version = z.string().nullable();

export const notificationFactsSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("update_available"),
    app: appRef,
    from: z.string(),
    to: z.string(),
    /** The entry changed how the app is installed: the new version takes a reinstall. */
    reinstall: z.literal(true).optional(),
  }),
  z.object({
    type: z.literal("update_applied"),
    app: appRef,
    from: version,
    to: version,
    jobId: z.string(),
  }),
  z.object({
    type: z.literal("update_failed"),
    app: appRef,
    from: version,
    to: version,
    jobId: z.string(),
  }),
  z.object({
    type: z.literal("install_finished"),
    app: appRef,
    version,
    outcome,
    jobId: z.string(),
  }),
  z.object({ type: z.literal("uninstall_finished"), app: appRef, outcome, jobId: z.string() }),
  z.object({ type: z.literal("health_failing"), app: appRef }),
  z.object({ type: z.literal("manager_update_available"), from: z.string(), to: z.string() }),
  z.object({ type: z.literal("domain_active"), app: appRef, hostname: z.string() }),
  z.object({
    type: z.literal("domain_failed"),
    app: appRef,
    hostname: z.string(),
    /** Appflare's own sentence for the state Cloudflare reports (never Cloudflare's error text). */
    reason: z.string(),
  }),
  z.object({
    type: z.literal("manager_address_lost"),
    /** The custom domain Appflare was at. */
    hostname: z.string(),
    /**
     * Cloudflare Access could not be moved back to workers.dev, so it still
     * protects the lost hostname and Appflare refuses sign-in at workers.dev.
     */
    accessLeftBehind: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("manager_move_finished"),
    /** The custom domain Appflare was moving to. */
    hostname: z.string(),
    outcome,
    jobId: z.string(),
    /** A failed job whose switch had committed: Appflare lives at `hostname` anyway. */
    moved: z.boolean().optional(),
  }),
  z.object({ type: z.literal("test") }),
]);
export type NotificationFacts = z.infer<typeof notificationFactsSchema>;
export type FactsType = NotificationFacts["type"];

// Every stored event type has facts of the same name.
type _Covered =
  Exclude<(typeof NOTIFICATION_EVENTS)[number], FactsType> extends never ? true : never;
const _covered: _Covered = true;
void _covered;

export interface Message {
  title: string;
  /** Plain sentences, one per line. */
  lines: string[];
  /** Absolute link into the manager; null when its URL is not known. */
  url: string | null;
}

/** The docs' Access recovery steps ("If you are locked out"). */
export const ACCESS_LOCKED_OUT_URL = managerSiteLink(
  `${SITE_URL}/security/#if-you-are-locked-out`,
  "accessLockedOut",
  "notification",
);

function managerLink(managerUrl: string | null, path: string): string | null {
  return managerUrl === null ? null : `${managerUrl.replace(/\/+$/, "")}${path}`;
}

const v = (value: string | null) => value ?? "an unknown version";

export function renderMessage(facts: NotificationFacts, managerUrl: string | null): Message {
  switch (facts.type) {
    case "update_available":
      return {
        title:
          facts.reinstall === true
            ? `New version takes a reinstall: ${facts.app.instance}`
            : `Update available: ${facts.app.instance}`,
        lines: [
          `${facts.app.app} ${facts.to} is available. ${facts.app.instance} runs ${facts.from}.`,
          ...(facts.reinstall === true
            ? [
                `${facts.app.app} changed how it is installed, so ${facts.app.instance} cannot be updated in place: uninstall it and install it again to get ${facts.to}.`,
              ]
            : []),
        ],
        url: managerLink(managerUrl, appLink(facts.app.installId)),
      };
    case "update_applied":
      return {
        title: `Updated ${facts.app.instance}`,
        lines: [
          `${facts.app.instance} now runs ${facts.app.app} ${v(facts.to)}, updated from ${v(facts.from)}.`,
        ],
        url: managerLink(managerUrl, `/jobs/${facts.jobId}`),
      };
    case "update_failed":
      return {
        title: `Update failed: ${facts.app.instance}`,
        lines: [
          `Updating ${facts.app.instance} from ${v(facts.from)} to ${v(facts.to)} failed. The job log says where.`,
        ],
        url: managerLink(managerUrl, `/jobs/${facts.jobId}`),
      };
    case "install_finished":
      return facts.outcome === "succeeded"
        ? {
            title: `Installed ${facts.app.instance}`,
            lines: [`${facts.app.app} ${v(facts.version)} is installed as ${facts.app.instance}.`],
            url: managerLink(managerUrl, `/jobs/${facts.jobId}`),
          }
        : {
            title: `Install failed: ${facts.app.instance}`,
            lines: [
              `Installing ${facts.app.app} ${v(facts.version)} as ${facts.app.instance} failed. The job log says where.`,
            ],
            url: managerLink(managerUrl, `/jobs/${facts.jobId}`),
          };
    case "uninstall_finished":
      return facts.outcome === "succeeded"
        ? {
            title: `Uninstalled ${facts.app.instance}`,
            lines: [`${facts.app.instance} was uninstalled.`],
            url: managerLink(managerUrl, `/jobs/${facts.jobId}`),
          }
        : {
            title: `Uninstall failed: ${facts.app.instance}`,
            lines: [`Uninstalling ${facts.app.instance} failed. The job log says where.`],
            url: managerLink(managerUrl, `/jobs/${facts.jobId}`),
          };
    case "health_failing":
      return {
        title: `Health check failing: ${facts.app.instance}`,
        lines: [`${facts.app.instance} answers its health check with a server error.`],
        url: managerLink(managerUrl, appLink(facts.app.installId, "health")),
      };
    case "manager_update_available":
      return {
        title: "Appflare update available",
        lines: [`Appflare ${facts.to} is available. This manager runs ${facts.from}.`],
        url: managerLink(managerUrl, settingsLink("updates", "appflare")),
      };
    case "domain_active":
      return {
        title: `Domain active: ${facts.hostname}`,
        lines: [
          `${facts.hostname} now serves ${facts.app.instance}. Cloudflare validated it and issued its certificate.`,
        ],
        url: managerLink(managerUrl, appLink(facts.app.installId, "external-domains")),
      };
    case "domain_failed":
      return {
        title: `Domain failed: ${facts.hostname}`,
        lines: [
          `${facts.hostname}, an external domain of ${facts.app.instance}, does not serve the app. ${facts.reason}`,
        ],
        url: managerLink(managerUrl, appLink(facts.app.installId, "external-domains")),
      };
    case "manager_address_lost":
      return {
        title: "Appflare's address stopped working",
        lines: [
          `${facts.hostname} no longer serves Appflare, so Appflare is back at its workers.dev address. Sign in there with your password; passkeys added at ${facts.hostname} do not work there.`,
          ...(facts.accessLeftBehind === true
            ? [
                `Cloudflare Access could not be moved back to workers.dev, so Appflare refuses sign-in there until you follow the Access recovery steps: ${ACCESS_LOCKED_OUT_URL}`,
              ]
            : []),
        ],
        url: managerLink(managerUrl, settingsLink("domains", "address")),
      };
    case "manager_move_finished":
      if (facts.outcome === "failed" && facts.moved === true) {
        return {
          title: `Appflare moved to ${facts.hostname}; its job failed afterwards`,
          lines: [
            `Appflare now lives at ${facts.hostname}. Sign in again there; the job log says what did not finish.`,
          ],
          url: `https://${facts.hostname}/jobs/${facts.jobId}`,
        };
      }
      return facts.outcome === "succeeded"
        ? {
            title: `Appflare moved to ${facts.hostname}`,
            lines: [
              `Appflare now lives at ${facts.hostname}. Sign in again there; passkeys added at the old address work only there.`,
            ],
            url: `https://${facts.hostname}/`,
          }
        : {
            title: `Moving Appflare to ${facts.hostname} failed`,
            lines: [
              `Appflare stays at its current address. The job log says why; start the move again from the Domains settings.`,
            ],
            url: managerLink(managerUrl, `/jobs/${facts.jobId}`),
          };
    case "test":
      return {
        title: "Test message from Appflare",
        lines: ["This channel works. Appflare sends the events you picked for it here."],
        url: managerLink(managerUrl, settingsLink("notifications", "channels")),
      };
  }
}

/** Plain text: Telegram (no parse mode, so nothing needs escaping). */
export function plainText(message: Message): string {
  return [message.title, ...message.lines, ...(message.url === null ? [] : [message.url])].join(
    "\n",
  );
}

/** Slack mrkdwn: `&`, `<` and `>` are the only characters Slack asks to escape. */
export function slackText(message: Message): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const link = message.url === null ? [] : [`<${esc(message.url)}|Open in Appflare>`];
  return [`*${esc(message.title)}*`, ...message.lines.map(esc), ...link].join("\n");
}

/** Discord markdown, with names escaped; the link in `<>` so Discord adds no preview. */
export function discordText(message: Message): string {
  const esc = (s: string) => s.replace(/([\\*_~`|>#[\]])/g, "\\$1");
  const link = message.url === null ? [] : [`<${message.url}>`];
  return [`**${esc(message.title)}**`, ...message.lines.map(esc), ...link].join("\n");
}
