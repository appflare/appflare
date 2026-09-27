import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  hashRecoveryCode,
  normalizeRecoveryCode,
  parseRecoveryCodeSecret,
  RECOVERY_CODE_TTL_MS,
} from "@appflare/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandContext } from "../context.ts";
import { main } from "../main.ts";
import { type FakeHandler, fakeSpawner, fakeUi, LOGGED_IN } from "../test-fixtures.ts";
import { recover } from "./recover.ts";

const NOW = 1_790_000_000_000;

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "appflare-cli-recover-"));
});
afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

function setup(overrides: Record<string, FakeHandler> = {}) {
  const written: Record<string, { worker: string; value: string }> = {};
  const fake = fakeSpawner({
    whoami: () => ({ stdout: LOGGED_IN }),
    "secret list": () => ({
      stdout: JSON.stringify([
        { name: "BETTER_AUTH_SECRET", type: "secret_text" },
        { name: "CF_API_TOKEN", type: "secret_text" },
      ]),
    }),
    "secret put": (call) => {
      if (call.stdin.kind !== "text") throw new Error("secret not on stdin");
      const name = call.args[2] as string;
      written[name] = {
        worker: call.args[call.args.indexOf("--name") + 1] as string,
        value: call.stdin.text,
      };
      return { stdout: `Success! Uploaded secret ${name}` };
    },
    ...overrides,
  });
  const { ui, lines, results } = fakeUi();
  const ctx: CommandContext = {
    ui,
    env: {},
    fetch: async () => {
      throw new Error("recover must not fetch anything");
    },
    spawner: fake.spawner,
    wranglerBin: "/fake/wrangler.js",
    tmpRoot,
  };
  return { ctx, calls: fake.calls, written, lines, results };
}

/** The code printed on stdout. */
function printedCode(results: string[]): string {
  const match = /\b([A-Z2-9]{5}(?:-[A-Z2-9]{5}){3})\b/.exec(results.join("\n"));
  if (match === null) throw new Error("no code printed");
  return match[1] as string;
}

describe("recover", () => {
  it("writes only the code's hash and expiry as a secret on the manager, and prints the code once", async () => {
    const t = setup();
    await recover({ yes: true, now: () => NOW }, t.ctx);

    expect(t.calls.map((c) => c.args.slice(0, 2).join(" "))).toEqual([
      "whoami --json",
      "secret list",
      "secret put",
    ]);
    const code = printedCode(t.results);
    const secret = t.written.RECOVERY_CODE_HASH;
    expect(secret?.worker).toBe("appflare");
    expect(secret?.value).not.toContain(code.replace(/-/g, ""));
    expect(parseRecoveryCodeSecret(secret?.value)).toEqual({
      expiresAt: NOW + RECOVERY_CODE_TTL_MS,
      hash: await hashRecoveryCode(normalizeRecoveryCode(code) as string),
      emailBound: false,
    });
    // Progress goes to stderr; the code appears only in the result.
    expect(t.lines.join("\n")).not.toContain(code);
    expect(t.results.join("\n")).toContain("Forgot your password?");
    expect(t.results.join("\n")).toContain("30 minutes");
  });

  it("binds the code to --email, lower-cased", async () => {
    const t = setup();
    const code = await main(["recover", "--yes", "--email", "Owner@Example.com"], t.ctx);
    expect(code).toBe(0);
    const printed = printedCode(t.results);
    const parsed = parseRecoveryCodeSecret(t.written.RECOVERY_CODE_HASH?.value);
    expect(parsed?.emailBound).toBe(true);
    expect(parsed?.hash).toBe(
      await hashRecoveryCode(normalizeRecoveryCode(printed) as string, "owner@example.com"),
    );
    expect(t.results.join("\n")).toContain("owner@example.com");
  });

  it("refuses an --email that is not an address, before touching the account", async () => {
    const t = setup();
    await expect(recover({ yes: true, email: "not-an-email" }, t.ctx)).rejects.toThrow("--email");
    expect(t.calls).toEqual([]);
  });

  it("uses --name, and gives each run a new code", async () => {
    const t = setup();
    await recover({ name: "my-appflare", yes: true }, t.ctx);
    await recover({ name: "my-appflare", yes: true }, t.ctx);
    const lists = t.calls.filter((c) => c.args[1] === "list");
    expect(lists[0]?.args).toEqual(
      expect.arrayContaining(["secret", "list", "--name", "my-appflare", "--format", "json"]),
    );
    const codes = t.results.map((r) => printedCode([r]));
    expect(codes[0]).not.toBe(codes[1]);
    expect(t.written.RECOVERY_CODE_HASH?.worker).toBe("my-appflare");
  });

  it("refuses when there is no Worker of that name, and writes nothing", async () => {
    const t = setup({
      "secret list": () => ({
        code: 1,
        stderr:
          'Worker "appflare" not found.\n\nIf this is a new Worker, run `wrangler deploy` first.',
      }),
    });
    await expect(recover({ yes: true }, t.ctx)).rejects.toThrow(
      'There is no Worker named "appflare" in this account.',
    );
    expect(t.written).toEqual({});
  });

  it("refuses a Worker that is not a set-up Appflare", async () => {
    const t = setup({ "secret list": () => ({ stdout: "[]" }) });
    await expect(recover({ yes: true }, t.ctx)).rejects.toThrow("is not a set-up Appflare");
    expect(t.written).toEqual({});
  });

  it("reports a failed secret write", async () => {
    const t = setup({
      "secret put": () => ({ code: 1, stderr: "Authentication error [code: 10000]" }),
    });
    await expect(recover({ yes: true }, t.ctx)).rejects.toThrow("secret put RECOVERY_CODE_HASH");
    expect(t.results).toEqual([]);
  });

  it("runs from `create-appflare recover` and sends no usage data", async () => {
    const t = setup();
    const sent: string[] = [];
    t.ctx.fetch = async (url) => {
      sent.push(url);
      return new Response("{}");
    };
    const code = await main(["recover", "--yes", "--name", "appflare"], t.ctx);
    expect(code).toBe(0);
    expect(sent).toEqual([]);
    expect(printedCode(t.results)).toMatch(/-/);
  });
});
