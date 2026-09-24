import { describe, expect, it } from "vitest";
import { FEEDBACK_TITLE_PREFIX, feedbackIssueUrl, REPOSITORY_URL } from "./project-links";

describe("feedbackIssueUrl", () => {
  it("opens a new issue on the repository with the title prefix and the version", () => {
    const url = new URL(feedbackIssueUrl("0.4.0"));
    expect(`${url.origin}${url.pathname}`).toBe(`${REPOSITORY_URL}/issues/new`);
    expect(url.searchParams.get("title")).toBe(FEEDBACK_TITLE_PREFIX);
    const body = url.searchParams.get("body") ?? "";
    expect(body).toContain("**What would you like to tell us?**");
    expect(body.trimEnd().endsWith("Appflare 0.4.0")).toBe(true);
  });

  it("carries nothing but the template and the version", () => {
    const url = new URL(feedbackIssueUrl("0.4.0"));
    expect([...url.searchParams.keys()].sort()).toEqual(["body", "title"]);
  });
});
