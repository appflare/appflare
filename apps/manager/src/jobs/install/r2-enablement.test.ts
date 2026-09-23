import { CloudflareApiError } from "@appflare/cf-api";
import { describe, expect, it } from "vitest";
import { JobError } from "../steps";
import { explainR2Refusal, isR2NotEnabled, r2NotEnabledMessage } from "./r2-enablement";

function apiError(status: number, errors: Array<{ code: number; message: string }>) {
  return new CloudflareApiError({ status, method: "POST", path: "/accounts/a/r2/buckets", errors });
}

describe("isR2NotEnabled", () => {
  it("recognises Cloudflare's refusal on an account without R2", () => {
    expect(
      isR2NotEnabled(
        apiError(403, [
          { code: 10042, message: "Please enable R2 through the Cloudflare Dashboard." },
        ]),
      ),
    ).toBe(true);
  });

  it("matches the code or the message alone, and a nested error chain", () => {
    expect(isR2NotEnabled(apiError(403, [{ code: 10042, message: "Forbidden" }]))).toBe(true);
    expect(
      isR2NotEnabled(
        apiError(400, [{ code: 1, message: "Please enable R2 through the dashboard" }]),
      ),
    ).toBe(true);
    const chained = new CloudflareApiError({
      status: 403,
      method: "GET",
      path: "/accounts/a/r2/buckets",
      errors: [
        {
          code: 10000,
          message: "Forbidden",
          error_chain: [
            { code: 10042, message: "Please enable R2 through the Cloudflare Dashboard." },
          ],
        },
      ],
    });
    expect(isR2NotEnabled(chained)).toBe(true);
  });

  it("leaves other failures alone", () => {
    expect(isR2NotEnabled(apiError(403, [{ code: 10000, message: "Authentication error" }]))).toBe(
      false,
    );
    expect(
      isR2NotEnabled(apiError(409, [{ code: 10004, message: "The bucket already exists" }])),
    ).toBe(false);
    // A server error with that code is retried, not reported as a missing add-on.
    expect(isR2NotEnabled(apiError(503, [{ code: 10042, message: "enable R2" }]))).toBe(false);
    expect(isR2NotEnabled(new Error("Please enable R2 through the Cloudflare Dashboard."))).toBe(
      false,
    );
  });
});

describe("r2NotEnabledMessage", () => {
  it("names the bucket and says what to do", () => {
    const message = r2NotEnabledMessage("r2-explorer-bucket");
    expect(message).toContain("R2 is not enabled on this Cloudflare account");
    expect(message).toContain("r2-explorer-bucket");
    expect(message).toContain("payment method");
    expect(message).toContain("try again");
  });
});

describe("explainR2Refusal", () => {
  it("replaces the refusal with the explanation, as a failure that is not retried", async () => {
    const refused = explainR2Refusal("r2-explorer-bucket", async () => {
      throw apiError(403, [
        { code: 10042, message: "Please enable R2 through the Cloudflare Dashboard." },
      ]);
    });
    await expect(refused).rejects.toBeInstanceOf(JobError);
    await expect(refused).rejects.toThrow(r2NotEnabledMessage("r2-explorer-bucket"));
  });

  it("passes results and other errors through", async () => {
    expect(await explainR2Refusal("b", async () => "ok")).toBe("ok");
    const other = apiError(500, [{ code: 10001, message: "Internal error" }]);
    await expect(
      explainR2Refusal("b", async () => {
        throw other;
      }),
    ).rejects.toBe(other);
  });
});
