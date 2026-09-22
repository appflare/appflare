import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import { hasDevContext, loadDevContext } from "./dev";

const WORKSPACE = 'packages:\n  - "packages/*"\n';
const originalCwd = process.cwd();
let tempRoots: string[] = [];

afterEach(() => {
  process.chdir(originalCwd);
  for (const dir of tempRoots) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempRoots = [];
});

/** Creates a throwaway workspace (with pnpm-workspace.yaml) and returns a nested cwd. */
function tempWorkspace(envContent: string | undefined): string {
  const root = mkdtempSync(join(tmpdir(), "cf-api-dev-"));
  tempRoots.push(root);
  writeFileSync(join(root, "pnpm-workspace.yaml"), WORKSPACE);
  if (envContent !== undefined) {
    writeFileSync(join(root, ".env"), envContent);
  }
  const nested = join(root, "packages", "cf-api");
  mkdirSync(nested, { recursive: true });
  return nested;
}

describe("loadDevContext", () => {
  it("reads the repo-root .env by walking up from a nested cwd", () => {
    process.chdir(
      tempWorkspace("CLOUDFLARE_ACCOUNT_ID=acc-from-file\nCLOUDFLARE_API_TOKEN=tok-from-file\n"),
    );
    expect(loadDevContext()).toEqual({ accountId: "acc-from-file", token: "tok-from-file" });
    expect(hasDevContext()).toBe(true);
  });

  it("does not fall back to ambient process.env", () => {
    const priorToken = process.env.CLOUDFLARE_API_TOKEN;
    process.env.CLOUDFLARE_API_TOKEN = "ambient-token-must-be-ignored";
    try {
      process.chdir(tempWorkspace("CLOUDFLARE_ACCOUNT_ID=acc-from-file\n"));
      const error = loadDevContext.bind(null);
      expect(error).toThrow(/CLOUDFLARE_API_TOKEN/);
      expect(hasDevContext()).toBe(false);
      try {
        loadDevContext();
      } catch (e) {
        expect((e as Error).message).not.toContain("ambient-token-must-be-ignored");
        expect((e as Error).message).not.toContain("acc-from-file");
      }
    } finally {
      if (priorToken === undefined) {
        delete process.env.CLOUDFLARE_API_TOKEN;
      } else {
        process.env.CLOUDFLARE_API_TOKEN = priorToken;
      }
    }
  });

  it("names a missing/empty variable without printing any value", () => {
    process.chdir(
      tempWorkspace("CLOUDFLARE_ACCOUNT_ID=\nCLOUDFLARE_API_TOKEN=secret-value-must-not-leak\n"),
    );
    try {
      loadDevContext();
      throw new Error("expected loadDevContext to throw");
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain("CLOUDFLARE_ACCOUNT_ID");
      expect(message).not.toContain("secret-value-must-not-leak");
    }
  });

  it("throws when the repo-root .env is absent", () => {
    process.chdir(tempWorkspace(undefined));
    expect(() => loadDevContext()).toThrow(/\.env/);
    expect(hasDevContext()).toBe(false);
  });
});
