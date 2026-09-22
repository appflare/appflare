import { describe, expect, it } from "vitest";
import { parseDeployOutput } from "./deploy-output.ts";

describe("parseDeployOutput", () => {
  const lines = (...entries: unknown[]) => entries.map((e) => JSON.stringify(e)).join("\n");
  it("finds the workers.dev URL and version of the named Worker", () => {
    const out = lines(
      { type: "wrangler-session", version: 1 },
      {
        type: "deploy",
        version: 1,
        worker_name: "appflare",
        version_id: "v-1",
        targets: [
          "https://appflare.acme.workers.dev",
          "schedule: */30 * * * *",
          "workflow: appflare-jobs",
        ],
      },
    );
    expect(parseDeployOutput(out, "appflare")).toEqual({
      url: "https://appflare.acme.workers.dev",
      versionId: "v-1",
    });
  });
  it("does not take another Worker's URL", () => {
    const out = lines({ type: "deploy", targets: ["https://other.acme.workers.dev"] });
    expect(() => parseDeployOutput(out, "appflare")).toThrow("reported no workers.dev URL");
  });
  it("fails when there was no deploy", () => {
    expect(() => parseDeployOutput("", "appflare")).toThrow("did not report a deploy");
  });
});
