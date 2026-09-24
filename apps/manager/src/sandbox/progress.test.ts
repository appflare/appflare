import { describe, expect, it } from "vitest";
import { buildArtifactFixture } from "../test/artifact-fixture";
import { fakeSandbox } from "../test/fake-sandbox";
import { readBuildProgress, sandboxBuildOfInput } from "./progress";

describe("sandboxBuildOfInput", () => {
  it("finds the build a job's recorded input names", () => {
    expect(sandboxBuildOfInput(JSON.stringify({ sandboxBuild: true, version: "1.2.0" }))).toEqual({
      version: "1.2.0",
      kind: "build",
    });
    // A self-deploying run is logged under its run id.
    expect(
      sandboxBuildOfInput(JSON.stringify({ sandboxRun: "deploy-0.1.9", version: "0.1.9" })),
    ).toEqual({ version: "deploy-0.1.9", kind: "installer" });
    expect(sandboxBuildOfInput(JSON.stringify({ version: "1.2.0" }))).toBeNull();
    expect(sandboxBuildOfInput("not json")).toBeNull();
    expect(sandboxBuildOfInput(null)).toBeNull();
  });
});

describe("readBuildProgress", () => {
  const log = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
  const at = "2026-09-23T12:00:00.000Z";

  it("shows the last lines of a running build", async () => {
    const binding = fakeSandbox(await buildArtifactFixture(), {
      progress: { state: "running", stage: "build", startedAt: at, updatedAt: at, log: `${log}\n` },
    });
    const view = await readBuildProgress(binding, { installId: "i1", version: "1.0.0" });
    expect(view?.stage).toBe("build");
    expect(view?.lines).toHaveLength(30);
    expect(view?.lines.at(-1)).toBe("line 40");
    expect(binding.progressCalls).toEqual([{ installId: "i1", version: "1.0.0" }]);
  });

  it("shows nothing for a finished build, an unusable answer, or no binding", async () => {
    const finished = fakeSandbox(await buildArtifactFixture(), {
      progress: { state: "succeeded", stage: "verify", startedAt: at, updatedAt: at, log },
    });
    expect(await readBuildProgress(finished, { installId: "i1", version: "1" })).toBeNull();
    expect(await readBuildProgress(undefined, { installId: "i1", version: "1" })).toBeNull();
  });
});
