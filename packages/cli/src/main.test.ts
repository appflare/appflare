import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "./context.ts";
import { main, REMOVED_COMMANDS, USAGE, wantsVersion } from "./main.ts";
import { cliVersion } from "./telemetry.ts";
import { fakeUi } from "./test-fixtures.ts";

function context() {
  const { ui, lines, results } = fakeUi();
  const fetched: string[] = [];
  const ctx: CommandContext = {
    ui,
    // Usage data off, so nothing leaves the test.
    env: { APPFLARE_TELEMETRY: "off" },
    fetch: async (url) => {
      fetched.push(url);
      return new Response("{}");
    },
    nodeVersion: "20.0.0",
  };
  return { ctx, lines, results, fetched };
}

describe("wantsVersion", () => {
  it("is -v, or --version without a value", () => {
    expect(wantsVersion(["-v"])).toBe(true);
    expect(wantsVersion(["--version"])).toBe(true);
    expect(wantsVersion(["--version", "--yes"])).toBe(true);
    expect(wantsVersion(["--yes", "--version"])).toBe(true);
  });
  it("leaves --version <x.y.z> to pick the manager release", () => {
    expect(wantsVersion(["--version", "0.5.0"])).toBe(false);
    expect(wantsVersion(["--version=0.5.0"])).toBe(false);
    expect(wantsVersion(["--yes"])).toBe(false);
  });
});

describe("main", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function stderr(): string[] {
    const written: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    return written;
  }

  it("prints the help on stdout and starts nothing", async () => {
    for (const flag of ["--help", "-h"]) {
      const t = context();
      expect(await main([flag], t.ctx)).toBe(0);
      expect(t.results).toEqual([USAGE.trimEnd()]);
      expect(t.lines).toEqual([]);
    }
  });

  it("prints the installer's version", async () => {
    const t = context();
    expect(await main(["--version"], t.ctx)).toBe(0);
    expect(t.results).toEqual([cliVersion()]);
  });

  it("installs by default", async () => {
    const written = stderr();
    const t = context();
    // The install starts and fails at its first check, the Node.js version.
    expect(await main(["--yes", "--version", "0.5.0"], t.ctx)).toBe(1);
    expect(t.lines).toContain("Appflare");
    expect(written.join("")).toContain("needs Node.js 22");
    expect(t.results).toEqual([]);
  });

  it("names where each removed command's job is done now", async () => {
    const written = stderr();
    const runs: [string, ...string[]][] = [
      ["status"],
      ["rollback", "--to", "v-1"],
      ["uninstall", "--yes", "--purge"],
      ["sandbox", "enable"],
    ];
    for (const [command, ...rest] of runs) {
      const t = context();
      expect(await main([command, ...rest], t.ctx)).toBe(1);
      expect(t.lines).toEqual([]);
      expect(written.pop()).toContain(
        `\`${command}\` is no longer part of the installer; ${REMOVED_COMMANDS[command]}.`,
      );
    }
    expect(REMOVED_COMMANDS.status).toContain(
      "Settings > Updates (https://<your manager>/settings/updates#appflare)",
    );
    expect(REMOVED_COMMANDS.uninstall).toContain("Remove Appflare");
    expect(REMOVED_COMMANDS.uninstall).toContain("/settings/account#danger-zone");
    expect(REMOVED_COMMANDS.sandbox).toContain(
      "Settings > Building apps (https://<your manager>/settings/building#sandbox)",
    );
    expect(REMOVED_COMMANDS.rollback).toContain("Deployments page");
  });

  it("refuses other arguments", async () => {
    const written = stderr();
    const t = context();
    expect(await main(["whatever"], t.ctx)).toBe(1);
    expect(written.pop()).toContain("unexpected argument: whatever (see --help)");
    expect(await main(["--purge"], t.ctx)).toBe(1);
    expect(t.lines).toEqual([]);
  });
});
