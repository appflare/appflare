import { describe, expect, it } from "vitest";
import { errorPage, escapeHtml, removalPageEnd, removalStepLine, rotationPage } from "./pages";

describe("danger-zone pages", () => {
  it("escapes every value", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    );
    const line = removalStepLine({ label: "<b>", status: "failed", detail: "<script>" });
    expect(line).not.toContain("<script>");
    expect(line).toContain('class="status failed"');
    expect(errorPage("<t>", "<m>")).not.toMatch(/<t>|<m>/);
  });

  it("tells the owner which notification channels need their credentials again", () => {
    expect(rotationPage({ rotatedAt: "2026-09-24T15:00:00.000Z", channels: 0 })).toContain(
      "no credentials to enter again",
    );
    expect(rotationPage({ rotatedAt: "2026-09-24T15:00:00.000Z", channels: 2 })).toContain(
      "your 2 notification channels",
    );
  });

  it("ends a failed removal with the way to finish, and a complete one with what stays", () => {
    const base = {
      accountId: "acc",
      workerName: "appflare",
      sandboxDeleted: false,
      accessOn: true,
      accessLeft: [],
    };
    const failed = removalPageEnd({ ...base, outcome: "failed" });
    expect(failed).toContain("run <strong>Remove Appflare from this account</strong> again");
    expect(failed).toContain("Cloudflare Access protection is still on");
    const complete = removalPageEnd({ ...base, outcome: "complete", sandboxDeleted: true });
    expect(complete).toContain("deletes itself");
    expect(complete).toContain("container applications");
    expect(complete).toContain("keep running, unmanaged");
    expect(complete).toContain("Revoke the Appflare API token");
    expect(complete).toContain("Access applications that protected the manager are deleted");
    // Nothing is published to npm yet: the page points at the install guide instead.
    expect(complete).not.toContain("npx");
    expect(complete).toContain("/start/install/");
  });

  it("names the Access applications a complete removal could not delete", () => {
    const page = removalPageEnd({
      outcome: "complete",
      accountId: "acc",
      workerName: "appflare",
      sandboxDeleted: false,
      accessOn: true,
      accessLeft: ["app-1"],
    });
    expect(page).toContain("<code>app-1</code>");
    expect(page).toContain("Zero Trust, Access, Applications");
  });

  it("says when Access protection was off", () => {
    const page = removalPageEnd({
      outcome: "failed",
      accountId: "acc",
      workerName: "appflare",
      sandboxDeleted: false,
      accessOn: false,
      accessLeft: [],
    });
    expect(page).toContain("Cloudflare Access protection was off");
  });
});
