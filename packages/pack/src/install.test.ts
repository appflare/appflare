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
  isNewerNpmLockfileFailure,
  lowestRangeMajor,
  NPM_11_SPEC,
  newerNpmLockfileFailure,
  nodeMajorOf,
  npmSpec,
  PNPM_9_SPEC,
  packageManagerFlavor,
  packageManagerMajor,
  pnpmLockfileMajor,
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

describe("yarn 2 and later", () => {
  it("runs corepack's yarn with Berry's flags, frozen and not", () => {
    const frozen = installInvocation("yarn", "required", { yarnBerry: true });
    expect([frozen.command, ...frozen.args].join(" ")).toBe(
      "corepack yarn install --immutable --mode=skip-build",
    );
    expect(frozen.env).toEqual({
      YARN_ENABLE_SCRIPTS: "false",
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    });
    const resolving = installInvocation("yarn", "none", { yarnBerry: true });
    expect([resolving.command, ...resolving.args].join(" ")).toBe(
      "corepack yarn install --mode=skip-build",
    );
    expect(resolving.env).toEqual({
      YARN_ENABLE_SCRIPTS: "false",
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
      YARN_ENABLE_IMMUTABLE_INSTALLS: "false",
    });
  });

  it("is detected from the nearest packageManager pin", () => {
    file("package.json", JSON.stringify({ packageManager: "yarn@4.5.1+sha512.abc" }));
    file("web/package.json", "{}");
    file(".yarnrc.yml", "nodeLinker: node-modules\n");
    expect(packageManagerFlavor(root, path.join(root, "web"), "yarn")).toEqual({
      yarnBerry: true,
    });
    file("web/package.json", JSON.stringify({ packageManager: "yarn@1.22.22" }));
    expect(packageManagerFlavor(root, path.join(root, "web"), "yarn")).toEqual({});

    rmSync(path.join(root, "package.json"));
    rmSync(path.join(root, "web/package.json"));
    rmSync(path.join(root, ".yarnrc.yml"));
    expect(packageManagerFlavor(root, path.join(root, "web"), "yarn")).toEqual({});
  });

  it("refuses a .yarnrc.yml without a packageManager pin, running nothing", () => {
    file("web/.yarnrc.yml", "nodeLinker: node-modules\n");
    file("web/package.json", "{}");
    file("web/yarn.lock", "");
    expect(() => packageManagerFlavor(root, path.join(root, "web"), "yarn")).toThrow(InstallError);
    const { runs, run } = recorder();
    expect(() => install([{ path: "web" }], run, "yarn")).toThrow(
      /^web\/\.yarnrc\.yml marks a yarn 2 or later project, but no package\.json at or above the directory pins its yarn \("packageManager": "yarn@4\.x\.y"\); without the pin corepack would run classic yarn, which would run install scripts/,
    );
    expect(runs).toEqual([]);
  });

  it("keeps classic yarn's flags for a checkout that pins yarn 1", () => {
    file("package.json", JSON.stringify({ packageManager: "yarn@1.22.22+sha512.abc" }));
    file("yarn.lock", "");
    const { runs, run } = recorder();
    install([{ path: "." }], run, "yarn");
    expect(runs).toEqual([{ cwd: ".", line: "yarn install --frozen-lockfile --ignore-scripts" }]);
  });

  it("installs a Berry checkout through corepack and says so", () => {
    file("package.json", JSON.stringify({ packageManager: "yarn@4.9.1" }));
    file("yarn.lock", "");
    const { runs, run } = recorder();
    const logs = install([{ path: "." }], run, "yarn");
    expect(runs).toEqual([
      { cwd: ".", line: "corepack yarn install --immutable --mode=skip-build" },
    ]);
    expect(logs[0]).toBe(
      "installing dependencies in . with yarn 2 or later: corepack yarn install --immutable --mode=skip-build",
    );
  });

  it("says how to get corepack when it cannot run", () => {
    file("package.json", JSON.stringify({ packageManager: "yarn@4.9.1" }));
    file("yarn.lock", "");
    const missing: InstallRunner = () => ({
      error: new Error("spawnSync corepack ENOENT"),
      status: null,
      stdout: "",
      stderr: "",
    });
    expect(() => install([{ path: "." }], missing, "yarn")).toThrow(
      /could not run corepack: spawnSync corepack ENOENT; yarn 2 and later install through corepack/,
    );
  });
});

describe("the npm version", () => {
  it("reads the major of a packageManager field for the named manager only", () => {
    expect(packageManagerMajor("npm@11.6.2", "npm")).toBe(11);
    expect(packageManagerMajor("yarn@4.5.1+sha512.abc", "yarn")).toBe(4);
    expect(packageManagerMajor("pnpm@10.0.0", "npm")).toBeNull();
    expect(packageManagerMajor(undefined, "npm")).toBeNull();
  });

  it("takes the lowest major a range allows", () => {
    expect(lowestRangeMajor(">=11")).toBe(11);
    expect(lowestRangeMajor("^11.3.0")).toBe(11);
    expect(lowestRangeMajor("10.x || 11.x")).toBe(10);
    expect(lowestRangeMajor("*")).toBeNull();
    expect(lowestRangeMajor(11)).toBeNull();
  });

  it("pins a later npm from packageManager, else engines.npm, and never npm 10 or earlier", () => {
    file("package.json", JSON.stringify({ packageManager: "npm@11.6.2" }));
    expect(packageManagerFlavor(root, root, "npm")).toEqual({ npmMajor: 11 });
    file("package.json", JSON.stringify({ engines: { node: ">=22", npm: ">=11.0.0" } }));
    expect(packageManagerFlavor(root, root, "npm")).toEqual({ npmMajor: 11 });
    file("package.json", JSON.stringify({ engines: { npm: ">=10" } }));
    expect(packageManagerFlavor(root, root, "npm")).toEqual({});
    file(
      "package.json",
      JSON.stringify({ packageManager: "npm@10.9.2", engines: { npm: ">=11" } }),
    );
    expect(packageManagerFlavor(root, root, "npm")).toEqual({});
    file("package.json", "not json");
    expect(packageManagerFlavor(root, root, "npm")).toEqual({});
  });

  it("runs a pinned npm through npx", () => {
    const inv = installInvocation("npm", "required", { npmMajor: 11 });
    expect([inv.command, ...inv.args].join(" ")).toBe("npx --yes npm@11.20.0 ci --ignore-scripts");
    file("package.json", JSON.stringify({ packageManager: "npm@11.6.2" }));
    file("package-lock.json", JSON.stringify({ lockfileVersion: 3 }));
    const { runs, run } = recorder();
    const logs = install([{ path: "." }], run, "npm");
    expect(runs).toEqual([{ cwd: ".", line: "npx --yes npm@11.20.0 ci --ignore-scripts" }]);
    expect(logs[0]).toMatch(/^installing dependencies in \. with npm 11: npx/);
  });

  const OUT_OF_SYNC =
    "npm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync. Please update your lock file with `npm install` before continuing.\nnpm error\nnpm error Missing: esbuild@0.28.2 from lock file\n";

  /** A runner whose npm 10 refuses the lockfile and whose later npm installs it. */
  function npm10(stderr = OUT_OF_SYNC): { runs: string[]; run: InstallRunner } {
    const runs: string[] = [];
    return {
      runs,
      run: (invocation) => {
        runs.push([invocation.command, ...invocation.args].join(" "));
        return invocation.command === "npm"
          ? { status: 1, stdout: "", stderr }
          : { status: 0, stdout: "", stderr: "" };
      },
    };
  }

  it("retries with npm 11 when npm 10 refuses a lockfileVersion 3 lockfile as out of sync", () => {
    file("package.json");
    file("package-lock.json", JSON.stringify({ lockfileVersion: 3 }));
    const { runs, run } = npm10();
    const logs = install([{ path: "." }], run, "npm");
    expect(runs).toEqual(["npm ci --ignore-scripts", "npx --yes npm@11.20.0 ci --ignore-scripts"]);
    expect(logs[1]).toMatch(
      /^npm ci --ignore-scripts refused package-lock\.json \(lockfileVersion 3\) as out of sync.*installing with npm 11: npx --yes npm@11\.20\.0 ci --ignore-scripts$/,
    );
  });

  it("does not retry another failure, an older lockfile, or a pinned npm", () => {
    file("package.json");
    file("package-lock.json", JSON.stringify({ lockfileVersion: 2 }));
    const older = npm10();
    expect(() => install([{ path: "." }], older.run, "npm")).toThrow(/exited with 1/);
    expect(older.runs).toEqual(["npm ci --ignore-scripts"]);

    file("package-lock.json", JSON.stringify({ lockfileVersion: 3 }));
    const other = npm10("npm error code E404\nnpm error 404 Not Found - GET https://registry\n");
    expect(() => install([{ path: "." }], other.run, "npm")).toThrow(/E404/);
    expect(other.runs).toEqual(["npm ci --ignore-scripts"]);

    file("package.json", JSON.stringify({ packageManager: "npm@12.0.0" }));
    const failing: InstallRunner = () => ({ status: 1, stdout: "", stderr: OUT_OF_SYNC });
    expect(() => install([{ path: "." }], failing, "npm")).toThrow(
      /npx --yes npm@12 ci --ignore-scripts exited with 1/,
    );
  });

  it("reports the npm 11 failure when the retry fails too", () => {
    file("package.json");
    file("package-lock.json", JSON.stringify({ lockfileVersion: 3 }));
    const failing: InstallRunner = () => ({ status: 1, stdout: "", stderr: OUT_OF_SYNC });
    expect(() => install([{ path: "." }], failing, "npm")).toThrow(
      /npx --yes npm@11.20.0 ci --ignore-scripts exited with 1/,
    );
  });

  it("recognises the failure only for package-lock.json of lockfileVersion 3", () => {
    file("package-lock.json", JSON.stringify({ lockfileVersion: 3 }));
    file("npm-shrinkwrap.json", JSON.stringify({ lockfileVersion: 3 }));
    expect(isNewerNpmLockfileFailure(path.join(root, "package-lock.json"), OUT_OF_SYNC)).toBe(true);
    expect(isNewerNpmLockfileFailure(path.join(root, "npm-shrinkwrap.json"), OUT_OF_SYNC)).toBe(
      false,
    );
    expect(isNewerNpmLockfileFailure(path.join(root, "package-lock.json"), "E404")).toBe(false);
    expect(isNewerNpmLockfileFailure(null, OUT_OF_SYNC)).toBe(false);
  });
});

describe("the pinned npm 11", () => {
  it("is exact, and is what the sandbox image warms npx's cache with", () => {
    expect(NPM_11_SPEC).toMatch(/^npm@11\.\d+\.\d+$/);
    expect(npmSpec(11)).toBe(NPM_11_SPEC);
    expect(npmSpec(12)).toBe("npm@12");
    const dockerfile = readFileSync(
      path.resolve(import.meta.dirname, "..", "..", "..", "apps", "sandbox", "Dockerfile"),
      "utf8",
    );
    expect(dockerfile).toContain(`RUN npx --yes ${NPM_11_SPEC} --version`);
  });
});

describe("installs without devDependencies", () => {
  it("adds each manager's production flag and keeps the install frozen", () => {
    const lines = (["pnpm", "npm", "yarn", "bun"] as const).map((pm) => {
      const inv = installInvocation(pm, "required", {}, { production: true });
      return [inv.command, ...inv.args].join(" ");
    });
    expect(lines).toEqual([
      "pnpm install --frozen-lockfile --prod --ignore-scripts --config.package-manager-strict=false",
      "npm ci --ignore-scripts --omit=dev",
      "yarn install --frozen-lockfile --ignore-scripts --production",
      "bun install --frozen-lockfile --ignore-scripts --production",
    ]);
  });

  it("installs a directory that sets devDependencies false without them, and says so", () => {
    file("package.json");
    file("package-lock.json", JSON.stringify({ lockfileVersion: 3 }));
    const { runs, run } = recorder();
    const logs = install([{ path: ".", devDependencies: false }], run, "npm");
    expect(runs).toEqual([{ cwd: ".", line: "npm ci --ignore-scripts --omit=dev" }]);
    expect(logs[0]).toMatch(/, without devDependencies: npm ci/);
  });

  it("refuses it for yarn 2 and later, which have no frozen production install", () => {
    file("package.json", JSON.stringify({ packageManager: "yarn@4.5.0" }));
    file("yarn.lock", "");
    const { runs, run } = recorder();
    expect(() => install([{ path: ".", devDependencies: false }], run, "yarn")).toThrow(
      /devDependencies false for \., but it is a yarn 2 or later project/,
    );
    expect(runs).toEqual([]);
  });
});

describe("pnpm 9 for a lockfileVersion 6 lockfile", () => {
  it("reads the lockfile's major", () => {
    file("pnpm-lock.yaml", "lockfileVersion: '6.0'\n\nsettings:\n");
    expect(pnpmLockfileMajor(path.join(root, "pnpm-lock.yaml"))).toBe(6);
    file("pnpm-lock.yaml", 'lockfileVersion: "9.0"\n');
    expect(pnpmLockfileMajor(path.join(root, "pnpm-lock.yaml"))).toBe(9);
    file("pnpm-lock.yaml", "packages: {}\n");
    expect(pnpmLockfileMajor(path.join(root, "pnpm-lock.yaml"))).toBeNull();
  });

  it("installs with the pinned pnpm 9 through npx, and a 9.0 lockfile with the machine's pnpm", () => {
    file("package.json");
    file("pnpm-lock.yaml", "lockfileVersion: '6.0'\n");
    const old = recorder();
    const logs = install([{ path: "." }], old.run, "pnpm");
    expect(old.runs).toEqual([
      {
        cwd: ".",
        line: `npx --yes ${PNPM_9_SPEC} install --frozen-lockfile --ignore-scripts --config.package-manager-strict=false`,
      },
    ]);
    expect(logs[0]).toMatch(
      /with pnpm 9 \(the lockfile is lockfileVersion 6, which pnpm 10 refuses\)/,
    );
    file("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    const current = recorder();
    install([{ path: "." }], current.run, "pnpm");
    expect(current.runs[0]?.line).toMatch(/^pnpm install --frozen-lockfile/);
  });

  it("is pinned exactly, and the sandbox image warms npx's cache with it", () => {
    expect(PNPM_9_SPEC).toMatch(/^pnpm@9\.\d+\.\d+$/);
    const dockerfile = readFileSync(
      path.resolve(import.meta.dirname, "..", "..", "..", "apps", "sandbox", "Dockerfile"),
      "utf8",
    );
    expect(dockerfile).toContain(`RUN npx --yes ${PNPM_9_SPEC} --version`);
  });
});

describe("npm 11 from the Node.js the checkout asks for, and on ERESOLVE", () => {
  it("reads .nvmrc, else engines.node, nearest first", () => {
    file(".nvmrc", "v24.1.0\n");
    expect(nodeMajorOf([root])).toBe(24);
    file(".nvmrc", "lts/*\n");
    file("package.json", JSON.stringify({ engines: { node: ">=20" } }));
    expect(nodeMajorOf([root])).toBe(20);
    file("app/.nvmrc", "24");
    expect(nodeMajorOf([path.join(root, "app"), root])).toBe(24);
  });

  it("installs with npm 11 for Node.js 24 or later, unless package.json names an npm", () => {
    file(".nvmrc", "24\n");
    file("package.json");
    file("package-lock.json", JSON.stringify({ lockfileVersion: 3 }));
    expect(packageManagerFlavor(root, root, "npm")).toEqual({ npmMajor: 11, nodeMajor: 24 });
    const { runs, run } = recorder();
    const logs = install([{ path: "." }], run, "npm");
    expect(runs[0]?.line).toBe("npx --yes npm@11.20.0 ci --ignore-scripts");
    expect(logs[0]).toMatch(
      /with npm 11 \(the checkout asks for Node\.js 24, which ships npm 11\)/,
    );
    file(".nvmrc", "22\n");
    expect(packageManagerFlavor(root, root, "npm")).toEqual({});
    file(".nvmrc", "24\n");
    file("package.json", JSON.stringify({ packageManager: "npm@10.9.2" }));
    expect(packageManagerFlavor(root, root, "npm")).toEqual({});
  });

  const ERESOLVE =
    "npm error code ERESOLVE\nnpm error ERESOLVE could not resolve\nnpm error\nnpm error While resolving: wrangler@4.131.0\n";

  it("retries with npm 11 when npm 10 cannot resolve a lockfileVersion 3 lockfile's peers", () => {
    file("package.json");
    file("package-lock.json", JSON.stringify({ lockfileVersion: 3 }));
    expect(newerNpmLockfileFailure(path.join(root, "package-lock.json"), ERESOLVE)).toBe(
      "eresolve",
    );
    const runs: string[] = [];
    const run: InstallRunner = (invocation) => {
      runs.push([invocation.command, ...invocation.args].join(" "));
      return invocation.command === "npm"
        ? { status: 1, stdout: "", stderr: ERESOLVE }
        : { status: 0, stdout: "", stderr: "" };
    };
    const logs = install([{ path: "." }], run, "npm");
    expect(runs).toEqual(["npm ci --ignore-scripts", "npx --yes npm@11.20.0 ci --ignore-scripts"]);
    expect(logs[1]).toMatch(
      /could not resolve the peer dependencies of package-lock\.json \(lockfileVersion 3, ERESOLVE\).*installing with npm 11/,
    );
    file("package-lock.json", JSON.stringify({ lockfileVersion: 2 }));
    expect(newerNpmLockfileFailure(path.join(root, "package-lock.json"), ERESOLVE)).toBeNull();
  });
});
