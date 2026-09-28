import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseJsonc } from "@appflare/pack";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findSecrets, parseDotenv, repoSecrets } from "./deploy-repo-guard.ts";
import { REPO_ROOT } from "./manager-release.ts";

// Made-up values in the shapes the guard looks for.
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const OTHER_ACCOUNT = "fedcba9876543210fedcba9876543210";
const TOKEN = "tok_abcdefghijklmnopqrstuvwxyz0123456789";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "deploy-repo-guard-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), content);
}

function git(...args: string[]): void {
  const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  expect(res.status, res.stderr).toBe(0);
}

describe("parseDotenv", () => {
  it("reads KEY=VALUE lines the way dotenv does", () => {
    expect(
      parseDotenv("# comment\n\nA=1\nexport B = \"two words\"\nC='three'\r\nnot a line\nD=x=y\n"),
    ).toEqual({ A: "1", B: "two words", C: "three", D: "x=y" });
  });
});

describe("repoSecrets", () => {
  it("collects tracked wrangler configs' account ids and long .env values", () => {
    git("init", "-q");
    write("apps/a/wrangler.jsonc", `{\n  // pinned\n  "account_id": "${ACCOUNT}",\n}\n`);
    write(
      "apps/b/wrangler.json",
      JSON.stringify({ name: "b", env: { staging: { account_id: OTHER_ACCOUNT } } }),
    );
    write("apps/c/wrangler.jsonc", '{ "account_id": "not-an-account-id" }');
    write("apps/untracked/wrangler.jsonc", '{ "account_id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }');
    write(".env", `CLOUDFLARE_API_TOKEN=${TOKEN}\nCLOUDFLARE_ACCOUNT_ID=${ACCOUNT}\nSHORT=true\n`);
    git("add", "apps/a", "apps/b", "apps/c");

    expect(repoSecrets(dir)).toEqual([
      { source: "the account_id in apps/a/wrangler.jsonc", value: ACCOUNT },
      { source: "the account_id in apps/b/wrangler.json", value: OTHER_ACCOUNT },
      { source: "the value of CLOUDFLARE_API_TOKEN in .env", value: TOKEN },
    ]);
  });

  it("refuses to run where git cannot list the configs", () => {
    expect(() => repoSecrets(dir)).toThrow(/could not list the wrangler configs/);
  });

  it("finds this repository's pinned account ids", () => {
    const pinned = (
      parseJsonc(
        readFileSync(path.join(REPO_ROOT, "apps", "manager", "wrangler.jsonc"), "utf8"),
      ) as {
        account_id?: string;
      }
    ).account_id;
    const secrets = repoSecrets(REPO_ROOT);
    // Compared as a boolean so a failure never prints the id.
    expect(typeof pinned === "string" && secrets.some((s) => s.value === pinned)).toBe(true);
    expect(
      secrets.every((s) =>
        /^the (account_id in \S+wrangler\.jsonc?|value of \w+ in \.env)$/.test(s.source),
      ),
    ).toBe(true);
  });
});

describe("findSecrets", () => {
  const secrets = [
    { source: "the account_id in apps/a/wrangler.jsonc", value: ACCOUNT },
    { source: "the value of CLOUDFLARE_API_TOKEN in .env", value: TOKEN },
  ];

  it("passes a copy without any of the values", () => {
    write("worker/index.js", "export default {};\n");
    write("README.md", "# Deploy Appflare\n");
    expect(findSecrets(dir, secrets)).toEqual([]);
  });

  it("names every file and the source of each value it contains, never the value", () => {
    write("worker/index.js", `const a = "${ACCOUNT.toUpperCase()}";\n`);
    write("assets/deep/app.js", `fetch("/x", { headers: { t: "${TOKEN}" } });\n`);
    write(".gitignore", `# ${ACCOUNT}\n`);
    const found = findSecrets(dir, secrets);
    expect(found.sort()).toEqual([
      ".gitignore contains the account_id in apps/a/wrangler.jsonc",
      "assets/deep/app.js contains the value of CLOUDFLARE_API_TOKEN in .env",
      "worker/index.js contains the account_id in apps/a/wrangler.jsonc",
    ]);
    for (const line of found) {
      expect(line).not.toContain(ACCOUNT);
      expect(line).not.toContain(TOKEN);
    }
  });
});
