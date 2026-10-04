import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { forgetZoneNames } from "../../access/probe-credentials.server";
import { createMigrator } from "../../db/migrate";
import { migrations } from "../../db/migrations/index";
import { accessChallenge } from "../../test/access-sign-in";
import { ACC, SUBDOMAIN } from "../../test/fake-account";
import { fakeStep } from "../../test/fake-step";
import { recordProtectedInstall } from "../../test/protected-install";
import { INSTALL_ID, seedInstall } from "../../test/seed-install";
import type { JobContext } from "../run-job";
import { createJobSteps } from "../steps";
import { checkLiveHealthPhase, probeUntilHealthy } from "./phases";

/**
 * The job's health checks of an install protected with Cloudflare Access:
 * the live check and the canary send the install's own service token to its
 * workers.dev addresses, and to its custom domain only while that domain's
 * zone is the account's.
 */

const AUTH = "auth-secret-0123456789abcdef0123456789";
const SECRET = "client-secret-DO-NOT-LEAK";
const JOB = "job-1";
const LIVE = `https://cut.${SUBDOMAIN}.workers.dev/`;
const PREVIEW = `https://01234567-cut.${SUBDOMAIN}.workers.dev/`;

interface Seen {
  url: string;
  headers: Record<string, string>;
}

function harness(
  answer: (url: string, headers: Record<string, string>) => Response,
  zones: string[] = [],
) {
  const seen: Seen[] = [];
  const step = fakeStep();
  const ctx = {
    params: {} as JobContext["params"],
    step,
    env: {
      DB: env.DB,
      CF_API_TOKEN: "cf-token-DO-NOT-LEAK",
      BETTER_AUTH_SECRET: AUTH,
    },
    deps: {
      now: () => Date.parse("2026-09-30T12:00:00.000Z"),
      fetch: async (input: string, init?: RequestInit) => {
        const url = new URL(input);
        if (url.hostname === "api.cloudflare.com") {
          return Response.json({
            success: true,
            errors: [],
            messages: [],
            result: zones.map((name, i) => ({
              id: `z${i}`,
              name,
              status: "active",
              account: { id: ACC },
            })),
            result_info: { page: 1, total_pages: 1 },
          });
        }
        const headers = { ...(init?.headers as Record<string, string> | undefined) };
        seen.push({ url: input, headers });
        return answer(input, headers);
      },
    },
  } satisfies JobContext;
  const steps = createJobSteps(ctx, JOB);
  steps.setAccountId(ACC);
  return { steps, step, seen };
}

/** The app behind Access: the sign-in page without the token, the app with it. */
function protectedApp(_url: string, headers: Record<string, string>): Response {
  return headers["CF-Access-Client-Secret"] === SECRET
    ? new Response('{"version":"2.0.0"}', { status: 200 })
    : accessChallenge(new URL(_url).hostname);
}

async function storeToken() {
  await recordProtectedInstall({
    installId: INSTALL_ID,
    authSecret: AUTH,
    secret: SECRET,
    clientId: "client-1.access",
  });
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  forgetZoneNames();
  await seedInstall({
    resources: [
      { kind: "domain", name: "app.example.com" },
      { kind: "custom_hostname", name: "app.customer.net" },
    ],
  });
  await env.DB.prepare(
    `INSERT INTO jobs (id, install_id, kind, status, worker_version_id, started_by)
     VALUES (?1, ?2, 'update', 'running', '01234567-89ab-4cde-8f01-23456789abcd', 'admin')`,
  )
    .bind(JOB, INSTALL_ID)
    .run();
});

describe("health checks of a protected app in a job", () => {
  it("verifies it through Access with the service token on its workers.dev address", async () => {
    await storeToken();
    const { steps, step, seen } = harness(protectedApp);
    const result = await checkLiveHealthPhase(steps, step, LIVE, undefined, {
      installId: INSTALL_ID,
    });
    expect(result).toMatchObject({ status: "verified", detail: "HTTP 200" });
    // First without the token; only after Access's sign-in, again with it.
    expect(seen.map((s) => s.url)).toEqual([LIVE, LIVE]);
    expect(seen[0]?.headers["CF-Access-Client-Secret"]).toBeUndefined();
    expect(seen[1]?.headers).toMatchObject({
      "CF-Access-Client-Id": "client-1.access",
      "CF-Access-Client-Secret": SECRET,
    });
    // Neither the step results nor the job log carry the secret.
    const logs = await env.DB.prepare("SELECT message, data_json FROM job_logs").all();
    expect(JSON.stringify(logs.results)).not.toContain("DO-NOT-LEAK");
    expect(JSON.stringify(result)).not.toContain("DO-NOT-LEAK");
  });

  it("sends later attempts straight with the token once Access let it through", async () => {
    await storeToken();
    /** Behind Access; with the token, the route is not live yet (1042) twice, then the app. */
    const answers = (tokenAnswers: Response[]) => (url: string, headers: Record<string, string>) =>
      headers["CF-Access-Client-Secret"] === SECRET
        ? (tokenAnswers.shift() ?? new Response('{"version":"2.0.0"}', { status: 200 }))
        : accessChallenge(new URL(url).hostname);
    const live = harness(
      answers([
        new Response("error code: 1042", { status: 404 }),
        new Response("error code: 1042", { status: 404 }),
      ]),
    );
    expect(
      await checkLiveHealthPhase(live.steps, live.step, LIVE, undefined, { installId: INSTALL_ID }),
    ).toMatchObject({ status: "verified" });
    const withToken = (seen: Seen[]) =>
      seen.map((x) => x.headers["CF-Access-Client-Secret"] === SECRET);
    // The first attempt asks Access first; the next two go straight with the token.
    expect(withToken(live.seen)).toEqual([false, true, true, true]);

    const canary = harness(answers([new Response("error code: 1042", { status: 404 })]));
    expect(
      await probeUntilHealthy(canary.steps, canary.step, {
        label: "canary",
        url: PREVIEW,
        healthyMessage: "the new version serves",
        installId: INSTALL_ID,
      }),
    ).toBe(200);
    expect(withToken(canary.seen)).toEqual([false, true, true]);
  });

  it("settles as behind Access when a probe sent straight with the token meets the sign-in", async () => {
    await storeToken();
    let tokenProbes = 0;
    const { steps, step, seen } = harness((url, headers) => {
      if (headers["CF-Access-Client-Secret"] !== SECRET)
        return accessChallenge(new URL(url).hostname);
      tokenProbes += 1;
      // Accepted with a 1042 first; then (the token revoked meanwhile) the sign-in.
      if (tokenProbes === 1) return new Response("error code: 1042", { status: 404 });
      return accessChallenge(new URL(url).hostname);
    });
    const result = await checkLiveHealthPhase(steps, step, LIVE, undefined, {
      installId: INSTALL_ID,
    });
    // Access answered in the app's place, as for any check that meets the sign-in.
    expect(result).toMatchObject({ status: "unverified", access: true });
    expect(seen.map((x) => x.headers["CF-Access-Client-Secret"] === SECRET)).toEqual([
      false,
      true,
      true,
    ]);
  });

  it("checks the canary on a preview address the same way", async () => {
    await storeToken();
    const { steps, step } = harness(protectedApp);
    const status = await probeUntilHealthy(steps, step, {
      label: "canary",
      url: PREVIEW,
      healthyMessage: "the new version serves",
      expectVersion: "2.0.0",
      installId: INSTALL_ID,
    });
    expect(status).toBe(200);
  });

  it("sends the token to the install's custom domain only, never its external domain", async () => {
    await storeToken();
    const own = harness(protectedApp, ["example.com"]);
    expect(
      await checkLiveHealthPhase(own.steps, own.step, "https://app.example.com/", undefined, {
        installId: INSTALL_ID,
      }),
    ).toMatchObject({ status: "verified" });
    // Even with the external domain's zone listed, it is not an address the token may go to.
    const external = harness(protectedApp, ["example.com", "customer.net"]);
    const result = await checkLiveHealthPhase(
      external.steps,
      external.step,
      "https://app.customer.net/",
      undefined,
      { installId: INSTALL_ID },
    );
    // Access's sign-in still ends the check as before, and nothing was sent.
    expect(result).toMatchObject({ status: "unverified", access: true });
    expect(external.seen.every((s) => s.headers["CF-Access-Client-Secret"] === undefined)).toBe(
      true,
    );
  });

  it("never sends the token to a Worker that answers for itself: Access is not in front of it", async () => {
    await storeToken();
    const open = harness(() => new Response("app", { status: 200 }));
    expect(
      await checkLiveHealthPhase(open.steps, open.step, LIVE, undefined, { installId: INSTALL_ID }),
    ).toMatchObject({ status: "verified" });
    expect(open.seen).toHaveLength(1);
    expect(open.seen[0]?.headers["CF-Access-Client-Secret"]).toBeUndefined();
    // A redirect that is not Access's sign-in for this host (another host, or the Worker's own).
    for (const location of [
      "https://elsewhere.example.net/login",
      "https://team.cloudflareaccess.com/cdn-cgi/access/login/notes.appflare-dev.workers.dev",
    ]) {
      const moved = harness(() => new Response(null, { status: 302, headers: { location } }));
      await checkLiveHealthPhase(moved.steps, moved.step, LIVE, undefined, {
        installId: INSTALL_ID,
      });
      expect(
        moved.seen.every((s) => s.headers["CF-Access-Client-Secret"] === undefined),
        location,
      ).toBe(true);
    }
  });

  it("changes nothing while the install is not protected, or without an install to check for", async () => {
    const { steps, step, seen } = harness(protectedApp, ["example.com"]);
    const result = await checkLiveHealthPhase(steps, step, LIVE, undefined, {
      installId: INSTALL_ID,
    });
    expect(result).toMatchObject({ status: "unverified", access: true });
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0]?.headers ?? {})).toEqual(["user-agent"]);
    // Another Worker of the app (no install given) never gets the token.
    await storeToken();
    const other = harness(protectedApp);
    await checkLiveHealthPhase(other.steps, other.step, LIVE);
    expect(Object.keys(other.seen[0]?.headers ?? {})).toEqual(["user-agent"]);
  });
});
