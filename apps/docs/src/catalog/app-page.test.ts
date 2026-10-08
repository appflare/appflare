import { describe, expect, it } from "vitest";
import {
  appPageDescription,
  appPageTitle,
  DESCRIPTION_LIMIT,
  DESCRIPTION_SENTENCE,
  TITLE_LIMIT,
} from "./app-page.ts";

describe("appPageTitle", () => {
  it("names the search it answers, with the site's name when it fits", () => {
    const title = appPageTitle({ name: "Cut", pitch: "Short links" }, "Appflare");
    expect(title).toBe("Deploy Cut on Cloudflare: Short links | Appflare");
    expect(title.length).toBeLessThanOrEqual(TITLE_LIMIT);
  });

  it("leaves the site's name off a title that would be too long", () => {
    const app = { name: "OpenSEO", pitch: "Find keywords, track rankings" };
    // Exactly 70 characters with the site's name: it still fits.
    expect(appPageTitle(app, "Appflare")).toBe(
      "Deploy OpenSEO on Cloudflare: Find keywords, track rankings | Appflare",
    );
    const longer = { ...app, pitch: "Find keywords, track rankings, audit" };
    expect(appPageTitle(longer, "Appflare")).toBe(
      "Deploy OpenSEO on Cloudflare: Find keywords, track rankings, audit",
    );
  });
});

describe("appPageDescription", () => {
  it("is the summary, then that it deploys to your own account with Appflare", () => {
    expect(appPageDescription({ summary: "Short links on Workers\nand KV." })).toBe(
      `Short links on Workers and KV. ${DESCRIPTION_SENTENCE}`,
    );
  });

  it("cuts a long summary at a word, keeping the sentence about Appflare", () => {
    const summary =
      "A self-hosted image host: upload, tag, and browse images, with WebP and AVIF copies, expiry, and a public random-image API, on R2, D1, KV, Queues, and Cloudflare Images.";
    const description = appPageDescription({ summary });
    expect(description.length).toBeLessThanOrEqual(DESCRIPTION_LIMIT);
    expect(description.endsWith(`… ${DESCRIPTION_SENTENCE}`)).toBe(true);
    const kept = description.slice(0, description.indexOf("…"));
    expect(summary.startsWith(kept)).toBe(true);
    // Cut at a word, with no comma or space left before the ellipsis.
    expect(kept).toMatch(/[A-Za-z0-9]$/);
    expect(summary.charAt(kept.length)).toMatch(/[\s,]/);
  });

  it("keeps a summary it cannot cut at a word whole", () => {
    const summary = "x".repeat(200);
    expect(appPageDescription({ summary })).toBe(`${summary} ${DESCRIPTION_SENTENCE}`);
  });
});
