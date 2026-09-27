import { describe, expect, it } from "vitest";
import { buildArtifactFixture } from "../test/artifact-fixture";
import { otherWorkerViews } from "./other-workers";

describe("the app page's list of other Workers", () => {
  it("lists each other Worker with its URL, or none when it is kept off workers.dev", async () => {
    const { manifest } = await buildArtifactFixture({
      otherWorkers: [{ name: "content" }, { name: "git", workersDev: false }],
    });
    expect(otherWorkerViews(manifest, "team", "acme")).toEqual([
      {
        name: "content",
        workerName: "team-content",
        public: true,
        url: "https://team-content.acme.workers.dev",
      },
      { name: "git", workerName: "team-git", public: false, url: null },
    ]);
  });

  it("has no URL while the account's subdomain is unknown", async () => {
    const { manifest } = await buildArtifactFixture({ otherWorkers: [{ name: "content" }] });
    expect(otherWorkerViews(manifest, "cut", null)).toEqual([
      { name: "content", workerName: "cut-content", public: true, url: null },
    ]);
  });

  it("is empty for an app of one Worker", async () => {
    const { manifest } = await buildArtifactFixture({});
    expect(otherWorkerViews(manifest, "cut", "acme")).toEqual([]);
  });
});
