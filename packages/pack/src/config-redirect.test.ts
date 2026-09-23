import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConfigRedirectError,
  DEPLOY_CONFIG_PATH,
  dryRunInvocation,
  readConfigArgs,
  resolveWranglerConfig,
} from "./config-redirect.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "appflare-redirect-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function redirect(dir: string, configPath: unknown): void {
  write(path.posix.join(dir, DEPLOY_CONFIG_PATH), JSON.stringify({ configPath }));
}

describe("resolveWranglerConfig", () => {
  it("builds from the declared config when the build left no redirect", () => {
    write("wrangler.jsonc", "{}");
    const target = resolveWranglerConfig(root, "wrangler.jsonc");
    expect(target).toEqual({
      declaredPath: path.join(root, "wrangler.jsonc"),
      effectivePath: path.join(root, "wrangler.jsonc"),
      deployConfigPath: null,
    });
    expect(dryRunInvocation(target, root)).toEqual({
      cwd: root,
      configArgs: ["--config", path.join(root, "wrangler.jsonc")],
    });
    expect(readConfigArgs(target)).toEqual({
      args: { config: path.join(root, "wrangler.jsonc") },
      options: {},
    });
  });

  it("follows a redirect beside the declared config, relative to the redirect's directory", () => {
    write("wrangler.jsonc", "{}");
    write("build/server/wrangler.json", "{}");
    redirect(".", "../../build/server/wrangler.json");
    const target = resolveWranglerConfig(root, "wrangler.jsonc");
    expect(target.effectivePath).toBe(path.join(root, "build/server/wrangler.json"));
    expect(target.deployConfigPath).toBe(path.join(root, DEPLOY_CONFIG_PATH));
    // wrangler reads a redirected config as one only without --config.
    expect(dryRunInvocation(target, root)).toEqual({ cwd: root, configArgs: [] });
    expect(readConfigArgs(target)).toEqual({
      args: { script: path.join(root, "wrangler.jsonc") },
      options: { useRedirectIfAvailable: true },
    });
  });

  it("looks beside a config in a subdirectory, not at the checkout root", () => {
    write("apps/web/wrangler.jsonc", "{}");
    write("apps/web/dist/web/wrangler.json", "{}");
    write("dist/other/wrangler.json", "{}");
    redirect(".", "../../dist/other/wrangler.json");
    redirect("apps/web", "../../dist/web/wrangler.json");
    const target = resolveWranglerConfig(root, "apps/web/wrangler.jsonc");
    expect(target.effectivePath).toBe(path.join(root, "apps/web/dist/web/wrangler.json"));
    expect(dryRunInvocation(target, root).cwd).toBe(path.join(root, "apps/web"));
  });

  it("ignores a redirect at the checkout root when the config lives elsewhere", () => {
    write("apps/web/wrangler.jsonc", "{}");
    write("dist/wrangler.json", "{}");
    redirect(".", "../../dist/wrangler.json");
    const target = resolveWranglerConfig(root, "apps/web/wrangler.jsonc");
    expect(target.deployConfigPath).toBeNull();
    expect(target.effectivePath).toBe(path.join(root, "apps/web/wrangler.jsonc"));
  });

  it("refuses a redirect wrangler would refuse", () => {
    write("wrangler.jsonc", "{}");
    write(DEPLOY_CONFIG_PATH, "not json");
    expect(() => resolveWranglerConfig(root, "wrangler.jsonc")).toThrow(ConfigRedirectError);
    expect(() => resolveWranglerConfig(root, "wrangler.jsonc")).toThrow(/is not JSON/);

    write(DEPLOY_CONFIG_PATH, JSON.stringify({ auxiliaryWorkers: [] }));
    expect(() => resolveWranglerConfig(root, "wrangler.jsonc")).toThrow(/no "configPath"/);

    redirect(".", "../../dist/missing.json");
    expect(() => resolveWranglerConfig(root, "wrangler.jsonc")).toThrow(
      /points at dist\/missing\.json, which does not exist/,
    );
  });

  it("refuses a redirect that leaves the checkout", () => {
    write("checkout/wrangler.jsonc", "{}");
    write("outside.json", "{}");
    redirect("checkout", "../../../outside.json");
    expect(() => resolveWranglerConfig(path.join(root, "checkout"), "wrangler.jsonc")).toThrow(
      /outside the checkout/,
    );
  });

  it("refuses a redirect that leaves the checkout through a symlink", () => {
    const checkout = path.join(root, "checkout");
    write("checkout/wrangler.jsonc", "{}");
    write("outside/wrangler.json", "{}");
    mkdirSync(path.join(checkout, "dist"), { recursive: true });
    // A linked file and a linked directory, both inside the checkout by path.
    symlinkSync(path.join(root, "outside/wrangler.json"), path.join(checkout, "dist/linked.json"));
    symlinkSync(path.join(root, "outside"), path.join(checkout, "dist/out"));
    redirect("checkout", "../../dist/linked.json");
    expect(() => resolveWranglerConfig(checkout, "wrangler.jsonc")).toThrow(/outside the checkout/);
    redirect("checkout", "../../dist/out/wrangler.json");
    expect(() => resolveWranglerConfig(checkout, "wrangler.jsonc")).toThrow(/outside the checkout/);
    // A link that stays inside the checkout is followed.
    write("checkout/build/wrangler.json", "{}");
    symlinkSync(path.join(checkout, "build"), path.join(checkout, "dist/build"));
    redirect("checkout", "../../dist/build/wrangler.json");
    expect(resolveWranglerConfig(checkout, "wrangler.jsonc").effectivePath).toBe(
      path.join(checkout, "dist/build/wrangler.json"),
    );
  });
});
