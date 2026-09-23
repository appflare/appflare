import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKER_NAME,
  discoverWorkerName,
  isVersionPreviewHost,
  workerNameCandidates,
  workerNameFromHost,
  workersDevSubdomainFromHost,
} from "./worker-name";

const scripts = (...ids: string[]) => ids.map((id) => ({ id }));

describe("workerNameFromHost", () => {
  it("takes the first label of a workers.dev host", () => {
    expect(workerNameFromHost("appflare.appflare-dev.workers.dev")).toBe("appflare");
    expect(workerNameFromHost("My-Manager.team.workers.dev:443")).toBe("my-manager");
  });

  it("ignores custom domains, localhost, and the bare subdomain host", () => {
    expect(workerNameFromHost("apps.example.com")).toBeNull();
    expect(workerNameFromHost("localhost:5173")).toBeNull();
    expect(workerNameFromHost("appflare-dev.workers.dev")).toBeNull();
    expect(workerNameFromHost("workers.dev.example.com")).toBeNull();
  });

  it("lists every dash split of the first label, longest first", () => {
    expect(workerNameCandidates("1a2b3c4d-mgr.x.workers.dev")).toEqual(["1a2b3c4d-mgr", "mgr"]);
    expect(workerNameCandidates("a-b-c.x.workers.dev")).toEqual(["a-b-c", "b-c", "c"]);
    expect(workerNameCandidates("apps.example.com")).toEqual([]);
  });

  it("finds the account subdomain", () => {
    expect(workersDevSubdomainFromHost("appflare.appflare-dev.workers.dev")).toBe("appflare-dev");
    expect(workersDevSubdomainFromHost("apps.example.com")).toBeNull();
  });
});

describe("discoverWorkerName", () => {
  it("prefers the workers.dev host label when that script exists", () => {
    expect(
      discoverWorkerName("mgr.appflare-dev.workers.dev", scripts("cut", "mgr", "appflare")),
    ).toEqual({ ok: true, workerName: "mgr", source: "host" });
  });

  it("falls back to `appflare` on a custom host", () => {
    expect(discoverWorkerName("apps.example.com", scripts("cut", "appflare"))).toEqual({
      ok: true,
      workerName: DEFAULT_WORKER_NAME,
      source: "default",
    });
  });

  it("strips a version preview prefix", () => {
    expect(discoverWorkerName("1a2b3c4d-mgr.x.workers.dev", scripts("cut", "mgr"))).toEqual({
      ok: true,
      workerName: "mgr",
      source: "host",
    });
  });

  it("strips an alias preview prefix, keeping dashes in the script name", () => {
    expect(discoverWorkerName("staging-my-mgr.x.workers.dev", scripts("my-mgr", "mgr"))).toEqual({
      ok: true,
      workerName: "my-mgr",
      source: "host",
    });
  });

  it("prefers the whole label when it is itself a script", () => {
    expect(discoverWorkerName("my-mgr.x.workers.dev", scripts("my-mgr", "mgr"))).toEqual({
      ok: true,
      workerName: "my-mgr",
      source: "host",
    });
  });

  it("fails with both names when neither exists", () => {
    const result = discoverWorkerName("mgr.appflare-dev.workers.dev", scripts("cut"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('"mgr" or "appflare"');
  });

  it("fails on a custom host without an `appflare` script", () => {
    const result = discoverWorkerName("apps.example.com", scripts());
    expect(result.ok).toBe(false);
  });
});

describe("isVersionPreviewHost", () => {
  it("recognizes the Worker's version preview hosts and nothing else", () => {
    expect(isVersionPreviewHost("0a1b2c3d-appflare.team.workers.dev", "appflare")).toBe(true);
    expect(isVersionPreviewHost("0a1b2c3d-appflare.team.workers.dev", null)).toBe(true);
    expect(isVersionPreviewHost("appflare.team.workers.dev", "appflare")).toBe(false);
    expect(isVersionPreviewHost("0a1b2c3d-other.team.workers.dev", "appflare")).toBe(false);
    expect(isVersionPreviewHost("deadbeef-app.team.workers.dev", "deadbeef-app")).toBe(false);
    expect(isVersionPreviewHost("0a1b2c3d-appflare.example.com", "appflare")).toBe(false);
  });
});
