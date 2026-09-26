import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUILD_HOOKS_OFF_ENV,
  BuildCommandError,
  outputTail,
  runBuildCommand,
  runBuildCommands,
} from "./build-command.ts";
import { scrubEnv } from "./scrub-env.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "appflare-build-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function script(name: string, source: string): void {
  writeFileSync(path.join(dir, name), source);
}

describe("runBuildCommand", () => {
  it("runs the command in the checkout with a scrubbed environment and .bin on PATH", async () => {
    script(
      "build.mjs",
      `import { writeFileSync } from "node:fs";
writeFileSync("seen.json", JSON.stringify({
  args: process.argv.slice(2),
  token: process.env.CLOUDFLARE_API_TOKEN ?? null,
  key: process.env.MY_SIGN_KEY ?? null,
  path: process.env.PATH,
}));`,
    );
    const logs: string[] = [];
    await runBuildCommand({
      checkoutDir: dir,
      command: "node build.mjs --mode=selfhost  @scope/web",
      env: scrubEnv({ ...process.env, CLOUDFLARE_API_TOKEN: "cf-DO-NOT-LEAK", MY_SIGN_KEY: "k" }, [
        "MY_SIGN_KEY",
      ]),
      logger: (m) => logs.push(m),
    });
    const seen = JSON.parse(readFileSync(path.join(dir, "seen.json"), "utf8")) as {
      args: string[];
      token: string | null;
      key: string | null;
      path: string;
    };
    expect(seen.args).toEqual(["--mode=selfhost", "@scope/web"]);
    expect(seen.token).toBeNull();
    expect(seen.key).toBeNull();
    expect(seen.path.split(path.delimiter)[0]).toBe(path.join(dir, "node_modules", ".bin"));
    expect(logs[0]).toContain("running install.buildCommand: node build.mjs");
    expect(logs.at(-1)).toMatch(/finished in/);
  });

  it("finds programs the checkout installed in node_modules/.bin", async () => {
    const bin = path.join(dir, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, "make-site"), "#!/bin/sh\necho built > site.txt\n", {
      mode: 0o755,
    });
    await runBuildCommand({ checkoutDir: dir, command: "make-site", env: scrubEnv(process.env) });
    expect(readFileSync(path.join(dir, "site.txt"), "utf8")).toBe("built\n");
  });

  it("fails with the exit code and the last lines of the output", async () => {
    script(
      "fail.mjs",
      `for (let i = 1; i <= 60; i++) console.log("line " + i);
console.error("error: vite could not resolve ./missing");
process.exit(3);`,
    );
    const failure = runBuildCommand({
      checkoutDir: dir,
      command: "node fail.mjs",
      env: scrubEnv(process.env),
    });
    await expect(failure).rejects.toThrow(BuildCommandError);
    const message = await failure.catch((e: Error) => e.message);
    expect(message).toContain('install.buildCommand "node fail.mjs" failed (exit 3)');
    expect(message).toContain("error: vite could not resolve ./missing");
    expect(message).toContain("line 60");
    expect(message).not.toContain("line 5\n");
  });

  it("stops a build that runs out of time, with everything it started", async () => {
    script(
      "slow.mjs",
      `import { spawn } from "node:child_process";
spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "inherit" });
console.log("started");
setTimeout(() => {}, 60000);`,
    );
    const started = Date.now();
    const failure = runBuildCommand({
      checkoutDir: dir,
      command: "node slow.mjs",
      env: scrubEnv(process.env),
      timeoutMs: 1_000,
    });
    await expect(failure).rejects.toThrow(/did not finish within 1 seconds and was stopped/);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  it("does not hang when a process the build moved out of its group keeps the output open", async () => {
    // The grandchild starts its own session, so stopping the build's group
    // cannot reach it, and it inherits the build's stdout.
    script(
      "escape.mjs",
      `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
  stdio: ["ignore", "inherit", "inherit"],
  detached: true,
});
child.unref();
writeFileSync("escaped.pid", String(child.pid));
console.log("built");`,
    );
    const started = Date.now();
    try {
      await runBuildCommand({
        checkoutDir: dir,
        command: "node escape.mjs",
        env: scrubEnv(process.env),
        exitGraceMs: 300,
      });
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      const pid = Number(readFileSync(path.join(dir, "escaped.pid"), "utf8"));
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }, 20_000);

  it("stops waiting after a timeout even when the output never closes", async () => {
    script(
      "stuck.mjs",
      `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
  stdio: ["ignore", "inherit", "inherit"],
  detached: true,
});
writeFileSync("stuck.pid", String(child.pid));
setTimeout(() => {}, 60000);`,
    );
    const started = Date.now();
    try {
      await expect(
        runBuildCommand({
          checkoutDir: dir,
          command: "node stuck.mjs",
          env: scrubEnv(process.env),
          timeoutMs: 500,
          exitGraceMs: 300,
        }),
      ).rejects.toThrow(/did not finish within 1 seconds/);
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      const pid = Number(readFileSync(path.join(dir, "stuck.pid"), "utf8"));
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }, 20_000);

  it("reports a program that does not exist", async () => {
    await expect(
      runBuildCommand({
        checkoutDir: dir,
        command: "no-such-build-tool build",
        env: scrubEnv(process.env),
      }),
    ).rejects.toThrow(/could not run install.buildCommand "no-such-build-tool build": .*ENOENT/);
  });

  it("refuses a command a shell would interpret, without running anything", async () => {
    await expect(
      runBuildCommand({
        checkoutDir: dir,
        command: "node build.mjs && touch pwned",
        env: scrubEnv(process.env),
      }),
    ).rejects.toThrow(/contains "&"/);
  });
});

describe("runBuildCommands", () => {
  it("runs every command in order", async () => {
    script(
      "step.mjs",
      `import { appendFileSync } from "node:fs";
appendFileSync("steps.txt", process.argv[2] + "\\n");`,
    );
    const logs: string[] = [];
    await runBuildCommands({
      checkoutDir: dir,
      commands: ["node step.mjs one", "node step.mjs two", "node step.mjs three"],
      env: scrubEnv(process.env),
      logger: (m) => logs.push(m),
    });
    expect(readFileSync(path.join(dir, "steps.txt"), "utf8")).toBe("one\ntwo\nthree\n");
    expect(logs[0]).toContain("running install.buildCommand (1 of 3): node step.mjs one");
  });

  it("stops at the first command that fails, naming it", async () => {
    script(
      "step.mjs",
      `import { appendFileSync } from "node:fs";
appendFileSync("steps.txt", process.argv[2] + "\\n");
if (process.argv[2] === "two") process.exit(2);`,
    );
    const failure = runBuildCommands({
      checkoutDir: dir,
      commands: ["node step.mjs one", "node step.mjs two", "node step.mjs three"],
      env: scrubEnv(process.env),
    });
    await expect(failure).rejects.toThrow(
      'install.buildCommand (2 of 3) "node step.mjs two" failed (exit 2)',
    );
    expect(readFileSync(path.join(dir, "steps.txt"), "utf8")).toBe("one\ntwo\n");
  });

  it("checks every command before running the first", async () => {
    script("step.mjs", `import { writeFileSync } from "node:fs"; writeFileSync("ran.txt", "x");`);
    const failure = runBuildCommands({
      checkoutDir: dir,
      commands: ["node step.mjs", "pnpm build | tee log"],
      env: scrubEnv(process.env),
    });
    await expect(failure).rejects.toThrow('install.buildCommand (2 of 2) contains "|"');
    expect(existsSync(path.join(dir, "ran.txt"))).toBe(false);
  });

  it("turns off pre and post hooks of package scripts", async () => {
    script(
      "package.json",
      JSON.stringify({
        name: "hooks",
        private: true,
        scripts: {
          prebuild: "node -e \"require('fs').writeFileSync('pre.txt','x')\"",
          build: "node -e \"require('fs').writeFileSync('build.txt','x')\"",
          postbuild: "node -e \"require('fs').writeFileSync('post.txt','x')\"",
        },
      }),
    );
    script(
      "env.mjs",
      `import { writeFileSync } from "node:fs";
writeFileSync("env.json", JSON.stringify({
  prePost: process.env.npm_config_enable_pre_post_scripts,
  ignore: process.env.npm_config_ignore_scripts,
}));`,
    );
    await runBuildCommands({
      checkoutDir: dir,
      commands: ["node env.mjs", "npm run build"],
      env: scrubEnv(process.env),
    });
    expect(JSON.parse(readFileSync(path.join(dir, "env.json"), "utf8"))).toEqual({
      prePost: BUILD_HOOKS_OFF_ENV.npm_config_enable_pre_post_scripts,
      ignore: BUILD_HOOKS_OFF_ENV.npm_config_ignore_scripts,
    });
    expect(existsSync(path.join(dir, "build.txt"))).toBe(true);
    expect(existsSync(path.join(dir, "pre.txt"))).toBe(false);
    expect(existsSync(path.join(dir, "post.txt"))).toBe(false);
  });
});

describe("outputTail", () => {
  it("keeps the last lines and drops trailing blank ones", () => {
    expect(outputTail("a\r\nb\nc\n\n\n", 2)).toBe("b\nc");
    expect(outputTail("", 3)).toBe("");
  });
});
