import { describe, expect, it } from "vitest";
import { fetchCost, isSubrequestLimitError, subrequestLimitMessage } from "./budget";

describe("subrequest accounting", () => {
  it("recognizes the runtime's subrequest-limit error, also when wrapped", () => {
    const limit = new Error("Too many subrequests by single Worker invocation.");
    expect(isSubrequestLimitError(limit)).toBe(true);
    expect(isSubrequestLimitError(new Error("GET x failed", { cause: limit }))).toBe(true);
    expect(isSubrequestLimitError(new Error("GET x -> 503"))).toBe(false);
    expect(isSubrequestLimitError(null)).toBe(false);
  });

  it("explains why a subrequest-limit failure is not retried", () => {
    expect(
      subrequestLimitMessage(
        "GET a.js failed: Too many subrequests by single Worker invocation. To configure this limit, refer to https://developers.cloudflare.com/workers/wrangler/configuration/#limits",
      ),
    ).toBe(
      "GET a.js failed: Too many subrequests by single Worker invocation. Cloudflare allows 50 subrequests per Worker invocation on the free plan, and a retry would make the same requests and hit the same limit, so the job stopped instead of retrying.",
    );
  });

  it("counts a redirected fetch as two subrequests", () => {
    expect(fetchCost({ redirected: false })).toBe(1);
    expect(fetchCost({ redirected: true })).toBe(2);
  });
});
