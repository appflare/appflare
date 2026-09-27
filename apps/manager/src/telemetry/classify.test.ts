import { describe, expect, it } from "vitest";
import { classifyJobError, failedPhase } from "./classify";

/** Error texts as the jobs write them (`<step>: <message>`). */
describe("classifyJobError", () => {
  it("reads a Cloudflare API failure's status and code, never its text", () => {
    expect(
      classifyJobError(
        "create kv SESSIONS: Cloudflare API request failed: POST /accounts/abc/storage/kv/namespaces -> 403: [10000] Authentication error",
      ),
    ).toEqual({
      errorCategory: "cloudflare_permission",
      failedPhase: "resources",
      cfStatus: 403,
      cfCode: 10000,
    });
    expect(
      classifyJobError(
        "upload Worker version: Cloudflare API request failed: PUT /accounts/abc/workers/scripts/cut -> 400: [10021] Uncaught Error",
      ),
    ).toMatchObject({ errorCategory: "cloudflare_rejected", failedPhase: "upload", cfCode: 10021 });
    expect(
      classifyJobError("promote version: Cloudflare API request failed: POST /x -> 503"),
    ).toEqual({
      errorCategory: "cloudflare_unavailable",
      failedPhase: "promote",
      cfStatus: 503,
      cfCode: null,
    });
    expect(
      classifyJobError("set cron triggers: Cloudflare API request failed: PUT /x -> 429"),
    ).toMatchObject({ errorCategory: "cloudflare_rate_limited", failedPhase: "crons" });
  });

  it("recognises plan limits, the subrequest limit and name conflicts", () => {
    expect(
      classifyJobError(
        "set cron triggers: Cloudflare refused 1 cron trigger: this account has reached the Workers Free limit of 5 cron triggers per account.",
      ),
    ).toMatchObject({ errorCategory: "plan_limit", failedPhase: "crons" });
    expect(
      classifyJobError(
        "upload Worker version: Cloudflare API request failed: PUT /x -> 400: [10027] Your Worker exceeded the size limit",
      ),
    ).toMatchObject({ errorCategory: "plan_limit", cfCode: 10027 });
    expect(
      classifyJobError(
        "upload assets: Too many subrequests by single Worker invocation. Cloudflare allows 50 subrequests per Worker invocation on the free plan",
      ),
    ).toMatchObject({ errorCategory: "subrequest_limit", failedPhase: "assets" });
    expect(
      classifyJobError(
        "check Worker name: a Worker named cut already exists in this account; Appflare does not adopt existing Workers",
      ),
    ).toMatchObject({ errorCategory: "name_conflict", failedPhase: "preflight" });
  });

  it("recognises artifact integrity and fetch failures", () => {
    expect(
      classifyJobError(
        "verify artifact manifest: manifest.json digest abc123 does not match the catalog index (def456)",
      ),
    ).toMatchObject({ errorCategory: "artifact_integrity", failedPhase: "preflight" });
    expect(
      classifyJobError(
        "upload Worker version: worker/index.js: sha256 0a1b does not match the manifest",
      ),
    ).toMatchObject({ errorCategory: "artifact_integrity" });
    expect(
      classifyJobError("load artifact manifest: GET github.com/appflare/catalog/x.json -> 404"),
    ).toMatchObject({ errorCategory: "artifact_fetch", failedPhase: "preflight" });
  });

  it("falls back to the phase for job-specific failures", () => {
    for (const step of [
      "D1 DB: apply migrations",
      "D1 DB: apply schema",
      "D1 DB: apply schema from src/db/indexes.sql",
      "D1 DB: apply post-deploy migrations",
    ]) {
      expect(classifyJobError(`${step}: near "FROM": syntax error`)).toMatchObject({
        errorCategory: "d1_migration",
        failedPhase: "d1_migrations",
      });
    }
    expect(classifyJobError("canary check 5: the preview never served")).toMatchObject({
      errorCategory: "canary",
      failedPhase: "canary",
    });
    expect(
      classifyJobError("build in sandbox: the build failed in its install step (exit code 1): x"),
    ).toMatchObject({ errorCategory: "sandbox_build", failedPhase: "sandbox" });
    expect(classifyJobError("deploy in sandbox: alchemy exited with 1")).toMatchObject({
      errorCategory: "installer",
      failedPhase: "installer",
    });
    expect(classifyJobError("preflight checks: the app needs a zone")).toMatchObject({
      errorCategory: "preflight",
      failedPhase: "preflight",
    });
  });

  it("recognises cancellations and timeouts, and knows when it does not know", () => {
    expect(classifyJobError("the job's Workflow instance was terminated")).toMatchObject({
      errorCategory: "cancelled",
      failedPhase: "other",
    });
    expect(classifyJobError("health check 3: timed out")).toMatchObject({
      errorCategory: "timeout",
      failedPhase: "health",
    });
    expect(classifyJobError("the job's Workflow instance no longer exists")).toEqual({
      errorCategory: "unknown",
      failedPhase: "other",
      cfStatus: null,
      cfCode: null,
    });
    expect(classifyJobError(null).errorCategory).toBe("unknown");
  });
});

describe("failedPhase", () => {
  it("maps step names (which carry resource names) to a fixed set of phases", () => {
    expect(failedPhase("create r2 my-private-bucket")).toBe("resources");
    expect(failedPhase("set secret STRIPE_KEY")).toBe("secrets");
    expect(failedPhase("remove custom domain app.example.com")).toBe("domains");
    expect(failedPhase("route hello@example.com to the Worker")).toBe("email_routing");
    expect(failedPhase("bookmark D1 notes")).toBe("snapshot");
    expect(failedPhase("empty r2 media page 2")).toBe("delete");
    expect(failedPhase("delete kv cache")).toBe("delete");
    expect(failedPhase("record Worker name")).toBe("record");
    expect(failedPhase("finish")).toBe("record");
    expect(failedPhase("something new")).toBe("other");
  });
});
