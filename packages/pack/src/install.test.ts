import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CatalogInstallDir } from "@appflare/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findLockfile,
  InstallError,
  type InstallInvocation,
  type InstallRunner,
  installDependencies,
  installInvocation,
  resolveInstallDir,
} from "./install.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "appflare-install-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function file(rel: string, content = "{}\n"): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

interface Ran {
  cwd: string;
  line: string;
}

/** A runner that records each run and succeeds, optionally writing a file first. */
function recorder(write?: (invocation: InstallInvocation, cwd: string) => void): {
  runs: Ran[];
  run: InstallRunner;
} {
  const runs: Ran[] = [];
  return {
    runs,
    run: (invocation, cwd) => {
      runs.push({
        cwd: path.relative(root, cwd) || ".",
        line: [invocation.command, ...invocation.args].join(" "),
      });
      write?.(invocation, cwd);
      return { status: 0, stdout: "", stderr: "" };
    },
  };
}

function install(
  installDirs: CatalogInstallDir[],
  run: InstallRunner,
  packageManager: "pnpm" | "npm" | "yarn" | "bun" = "pnpm",
): string[] {
  const logs: string[] = [];
  installDependencies({
    checkoutDir: root,
    installDirs,
    packageManager,
    env: {},
    logger: (m) => logs.push(m),
    run,
  });
  return logs;
}

describe("installInvocation", () => {
  it("runs the frozen install with scripts disabled when a lockfile is required", () => {
    const lines = (["pnpm", "npm", "yarn", "bun"] as const).map((pm) => {
      const inv = installInvocation(pm, "required");
      return [inv.command, ...inv.args].join(" ");
    });
    expect(lines).toEqual([
      "pnpm install --frozen-lockfile --ignore-scripts --config.package-manager-strict=false",
      "npm ci --ignore-scripts",
      "yarn install --frozen-lockfile --ignore-scripts",
      "bun install --frozen-lockfile --ignore-scripts",
    ]);
  });

  it("resolves and writes a lockfile, still with scripts disabled, when there is none", () => {
    const lines = (["pnpm", "npm", "yarn", "bun"] as const).map((pm) => {
      const inv = installInvocation(pm, "none");
      return [inv.command, ...inv.args].join(" ");
    });
    expect(lines).toEqual([
      "pnpm install --no-frozen-lockfile --ignore-scripts --config.package-manager-strict=false",
      "npm install --ignore-scripts --no-audit --no-fund",
      "yarn install --ignore-scripts",
      "bun install --ignore-scripts",
    ]);
  });

  it("keeps the environment that turns scripts and strict pinning off", () => {
    expect(installInvocation("pnpm", "none").env).toEqual({ COREPACK_ENABLE_STRICT: "0" });
    expect(installInvocation("yarn", "none").env).toEqual({ YARN_ENABLE_SCRIPTS: "false" });
  });
});

describe("installDependencies", () => {
  it("installs the root alone by default, with the entry's package manager", () => {
    file("package.json");
    file("pnpm-lock.yaml");
    const { runs, run } = recorder();
    install([{ path: "." }], run);
    expect(runs).toEqual([
      {
        cwd: ".",
        line: "pnpm install --frozen-lockfile --ignore-scripts --config.package-manager-strict=false",
      },
    ]);
  });

  it("installs every listed directory once, in the listed order", () => {
    file("package.json");
    file("pnpm-lock.yaml");
    file("templates/blog/package.json");
    file("templates/blog/package-lock.json");
    file("worker/package.json");
    file("worker/bun.lock");
    const { runs, run } = recorder();
    install(
      [{ path: "templates/blog" }, { path: "." }, { path: "worker", packageManager: "bun" }],
      run,
    );
    expect(runs).toEqual([
      // Its lockfile names npm.
      { cwd: "templates/blog", line: "npm ci --ignore-scripts" },
      {
        cwd: ".",
        line: "pnpm install --frozen-lockfile --ignore-scripts --config.package-manager-strict=false",
      },
      // Named explicitly.
      { cwd: "worker", line: "bun install --frozen-lockfile --ignore-scripts" },
    ]);
  });

  it("does not install the root unless it is listed", () => {
    file("templates/blog/package.json");
    file("templates/blog/pnpm-lock.yaml");
    const { runs, run } = recorder();
    install([{ path: "templates/blog" }], run);
    expect(runs.map((r) => r.cwd)).toEqual(["templates/blog"]);
  });

  it("uses the entry's package manager when a directory holds its lockfile beside another", () => {
    file("package.json");
    file("pnpm-lock.yaml");
    file("package-lock.json");
    const { runs, run } = recorder();
    install([{ path: "." }], run, "npm");
    expect(runs[0]?.line).toBe("npm ci --ignore-scripts");
  });

  it("logs the sha256 of the lockfile a lockfile-less install wrote", () => {
    file("templates/blog/package.json");
    const lock = "lockfileVersion: '9.0'\n";
    const { runs, run } = recorder((_inv, cwd) =>
      writeFileSync(path.join(cwd, "pnpm-lock.yaml"), lock),
    );
    const logs = install([{ path: "templates/blog", lockfile: "none" }], run);
    expect(runs[0]?.line).toBe(
      "pnpm install --no-frozen-lockfile --ignore-scripts --config.package-manager-strict=false",
    );
    const sha = createHash("sha256").update(lock).digest("hex");
    expect(logs).toContain(
      `resolved lockfile for templates/blog: templates/blog/pnpm-lock.yaml sha256 ${sha}`,
    );
  });

  it("finds a lockfile written at the workspace root above the directory", () => {
    file("package.json");
    file("apps/web/package.json");
    const { run } = recorder((_inv) => writeFileSync(path.join(root, "bun.lock"), "{}"));
    const logs = install([{ path: "apps/web", packageManager: "bun", lockfile: "none" }], run);
    expect(logs.at(-1)).toMatch(/^resolved lockfile for apps\/web: bun\.lock sha256 [0-9a-f]{64}$/);
  });

  it("says so when a lockfile-less install wrote no lockfile", () => {
    file("site/package.json");
    const { run } = recorder();
    const logs = install([{ path: "site", packageManager: "npm", lockfile: "none" }], run);
    expect(logs.at(-1)).toBe("no lockfile written for site");
  });

  it("logs no hash for an install from a lockfile", () => {
    file("package.json");
    file("pnpm-lock.yaml");
    const { run } = recorder();
    const logs = install([{ path: "." }], run);
    expect(logs.some((l) => l.includes("sha256"))).toBe(false);
  });

  it("refuses lockfile none for a directory that ships a lockfile", () => {
    file("site/package.json");
    file("site/yarn.lock");
    const { runs, run } = recorder();
    expect(() => install([{ path: "site", lockfile: "none" }], run)).toThrow(
      /lockfile "none" for site, but it holds yarn\.lock/,
    );
    expect(runs).toEqual([]);
  });

  it("refuses a frozen install without a lockfile, which yarn and bun would run unpinned", () => {
    file("site/package.json");
    file("app/package.json");
    const { runs, run } = recorder();
    expect(() => install([{ path: "site", packageManager: "yarn" }], run)).toThrow(
      /^installing dependencies in site needs a lockfile, and there is no yarn\.lock in it or above it in the checkout/,
    );
    expect(() => install([{ path: "app", packageManager: "bun" }], run)).toThrow(
      /^installing dependencies in app needs a lockfile, and there is no bun\.lock or bun\.lockb in it/,
    );
    // Checked before any install runs, the root's included.
    file("pnpm-lock.yaml");
    expect(() => install([{ path: "." }, { path: "app", packageManager: "bun" }], run)).toThrow(
      InstallError,
    );
    expect(runs).toEqual([]);
  });

  it("takes a workspace's lockfile above the directory for a frozen install", () => {
    file("yarn.lock");
    file("packages/web/package.json");
    const { runs, run } = recorder();
    install([{ path: "packages/web", packageManager: "yarn" }], run);
    expect(runs).toEqual([
      { cwd: "packages/web", line: "yarn install --frozen-lockfile --ignore-scripts" },
    ]);
  });

  it("does not call a workspace lockfile the install left unchanged resolved", () => {
    file("pnpm-lock.yaml", "upstream\n");
    file("apps/web/package.json");
    const { run } = recorder();
    const logs = install([{ path: "apps/web", lockfile: "none" }], run);
    expect(logs.at(-1)).toBe(
      "no lockfile written for apps/web: pnpm-lock.yaml was already in the checkout, and the install left it unchanged",
    );
  });

  it("logs the hash of a workspace lockfile the install changed", () => {
    file("pnpm-lock.yaml", "upstream\n");
    file("apps/web/package.json");
    const changed = "upstream plus apps/web\n";
    const { run } = recorder(() => writeFileSync(path.join(root, "pnpm-lock.yaml"), changed));
    const logs = install([{ path: "apps/web", lockfile: "none" }], run);
    const sha = createHash("sha256").update(changed).digest("hex");
    expect(logs.at(-1)).toBe(
      `resolved lockfile for apps/web: pnpm-lock.yaml sha256 ${sha} (the install changed the checkout's own)`,
    );
  });

  it("refuses a path with .. before installing anything", () => {
    file("package.json");
    const { runs, run } = recorder();
    expect(() => install([{ path: "." }, { path: "../outside" }], run)).toThrow(InstallError);
    expect(() => install([{ path: "a/../../outside" }], run)).toThrow(
      /contains \.\.; an install directory must stay inside the checkout/,
    );
    // Every directory is checked first: not even the root was installed.
    expect(runs).toEqual([]);
  });

  it("refuses a directory that does not exist, or that a symlink leads out of", () => {
    const outside = mkdtempSync(path.join(tmpdir(), "appflare-outside-"));
    try {
      symlinkSync(outside, path.join(root, "escape"));
      expect(() => resolveInstallDir(root, "missing")).toThrow(/not a directory of the checkout/);
      expect(() => resolveInstallDir(root, "escape")).toThrow(
        /a symlink leads out of the checkout/,
      );
      expect(() => resolveInstallDir(root, "/etc")).toThrow(/is absolute/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("stops at the first directory whose install fails", () => {
    file("a/package.json");
    file("a/pnpm-lock.yaml");
    file("b/package.json");
    file("b/pnpm-lock.yaml");
    const cwds: string[] = [];
    const run: InstallRunner = (_inv, cwd) => {
      cwds.push(path.relative(root, cwd));
      return { status: 1, stdout: "", stderr: "ERR_PNPM_NO_LOCKFILE" };
    };
    expect(() => install([{ path: "a" }, { path: "b" }], run)).toThrow(
      /^installing dependencies in a failed: pnpm install --frozen-lockfile .* exited with 1:[\s\S]*ERR_PNPM_NO_LOCKFILE/,
    );
    expect(cwds).toEqual(["a"]);
  });

  it("spawns the package manager in the directory with scripts disabled", () => {
    file("site/package.json");
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    const seen = path.join(root, "seen.json");
    writeFileSync(
      path.join(bin, "yarn"),
      `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(seen)}, JSON.stringify({
  cwd: process.cwd(),
  args: process.argv.slice(2),
  scripts: process.env.YARN_ENABLE_SCRIPTS,
}));
writeFileSync("yarn.lock", "# yarn lockfile v1\\n");
`,
    );
    chmodSync(path.join(bin, "yarn"), 0o755);
    const logs: string[] = [];
    installDependencies({
      checkoutDir: root,
      installDirs: [{ path: "site", packageManager: "yarn", lockfile: "none" }],
      packageManager: "pnpm",
      env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
      logger: (m) => logs.push(m),
    });
    const ran = JSON.parse(readFileSync(seen, "utf8")) as Record<string, unknown>;
    expect(ran).toEqual({
      cwd: realpathSync(path.join(root, "site")),
      args: ["install", "--ignore-scripts"],
      scripts: "false",
    });
    expect(findLockfile(root, path.join(root, "site"), "yarn")).toBe(
      path.join(root, "site", "yarn.lock"),
    );
    expect(logs.at(-1)).toMatch(/^resolved lockfile for site: site\/yarn\.lock sha256 /);
  });
});
