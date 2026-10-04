import { describe, expect, it } from "vitest";
import { accessChallenge, accessLoginUrl } from "../../test/access-sign-in";
import { buildArtifactFixture } from "../../test/artifact-fixture";
import {
  ACCESS_CHALLENGE_DETAIL,
  classifyHealthProbe,
  classifyLiveProbe,
  decideLiveHealth,
  type HealthProbe,
  healthBehindAccess,
  healthCheckOfManifest,
  healthColumns,
  healthPathOfManifest,
  isAccessChallenge,
  isAccessChallengeFor,
  isEdge1042,
  isEdgeErrorPage,
  LIVE_HEALTH_WINDOW_MS,
  liveHealthDelaySeconds,
  lookupOnce,
  probeHealth,
  probeHealthThroughAccess,
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

  it("passes a plain 404 at once when the route was live before the job, never Cloudflare's pages", () => {
    expect(classifyLiveProbe(res(404, "Not found"), "no-server-errors", true)).toBe("pass");
    expect(classifyLiveProbe(res(404, "Not found"), "any-response", true)).toBe("pass");
    expect(classifyLiveProbe(edge, "no-server-errors", true)).toBe("retry");
    expect(classifyLiveProbe(res(404, "error code: 1101"), "no-server-errors", true)).toBe(
      "soft-404",
    );
    expect(
      decideLiveHealth(res(404, "Not found"), 1, 0, undefined, "no-server-errors", true),
    ).toEqual({
      done: true,
      status: "verified",
      detail: "HTTP 404",
    });
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

describe("the any-response health mode", () => {
  const crashed = res(500, "error code: 1101");
  const edge = res(404, "error code: 1042");
  const down: HealthProbe = { kind: "error", message: "connection refused" };

  it("tells Cloudflare's error pages from the Worker's own answers", () => {
    expect(isEdgeErrorPage(crashed)).toBe(true);
    expect(isEdgeErrorPage(edge)).toBe(true);
    expect(isEdgeErrorPage(res(500, "Cloudflare Access must be configured"))).toBe(false);
    expect(isEdgeErrorPage(down)).toBe(false);
  });

  it("counts any answer of the Worker itself as verified, its own 5xx included", () => {
    for (const answer of [
      res(500, "Cloudflare Access must be configured in production."),
      res(403, "Missing required CF Access JWT"),
      res(401),
      res(302),
    ]) {
      expect(classifyLiveProbe(answer, "any-response")).toBe("pass");
      expect(settleHealthProbe(answer, "any-response").status).toBe("verified");
      expect(decideLiveHealth(answer, 1, 0, undefined, "any-response")).toMatchObject({
        done: true,
        status: "verified",
      });
      expect(classifyHealthProbe(answer, 1, 0, 6, "any-response").verdict).toBe("healthy");
    }
    // The default still calls the Worker's own 5xx unhealthy.
    expect(settleHealthProbe(res(500, "oops")).status).toBe("unhealthy");
    expect(classifyLiveProbe(res(500, "oops"))).toBe("retry");
  });

  it("still retries the 1042 page and connection errors, and judges a crash page as before", () => {
    expect(classifyLiveProbe(edge, "any-response")).toBe("retry");
    expect(classifyLiveProbe(down, "any-response")).toBe("retry");
    expect(classifyLiveProbe(crashed, "any-response")).toBe("retry");
    expect(settleHealthProbe(edge, "any-response").status).toBe("unverified");
    expect(settleHealthProbe(down, "any-response").status).toBe("unverified");
    expect(settleHealthProbe(crashed, "any-response").status).toBe("unhealthy");
    expect(classifyHealthProbe(edge, 1, 0, 6, "any-response").verdict).toBe("retry");
    expect(classifyHealthProbe(crashed, 6, 30_000, 6, "any-response").verdict).toBe("unhealthy");
    // A plain 404 may be a route still going live: it waits out the window as before.
    expect(classifyLiveProbe(res(404, "Not found"), "any-response")).toBe("soft-404");
  });
});

describe("healthCheckOfManifest", () => {
  it("reads the path and mode from the recorded catalog manifest", async () => {
    const f = await buildArtifactFixture({
      catalog: {
        install: {
          tier: "artifact",
          packageManager: "pnpm",
          wranglerConfig: "wrangler.jsonc",
          workerName: "cut",
          health: { path: "/api/health", mode: "any-response" },
        },
      },
    });
    expect(healthCheckOfManifest(JSON.stringify(f.manifest))).toEqual({
      path: "/api/health",
      mode: "any-response",
    });
    expect(healthCheckOfManifest(null)).toEqual({ path: "/", mode: "no-server-errors" });
  });
});

describe("healthPathOfManifest", () => {
  it("falls back to / when the manifest is missing or not an artifact manifest", () => {
    expect(healthPathOfManifest(null)).toBe("/");
    expect(healthPathOfManifest("not json")).toBe("/");
    expect(healthPathOfManifest('{"version":"1.0.0"}')).toBe("/");
  });
});

describe("Cloudflare Access's sign-in redirect", () => {
  const HOST = "cut.appflare-dev.workers.dev";
  const PREVIEW = "0a1b2c3d-cut.appflare-dev.workers.dev";
  const redirect = (location: string, status = 302): HealthProbe => ({
    kind: "response",
    status,
    bodyStart: "",
    location,
  });
  const access = redirect(accessLoginUrl(HOST));
  const edge = res(404, "error code: 1042");

  it("records the Location of an answer, and nothing when there is none", async () => {
    const inits: Array<RequestInit | undefined> = [];
    const probe = await probeHealth(async (_url, init) => {
      inits.push(init);
      return accessChallenge(HOST);
    }, `https://${HOST}/`);
    expect(inits[0]?.redirect).toBe("manual");
    expect(probe).toEqual({
      kind: "response",
      status: 302,
      bodyStart: "",
      body: "",
      location: accessLoginUrl(HOST),
    });
    expect(isAccessChallenge(probe)).toBe(true);
    const plain = await probeHealth(async () => new Response("ok"), `https://${HOST}/`);
    expect(plain).not.toHaveProperty("location");
  });

  it("is a redirect to the sign-in path of a cloudflareaccess.com team domain, on either URL", () => {
    expect(isAccessChallenge(access)).toBe(true);
    expect(isAccessChallenge(redirect(accessLoginUrl(PREVIEW, "/api/health")))).toBe(true);
    expect(isAccessChallenge(redirect(accessLoginUrl(HOST), 307))).toBe(true);
  });

  it("is nothing else", () => {
    const login = new URL(accessLoginUrl(HOST));
    const at = (change: (u: URL) => void) => {
      const u = new URL(login);
      change(u);
      return redirect(u.toString());
    };
    for (const probe of [
      // Not a redirect.
      { ...access, status: 200 },
      { ...access, status: 403 },
      // An app's own redirect, to its own sign-in page or anywhere else.
      redirect("/login"),
      redirect(`https://${HOST}/cdn-cgi/access/login/${HOST}`),
      at((u) => {
        u.hostname = "login.example.com";
      }),
      at((u) => {
        u.hostname = "team.cloudflareaccess.com.evil.example";
      }),
      at((u) => {
        u.hostname = "a.b.cloudflareaccess.com";
      }),
      at((u) => {
        u.protocol = "http:";
      }),
      at((u) => {
        u.port = "8443";
      }),
      at((u) => {
        u.pathname = "/login";
      }),
      redirect("not a url"),
      res(302),
      // The app's own refusal, when it checks the Access token itself.
      res(403, "Missing required CF Access JWT"),
      { kind: "error", message: "connection refused" } satisfies HealthProbe,
    ]) {
      expect(isAccessChallenge(probe)).toBe(false);
    }
  });

  it("never counts as a live check's pass, in either mode, and settles it at once as not verified", () => {
    for (const mode of ["no-server-errors", "any-response"] as const) {
      expect(classifyLiveProbe(access, mode)).toBe("blocked");
      expect(classifyLiveProbe(access, mode, true)).toBe("blocked");
      expect(settleHealthProbe(access, mode)).toEqual({
        status: "unverified",
        detail: ACCESS_CHALLENGE_DETAIL,
        access: true,
      });
      expect(decideLiveHealth(access, 1, 0, undefined, mode)).toEqual({
        done: true,
        status: "unverified",
        detail: "Cloudflare Access asked for a sign-in",
        access: true,
      });
    }
  });

  it("ends the live check at the first Access answer, also after the route went live", () => {
    // 1042 while the route goes live, then Access: three probes, not the 90 s window.
    const answers = [edge, edge, access, res(200)];
    let clock = 0;
    for (let attempt = 1; ; attempt++) {
      const decision = decideLiveHealth(answers[attempt - 1] ?? edge, attempt, clock);
      if (decision.done) {
        expect({ attempt, clock, decision }).toEqual({
          attempt: 3,
          clock: 5_000,
          decision: {
            done: true,
            status: "unverified",
            detail: ACCESS_CHALLENGE_DETAIL,
            access: true,
          },
        });
        break;
      }
      clock += decision.delaySeconds * 1000;
    }
  });

  it("is written to the install with its own flag, which a check that reaches the app clears", () => {
    const at = new Date(0);
    expect(healthColumns(settleHealthProbe(access), at)).toEqual({
      health_status: "unverified",
      health_access: true,
      health_checked_at: at,
    });
    expect(healthColumns(settleHealthProbe(res(200)), at)).toMatchObject({
      health_status: "verified",
      health_access: false,
    });
    expect(healthColumns(settleHealthProbe(edge), at).health_access).toBe(false);
    expect(healthBehindAccess("unverified", true)).toBe(true);
    // A manager from before the flag rewrites the status and leaves the flag.
    expect(healthBehindAccess("verified", true)).toBe(false);
    expect(healthBehindAccess("unhealthy", true)).toBe(false);
    expect(healthBehindAccess("unverified", null)).toBe(false);
    expect(healthBehindAccess(null, true)).toBe(false);
  });

  it("is blocked for a canary, in either mode and on any attempt, never healthy or a failure", () => {
    for (const mode of ["no-server-errors", "any-response"] as const) {
      for (const attempt of [1, 6]) {
        expect(classifyHealthProbe(access, attempt, attempt * 2000, 6, mode)).toEqual({
          verdict: "blocked",
          reason: ACCESS_CHALLENGE_DETAIL,
        });
      }
    }
    // A redirect that is not Access's is still the Worker's answer.
    expect(classifyHealthProbe(redirect("/login"), 1, 0).verdict).toBe("healthy");
  });
});

describe("lookupOnce", () => {
  it("runs the lookup once and answers every later call with it", async () => {
    let lookups = 0;
    const credentials = lookupOnce(async () => {
      lookups += 1;
      return { "CF-Access-Client-Id": "id" };
    });
    expect(await credentials()).toEqual({ "CF-Access-Client-Id": "id" });
    expect(await credentials()).toEqual({ "CF-Access-Client-Id": "id" });
    expect(lookups).toBe(1);
  });
});

describe("probeHealthThroughAccess", () => {
  const HOST = "cut.appflare-dev.workers.dev";
  const PREVIEW = "0a1b2c3d-cut.appflare-dev.workers.dev";
  const url = `https://${HOST}/api/health`;
  const credentials = async () => ({ "CF-Access-Client-Secret": "s" });

  it("probes again with the credentials only after Access's sign-in for the same host", async () => {
    const sent: Array<Record<string, string>> = [];
    const probe = await probeHealthThroughAccess(
      async (_u, init) => {
        const headers = { ...(init?.headers as Record<string, string>) };
        sent.push(headers);
        return headers["CF-Access-Client-Secret"] === "s"
          ? new Response("ok")
          : accessChallenge(HOST, "/api/health");
      },
      url,
      credentials,
    );
    expect(probe).toMatchObject({ kind: "response", status: 200 });
    expect(sent.map((h) => h["CF-Access-Client-Secret"])).toEqual([undefined, "s"]);
  });

  it("never sends them for an app's own answer, a redirect elsewhere, or another host's sign-in", async () => {
    for (const answer of [
      () => new Response("ok"),
      () => new Response(null, { status: 302, headers: { location: "https://elsewhere.net/" } }),
      () => accessChallenge(PREVIEW),
    ]) {
      let asked = 0;
      const sent: Array<Record<string, string>> = [];
      await probeHealthThroughAccess(
        async (_u, init) => {
          sent.push({ ...(init?.headers as Record<string, string>) });
          return answer();
        },
        url,
        async () => {
          asked += 1;
          return { "CF-Access-Client-Secret": "s" };
        },
      );
      expect(asked).toBe(0);
      expect(sent).toHaveLength(1);
    }
  });

  it("keeps the sign-in answer when there are no credentials to send", async () => {
    let calls = 0;
    const probe = await probeHealthThroughAccess(
      async () => {
        calls += 1;
        return accessChallenge(HOST);
      },
      url,
      async () => undefined,
    );
    expect(calls).toBe(1);
    expect(isAccessChallengeFor(probe, url)).toBe(true);
  });
});
