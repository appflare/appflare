import { describe, expect, it } from "vitest";
import {
  classifyHealthProbe,
  classifyLiveProbe,
  decideLiveHealth,
  type HealthProbe,
  healthPathOfManifest,
  isEdge1042,
  LIVE_HEALTH_WINDOW_MS,
  liveHealthDelaySeconds,
  settleHealthProbe,
  versionMismatch,
} from "./health";

const res = (status: number, bodyStart = ""): HealthProbe => ({
  kind: "response",
  status,
  bodyStart,
});

describe("classifyHealthProbe", () => {
  it("retries the edge's 1042 page until the last attempt", () => {
    const edge = res(404, "error code: 1042\n");
    expect(isEdge1042(edge)).toBe(true);
    expect(classifyHealthProbe(edge, 1, 0).verdict).toBe("retry");
    expect(classifyHealthProbe(edge, 9, 16_000).verdict).toBe("retry");
    const last = classifyHealthProbe(edge, 10, 18_000);
    expect(last.verdict).toBe("unhealthy");
  });

  it("accepts an app's own 404 (not the 1042 page) as serving", () => {
    expect(classifyHealthProbe(res(404, "Not found"), 1, 0)).toEqual({
      verdict: "healthy",
      status: 404,
    });
  });

  it("retries DNS/connection errors", () => {
    const probe: HealthProbe = { kind: "error", message: "getaddrinfo ENOTFOUND" };
    expect(classifyHealthProbe(probe, 3, 4000).verdict).toBe("retry");
    expect(classifyHealthProbe(probe, 10, 18_000).verdict).toBe("unhealthy");
  });

  it("retries 5xx only during the first 20 seconds", () => {
    expect(classifyHealthProbe(res(503), 2, 2000).verdict).toBe("retry");
    expect(classifyHealthProbe(res(500), 6, 20_000).verdict).toBe("unhealthy");
  });

  it("accepts any other non-5xx answer", () => {
    expect(classifyHealthProbe(res(200), 1, 0).verdict).toBe("healthy");
    expect(classifyHealthProbe(res(302), 1, 0).verdict).toBe("healthy");
    expect(classifyHealthProbe(res(401), 1, 0).verdict).toBe("healthy");
  });
});

describe("versionMismatch", () => {
  const probe = (body: string) => ({
    kind: "response" as const,
    status: 200,
    bodyStart: body,
    body,
  });
  it("requires a JSON version to match and ignores anything else", () => {
    expect(versionMismatch(probe('{"version":"1.1.0"}'), "1.1.0")).toBeNull();
    expect(versionMismatch(probe('{"version":"1.0.0"}'), "1.1.0")).toBe(
      "the app reports version 1.0.0, not 1.1.0",
    );
    expect(versionMismatch(probe('{"ok":true}'), "1.1.0")).toBeNull();
    expect(versionMismatch(probe('{"version":2}'), "1.1.0")).toBeNull();
    expect(versionMismatch(probe("<html>ok</html>"), "1.1.0")).toBeNull();
    expect(versionMismatch({ kind: "error", message: "x" }, "1.1.0")).toBeNull();
  });
});

describe("live health window", () => {
  const edge = res(404, "error code: 1042");
  const down: HealthProbe = { kind: "error", message: "getaddrinfo ENOTFOUND" };

  it("classifies 1042, no connection, and 5xx as retry, a plain 404 as soft", () => {
    expect(classifyLiveProbe(edge)).toBe("retry");
    expect(classifyLiveProbe(down)).toBe("retry");
    expect(classifyLiveProbe(res(503))).toBe("retry");
    expect(classifyLiveProbe(res(404, "Not found"))).toBe("soft-404");
    expect(classifyLiveProbe(res(200))).toBe("pass");
    expect(classifyLiveProbe(res(401))).toBe("pass");
    expect(classifyLiveProbe(res(302))).toBe("pass");
  });

  it("backs off 2, 3, 5, 8, then 10 seconds", () => {
    expect([1, 2, 3, 4, 5, 6, 12].map(liveHealthDelaySeconds)).toEqual([2, 3, 5, 8, 10, 10, 10]);
  });

  it("settles on the first passing answer", () => {
    expect(decideLiveHealth(res(401), 1, 0)).toEqual({
      done: true,
      status: "verified",
      detail: "HTTP 401",
    });
  });

  /** Drives the window with a fake clock: each probe takes `probeMs`; sleeps take their delay. */
  function drive(answer: HealthProbe, probeMs: number) {
    let clock = 0;
    for (let attempt = 1; ; attempt++) {
      const decision = decideLiveHealth(answer, attempt, clock);
      clock += probeMs;
      if (decision.done) return { attempts: attempt, decision };
      clock += decision.delaySeconds * 1000;
    }
  }

  it("keeps retrying for 90 seconds, then records what the last answer means", () => {
    expect(drive(edge, 0)).toEqual({
      attempts: 12,
      decision: {
        done: true,
        status: "unverified",
        detail: "404 error code: 1042 (route not live yet)",
      },
    });
    expect(drive(down, 0).decision).toMatchObject({ status: "unverified" });
    expect(drive(res(500), 0).decision).toMatchObject({ status: "unhealthy", detail: "HTTP 500" });
    // An app may serve 404 at its root: it passes once the window ends.
    expect(drive(res(404, "Not found"), 0)).toMatchObject({
      attempts: 12,
      decision: { status: "verified" },
    });
  });

  it("ends by the clock when probes are slow", () => {
    // Probes at 0, 12, 25, 40, 58, 78, 98 s (each takes 10 s).
    expect(drive(edge, 10_000).attempts).toBe(7);
    expect(decideLiveHealth(edge, 2, LIVE_HEALTH_WINDOW_MS - 2_000)).toMatchObject({ done: true });
    expect(decideLiveHealth(edge, 2, LIVE_HEALTH_WINDOW_MS - 3_000)).toMatchObject({
      done: false,
      delaySeconds: 3,
    });
  });

  it("settles a single probe the same way", () => {
    expect(settleHealthProbe(res(200)).status).toBe("verified");
    expect(settleHealthProbe(res(404, "Not found")).status).toBe("verified");
    expect(settleHealthProbe(edge).status).toBe("unverified");
    expect(settleHealthProbe(down).status).toBe("unverified");
    expect(settleHealthProbe(res(503)).status).toBe("unhealthy");
  });
});

describe("healthPathOfManifest", () => {
  it("falls back to / when the manifest is missing or not an artifact manifest", () => {
    expect(healthPathOfManifest(null)).toBe("/");
    expect(healthPathOfManifest("not json")).toBe("/");
    expect(healthPathOfManifest('{"version":"1.0.0"}')).toBe("/");
  });
});
