import { describe, expect, it } from "vitest";
import { type FailedJobView, jobFailureHeadline, jobFailureLine } from "./job-failure-copy";

const install = { label: "Short links" };
const job = (over: Partial<FailedJobView>): FailedJobView => ({
  kind: "install",
  install,
  error: null,
  ...over,
});

describe("a failed job's headline", () => {
  it("says what did not finish in a plain sentence, never the step's name", () => {
    const failed = job({
      error:
        "verify API token: Cloudflare API request failed: GET /user/tokens/verify -> 401: [1000] Invalid API Token",
    });
    expect(jobFailureHeadline(failed)).toBe("Installing Short links did not finish.");
    expect(jobFailureHeadline(failed)).not.toContain("verify");
    expect(jobFailureHeadline(job({ kind: "update" }))).toBe(
      "Updating Short links did not finish.",
    );
    expect(jobFailureHeadline(job({ kind: "rollback", restore: true }))).toBe(
      "Restoring the database of Short links did not finish.",
    );
  });

  it("names Appflare's own jobs", () => {
    const own = (over: Partial<FailedJobView>) => job({ install: null, ...over });
    expect(jobFailureHeadline(own({ kind: "self_update", targetVersion: "0.4.0" }))).toBe(
      "Updating Appflare to 0.4.0 did not finish.",
    );
    expect(jobFailureHeadline(own({ kind: "move_address" }))).toBe(
      "Moving Appflare to its new address did not finish.",
    );
    expect(jobFailureHeadline(own({ kind: "sandbox_enable" }))).toBe(
      "Turning on sandbox builds did not finish.",
    );
    expect(jobFailureHeadline(own({ kind: "something_new" }))).toBe(
      "something_new did not finish.",
    );
  });
});

describe("the line under it", () => {
  it("says plainly when Cloudflare refused Appflare's access or a permission", () => {
    expect(jobFailureLine(job({ error: "verify: GET /user/tokens/verify -> 401: x" }))).toBe(
      "Cloudflare did not accept Appflare's access.",
    );
    expect(jobFailureLine(job({ error: "upload: PUT /x -> 403: y" }))).toBe(
      "Cloudflare refused a permission Appflare needs.",
    );
  });

  it("says what keeps running, and nothing when there is nothing plain to add", () => {
    expect(jobFailureLine(job({ kind: "update", error: "step: boom" }))).toBe(
      "The app keeps running as it was.",
    );
    expect(jobFailureLine(job({ kind: "self_update", install: null, error: null }))).toBe(
      "Appflare keeps running the version it had.",
    );
    expect(jobFailureLine(job({ error: "step: something else" }))).toBeNull();
  });
});
