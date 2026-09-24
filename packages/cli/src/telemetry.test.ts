import { TELEMETRY_BATCH_URL } from "@appflare/schema";
import { describe, expect, it } from "vitest";
import type { CommandContext } from "./context.ts";
import { main } from "./main.ts";
import { CliTelemetry, cliVersion, detectAgent, isCi, telemetryNotice } from "./telemetry.ts";
import { fakeUi } from "./test-fixtures.ts";
import { CancelledError } from "./ui.ts";

interface Sent {
  url: string;
  body: {
    batch: { event: string; distinct_id: string; properties: Record<string, unknown> }[];
  };
}

function recorder(respond: () => Promise<Response> = async () => new Response("{}")) {
  const sent: Sent[] = [];
  return {
    sent,
    fetch: async (url: string, init?: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init?.body)) });
      return respond();
    },
  };
}

function telemetry(env: NodeJS.ProcessEnv = {}, optOut = false) {
  const rec = recorder();
  const { ui, lines } = fakeUi();
  let now = 1_000_000;
  const t = new CliTelemetry({
    env,
    optOut,
    fetch: rec.fetch,
    ui,
    now: () => now,
    interactive: true,
    platform: "linux",
    arch: "arm64",
    nodeVersion: "22.11.0",
    version: "0.2.0",
  });
  return { t, rec, lines, advance: (ms: number) => (now += ms) };
}

describe("detectAgent", () => {
  it("reads the agents' own variables", () => {
    expect(detectAgent({})).toBe("none");
    expect(detectAgent({ CLAUDECODE: "1" })).toBe("claude");
    expect(detectAgent({ CODEX_THREAD_ID: "x" })).toBe("codex");
    expect(detectAgent({ CURSOR_TRACE_ID: "x" })).toBe("cursor");
    expect(detectAgent({ COPILOT_MODEL: "gpt" })).toBe("github-copilot");
    expect(detectAgent({ AI_AGENT: "Amp" })).toBe("amp");
  });
  it("never passes free text through AI_AGENT", () => {
    expect(detectAgent({ AI_AGENT: "my agent at /home/ada" })).toBe("none");
  });
});

describe("isCi", () => {
  it("treats CI=false, 0 or empty as not CI", () => {
    expect(isCi(undefined)).toBe(false);
    expect(isCi("")).toBe(false);
    expect(isCi("false")).toBe(false);
    expect(isCi("0")).toBe(false);
    expect(isCi("true")).toBe(true);
    expect(isCi("1")).toBe(true);
  });
});

describe("CliTelemetry", () => {
  it("is off with --no-telemetry, APPFLARE_TELEMETRY=off or DO_NOT_TRACK=1", () => {
    expect(telemetry({}, true).t.enabled).toBe(false);
    expect(telemetry({ APPFLARE_TELEMETRY: "off" }).t.enabled).toBe(false);
    expect(telemetry({ DO_NOT_TRACK: "1" }).t.enabled).toBe(false);
    expect(telemetry({}).t.enabled).toBe(true);
  });

  it("deploys the manager with this run's install id, or with usage data off", () => {
    const on = telemetry().t;
    expect(on.managerVars()).toEqual({ APPFLARE_INSTALL_ID: on.installId });
    expect(on.installId).toMatch(/^[0-9a-f-]{36}$/);
    expect(telemetry({}, true).t.managerVars()).toEqual({ APPFLARE_TELEMETRY: "off" });
  });

  it("prints the notice once, and only when on", () => {
    const on = telemetry();
    on.t.begin(false);
    on.t.begin(false);
    expect(on.lines).toEqual(telemetryNotice().map((l) => `  ${l}`));
    const off = telemetry({}, true);
    off.t.begin(false);
    expect(off.lines).toEqual([]);
  });

  it("sends one event when the run ends, never before, with no names or paths", async () => {
    const { t, rec, advance } = telemetry({ CI: "true", CLAUDECODE: "1" });
    await t.finish("failed", new Error("nothing started"));
    expect(rec.sent).toEqual([]);

    t.begin(true);
    t.nameIsDefault = false;
    t.loginNeeded = false;
    t.severalAccounts = true;
    t.managerVersion = "0.5.0";
    t.step = "deploy";
    advance(42_000);
    await t.finish(
      "failed",
      new Error('`wrangler deploy` failed for "my-secret-name" in /home/ada'),
    );
    expect(rec.sent).toHaveLength(1);
    const [{ url, body }] = rec.sent as [Sent];
    expect(url).toBe(TELEMETRY_BATCH_URL);
    expect(body.batch).toHaveLength(1);
    expect(body.batch[0]?.event).toBe("cli setup finished");
    expect(body.batch[0]?.distinct_id).toBe(t.installId);
    expect(body.batch[0]?.properties).toMatchObject({
      $process_person_profile: false,
      $geoip_disable: true,
      $lib: "appflare-cli",
      source: "cli",
      manager_version: "0.5.0",
      outcome: "failed",
      duration_s: 42,
      error_category: "wrangler_deploy",
      last_step: "deploy",
      cli_version: "0.2.0",
      os: "linux",
      arch: "arm64",
      node_major: 22,
      interactive: true,
      ci: true,
      yes_flag: true,
      name_is_default: false,
      several_accounts: true,
      login_needed: false,
      agent: "claude",
    });
    const text = JSON.stringify(body);
    expect(text).not.toContain("my-secret-name");
    expect(text).not.toContain("/home/ada");
  });

  it("names cancellations and successes", async () => {
    const cancelled = telemetry();
    cancelled.t.begin(false);
    cancelled.t.step = "account";
    await cancelled.t.finish("cancelled", new CancelledError());
    expect(cancelled.rec.sent[0]?.body.batch[0]?.properties).toMatchObject({
      outcome: "cancelled",
      error_category: "cancelled",
    });
    const ok = telemetry();
    ok.t.begin(false);
    await ok.t.finish("succeeded");
    expect(ok.rec.sent[0]?.body.batch[0]).toMatchObject({
      event: "cli setup finished",
      properties: { outcome: "succeeded", error_category: null, last_step: "done" },
    });
    expect(ok.rec.sent[0]?.body.batch[0]?.properties).not.toHaveProperty("command");
  });

  it("never lets a failed send affect the run", async () => {
    const { ui } = fakeUi();
    const t = new CliTelemetry({
      env: {},
      optOut: false,
      ui,
      fetch: async () => {
        throw new Error("offline");
      },
    });
    t.begin(false);
    await expect(t.finish("succeeded")).resolves.toBeUndefined();
  });

  it("knows its own version", () => {
    expect(cliVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("main", () => {
  function context(fetch: CommandContext["fetch"]): CommandContext {
    // No Node.js version check passes, so the install fails at its first step.
    return { ui: fakeUi().ui, env: {}, fetch, nodeVersion: "20.0.0" };
  }

  it("sends the run's event when the install ends, and nothing with --no-telemetry", async () => {
    const on = recorder();
    expect(await main(["--yes"], context(on.fetch))).toBe(1);
    expect(on.sent.map((s) => s.body.batch[0])).toEqual([
      expect.objectContaining({
        event: "cli setup finished",
        properties: expect.objectContaining({
          outcome: "failed",
          error_category: "node_version",
          yes_flag: true,
        }),
      }),
    ]);

    const off = recorder();
    expect(await main(["--yes", "--no-telemetry"], context(off.fetch))).toBe(1);
    expect(off.sent).toEqual([]);
  });

  it("sends nothing for --help, --version, or arguments it refuses", async () => {
    const rec = recorder();
    expect(await main(["--bogus"], context(rec.fetch))).toBe(1);
    expect(await main(["status"], context(rec.fetch))).toBe(1);
    expect(await main(["--help"], context(rec.fetch))).toBe(0);
    expect(await main(["--version"], context(rec.fetch))).toBe(0);
    expect(rec.sent).toEqual([]);
  });
});
