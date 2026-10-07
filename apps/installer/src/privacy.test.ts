import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT, FakeWorld, SUBDOMAIN, TOKEN, ZONE_ID } from "./test/fake-world";
import {
  type Answer,
  clearRecords,
  createInstallation,
  HANDOFF_HASH,
  installerApp,
  type StepAnswer,
  stepUntil,
} from "./test/harness";
import { buildRelease } from "./test/release-fixture";

/**
 * The access token lives only in request memory: it reaches Cloudflare's API
 * and nothing else. It is never written to D1, never logged, never sent back.
 * Logs also carry no account id, hostname, Worker name, key or hash.
 */

let lines: string[] = [];

beforeEach(async () => {
  await clearRecords();
  lines = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("privacy", () => {
  it("keeps the token out of D1, logs and answers through a whole deploy and cleanup", async () => {
    const world = new FakeWorld(await buildRelease());
    const call = installerApp(world);
    const answers: Answer<unknown>[] = [];
    const track = async <T>(p: Promise<Answer<T>>) => {
      const answer = await p;
      answers.push(answer);
      return answer;
    };
    await track(call("accounts"));
    await track(call("zones", { accountId: ACCOUNT }));
    await track(
      call("check", {
        accountId: ACCOUNT,
        workerName: "secret-name",
        hostname: "secret-host.example.com",
      }),
    );
    const created = await createInstallation(call, {
      workerName: "secret-name",
      hostname: "secret-host.example.com",
    });
    world.addressAnswers.set("secret-host.example.com", ["tls"]);
    // A failure along the way: its message and log line must not leak either.
    world.failOnce.set("POST /d1/database", 403);
    const { answers: steps } = await stepUntil(
      call,
      created,
      (a: StepAnswer) => a.status === "deployed",
    );
    expect(steps.some((a) => a.status === "failed")).toBe(true);
    await track(call("installations/find", { accountId: ACCOUNT }));

    const rows = await env.DB.prepare("SELECT * FROM installations").all();
    const stored = JSON.stringify(rows.results);
    expect(stored).not.toContain(TOKEN);
    expect(stored).not.toContain(created.key);

    // An expired token, refused by Cloudflare: still not echoed.
    world.acceptedToken = "rotated-token-0000000000";
    await track(call(`installations/${created.installationId}/cleanup`, { key: created.key }));
    world.acceptedToken = TOKEN;
    await track(call(`installations/${created.installationId}/cleanup`, { key: created.key }));

    const sent = [...answers.map((a) => a.text), ...steps.map((s) => JSON.stringify(s))].join("\n");
    expect(sent).not.toContain(TOKEN);

    const logged = lines.join("\n");
    expect(lines.length).toBeGreaterThan(10);
    for (const value of [
      TOKEN,
      ACCOUNT,
      ZONE_ID,
      SUBDOMAIN,
      "secret-name",
      "secret-host",
      created.key,
      created.installationId,
      HANDOFF_HASH,
    ]) {
      expect(logged).not.toContain(value);
    }
    // The token went to Cloudflare's API only, in the Authorization header.
    expect(world.bodies.join("\n")).not.toContain(TOKEN);
    expect(world.calls.join("\n")).not.toContain(TOKEN);
  });
});
