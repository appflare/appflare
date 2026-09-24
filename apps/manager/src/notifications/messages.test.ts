import { describe, expect, it } from "vitest";
import {
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
      "Cut 1.1.0 is available. Links for Ada (Worker my-links) runs 1.0.0.",
      `${M}/apps/i1`,
    ],
    [
      { type: "update_applied", app, from: "1.0.0", to: "1.1.0", jobId: "j1" },
      "Updated Links for Ada",
      "Links for Ada (Worker my-links) now runs Cut 1.1.0, updated from 1.0.0.",
      `${M}/jobs/j1`,
    ],
    [
      { type: "update_failed", app, from: "1.0.0", to: "1.1.0", jobId: "j1" },
      "Update failed: Links for Ada",
      "Updating Links for Ada (Worker my-links) from 1.0.0 to 1.1.0 failed. The job log says where.",
      `${M}/jobs/j1`,
    ],
    [
      { type: "install_finished", app, version: "1.0.0", outcome: "succeeded", jobId: "j0" },
      "Installed Links for Ada",
      "Cut 1.0.0 is installed as Links for Ada (Worker my-links).",
      `${M}/jobs/j0`,
    ],
    [
      { type: "install_finished", app, version: "1.0.0", outcome: "failed", jobId: "j0" },
      "Install failed: Links for Ada",
      "Installing Cut 1.0.0 as Links for Ada (Worker my-links) failed. The job log says where.",
      `${M}/jobs/j0`,
    ],
    [
      { type: "uninstall_finished", app, outcome: "succeeded", jobId: "j2" },
      "Uninstalled Links for Ada",
      "Links for Ada (Worker my-links) was uninstalled.",
      `${M}/jobs/j2`,
    ],
    [
      { type: "health_failing", app },
      "Health check failing: Links for Ada",
      "Links for Ada (Worker my-links) answers its health check with a server error.",
      `${M}/apps/i1`,
    ],
    [
      { type: "manager_update_available", from: "0.5.0", to: "0.6.0" },
      "Appflare update available",
      "Appflare 0.6.0 is available. This manager runs 0.5.0.",
      `${M}/settings/appflare-updates`,
    ],
  ];

  it.each(cases)("renders %j", (facts, title, line, url) => {
    expect(notificationFactsSchema.parse(facts)).toEqual(facts);
    expect(renderMessage(facts, `${M}/`)).toEqual({ title, lines: [line], url });
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
      `Health check failing: <b>&_*bold*_\n<b>&_*bold*_ (Worker my-links) answers its health check with a server error.\n${M}/apps/i1`,
    );
  });

  it("Slack escapes &, < and > and links with a label", () => {
    const text = slackText(message);
    expect(text).toContain("*Health check failing: &lt;b&gt;&amp;_*bold*_*");
    expect(text).toContain(`<${M}/apps/i1|Open in Appflare>`);
  });

  it("Discord escapes markdown and suppresses the link preview", () => {
    const text = discordText(message);
    expect(text).toContain("**Health check failing: <b\\>&\\_\\*bold\\*\\_**");
    expect(text.endsWith(`<${M}/apps/i1>`)).toBe(true);
  });
});
