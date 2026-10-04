import { describe, expect, it } from "vitest";
import { docsUrl } from "../docs-topics";
import {
  ACCESS_LOCKED_OUT_URL,
  discordText,
  type NotificationFacts,
  notificationFactsSchema,
  plainText,
  renderMessage,
  slackText,
} from "./messages";

const app = { installId: "i1", app: "Cut", instance: "Links for Ada", workerName: "my-links" };
const M = "https://appflare.ada.workers.dev";

describe("renderMessage", () => {
  const cases: Array<[NotificationFacts, string, string, string]> = [
    [
      { type: "update_available", app, from: "1.0.0", to: "1.1.0" },
      "Update available: Links for Ada",
      "Cut 1.1.0 is available. Links for Ada runs 1.0.0.",
      `${M}/apps/i1`,
    ],
    [
      { type: "update_applied", app, from: "1.0.0", to: "1.1.0", jobId: "j1" },
      "Updated Links for Ada",
      "Links for Ada now runs Cut 1.1.0, updated from 1.0.0.",
      `${M}/jobs/j1`,
    ],
    [
      { type: "update_failed", app, from: "1.0.0", to: "1.1.0", jobId: "j1" },
      "Update failed: Links for Ada",
      "Updating Links for Ada from 1.0.0 to 1.1.0 failed. The job log says where.",
      `${M}/jobs/j1`,
    ],
    [
      { type: "install_finished", app, version: "1.0.0", outcome: "succeeded", jobId: "j0" },
      "Installed Links for Ada",
      "Cut 1.0.0 is installed as Links for Ada.",
      `${M}/jobs/j0`,
    ],
    [
      { type: "install_finished", app, version: "1.0.0", outcome: "failed", jobId: "j0" },
      "Install failed: Links for Ada",
      "Installing Cut 1.0.0 as Links for Ada failed. The job log says where.",
      `${M}/jobs/j0`,
    ],
    [
      { type: "uninstall_finished", app, outcome: "succeeded", jobId: "j2" },
      "Uninstalled Links for Ada",
      "Links for Ada was uninstalled.",
      `${M}/jobs/j2`,
    ],
    [
      { type: "health_failing", app },
      "Health check failing: Links for Ada",
      "Links for Ada answers its health check with a server error.",
      `${M}/apps/i1#health`,
    ],
    [
      { type: "manager_update_available", from: "0.5.0", to: "0.6.0" },
      "Appflare update available",
      "Appflare 0.6.0 is available. This manager runs 0.5.0.",
      `${M}/settings/updates#appflare`,
    ],
    [
      { type: "domain_active", app, hostname: "go.customer.test" },
      "Domain active: go.customer.test",
      "go.customer.test now serves Links for Ada. Cloudflare validated it and issued its certificate.",
      `${M}/apps/i1#external-domains`,
    ],
    [
      {
        type: "domain_failed",
        app,
        hostname: "go.customer.test",
        reason: "Cloudflare reports the hostname as blocked.",
      },
      "Domain failed: go.customer.test",
      "go.customer.test, an external domain of Links for Ada, does not serve the app. Cloudflare reports the hostname as blocked.",
      `${M}/apps/i1#external-domains`,
    ],
    [
      { type: "manager_address_lost", hostname: "appflare.example.com" },
      "Appflare's address stopped working",
      "appflare.example.com no longer serves Appflare, so Appflare is back at its workers.dev address. Sign in there with your password; passkeys added at appflare.example.com do not work there.",
      `${M}/settings/domains#address`,
    ],
    [
      {
        type: "manager_move_finished",
        hostname: "appflare.example.com",
        outcome: "succeeded",
        jobId: "j9",
      },
      "Appflare moved to appflare.example.com",
      "Appflare now lives at appflare.example.com. Sign in again there; passkeys added at the old address work only there.",
      "https://appflare.example.com/",
    ],
    [
      {
        type: "manager_move_finished",
        hostname: "appflare.example.com",
        outcome: "failed",
        jobId: "j9",
      },
      "Moving Appflare to appflare.example.com failed",
      "Appflare stays at its current address. The job log says why; start the move again from the Domains settings.",
      `${M}/jobs/j9`,
    ],
    [
      {
        type: "manager_move_finished",
        hostname: "appflare.example.com",
        outcome: "failed",
        jobId: "j9",
        moved: true,
      },
      "Appflare moved to appflare.example.com; its job failed afterwards",
      "Appflare now lives at appflare.example.com. Sign in again there; the job log says what did not finish.",
      "https://appflare.example.com/jobs/j9",
    ],
  ];

  it.each(cases)("renders %j", (facts, title, line, url) => {
    expect(notificationFactsSchema.parse(facts)).toEqual(facts);
    expect(renderMessage(facts, `${M}/`)).toEqual({ title, lines: [line], url });
  });

  it("names the Worker only through a label that tells two installs apart", () => {
    const twin = { ...app, instance: "Cut (my-links)" };
    expect(
      renderMessage(
        { type: "uninstall_finished", app: twin, outcome: "succeeded", jobId: "j2" },
        M,
      ),
    ).toMatchObject({
      title: "Uninstalled Cut (my-links)",
      lines: ["Cut (my-links) was uninstalled."],
    });
  });

  it("points to the Access recovery steps when Access stayed on the lost address", () => {
    const message = renderMessage(
      { type: "manager_address_lost", hostname: "appflare.example.com", accessLeftBehind: true },
      M,
    );
    expect(message.lines[1]).toBe(
      `Cloudflare Access could not be moved back to workers.dev, so Appflare refuses sign-in there until you follow the Access recovery steps: ${ACCESS_LOCKED_OUT_URL}`,
    );
    // The docs topic's page and heading, tagged as a notification's link rather than the app's.
    const untagged = (url: string) => Object.assign(new URL(url), { search: "" }).href;
    expect(untagged(ACCESS_LOCKED_OUT_URL)).toBe(untagged(docsUrl("accessLockedOut")));
    expect(new URL(ACCESS_LOCKED_OUT_URL).searchParams.get("utm_medium")).toBe("notification");
  });

  it("leaves the link out when the manager URL is not known", () => {
    expect(renderMessage({ type: "test" }, null).url).toBeNull();
  });
});

describe("per-service text", () => {
  const message = renderMessage(
    { type: "health_failing", app: { ...app, instance: "<b>&_*bold*_" } },
    M,
  );

  it("Telegram is plain text with the link on its own line", () => {
    expect(plainText(message)).toBe(
      `Health check failing: <b>&_*bold*_\n<b>&_*bold*_ answers its health check with a server error.\n${M}/apps/i1#health`,
    );
  });

  it("Slack escapes &, < and > and links with a label", () => {
    const text = slackText(message);
    expect(text).toContain("*Health check failing: &lt;b&gt;&amp;_*bold*_*");
    expect(text).toContain(`<${M}/apps/i1#health|Open in Appflare>`);
  });

  it("Discord escapes markdown and suppresses the link preview", () => {
    const text = discordText(message);
    expect(text).toContain("**Health check failing: <b\\>&\\_\\*bold\\*\\_**");
    expect(text.endsWith(`<${M}/apps/i1#health>`)).toBe(true);
  });
});
