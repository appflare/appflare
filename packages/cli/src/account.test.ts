import { describe, expect, it } from "vitest";
import { chooseAccount, ensureAccount, parseWhoami } from "./account.ts";
import { fakeSpawner, fakeUi, LOGGED_IN } from "./test-fixtures.ts";
import { createWrangler } from "./wrangler.ts";

const acme = { id: "acc-1", name: "Acme" };
const other = { id: "acc-2", name: "Other" };

describe("parseWhoami", () => {
  it("parses both states", () => {
    expect(parseWhoami('{"loggedIn":false}')).toEqual({ loggedIn: false });
    expect(parseWhoami(LOGGED_IN)).toEqual({ loggedIn: true, accounts: [acme] });
  });
});

describe("chooseAccount", () => {
  it("uses the only account", () => {
    expect(chooseAccount([acme], { yes: false })).toEqual({ kind: "chosen", account: acme });
  });
  it("uses CLOUDFLARE_ACCOUNT_ID when it is visible", () => {
    expect(chooseAccount([acme, other], { envAccountId: "acc-2", yes: true })).toEqual({
      kind: "chosen",
      account: other,
    });
  });
  it("rejects a CLOUDFLARE_ACCOUNT_ID that is not visible", () => {
    expect(() => chooseAccount([acme], { envAccountId: "acc-9", yes: false })).toThrow("acc-9");
  });
  it("asks with several accounts, and refuses with --yes", () => {
    expect(chooseAccount([acme, other], { yes: false })).toEqual({
      kind: "ask",
      accounts: [acme, other],
    });
    expect(() => chooseAccount([acme, other], { yes: true })).toThrow("Set CLOUDFLARE_ACCOUNT_ID");
  });
  it("fails without accounts", () => {
    expect(() => chooseAccount([], { yes: false })).toThrow("no Cloudflare account");
  });
});

describe("ensureAccount", () => {
  const wranglerWith = (spawner: ReturnType<typeof fakeSpawner>["spawner"]) =>
    createWrangler({
      cwd: "/w",
      configPath: "/w/wrangler.json",
      env: {},
      spawner,
      bin: "/fake/wrangler.js",
    });

  it("logs in when needed, then binds the chosen account", async () => {
    let loggedIn = false;
    const { spawner, calls } = fakeSpawner({
      whoami: () => (loggedIn ? { stdout: LOGGED_IN } : { code: 1, stdout: '{"loggedIn":false}' }),
      login: () => {
        loggedIn = true;
        return {};
      },
    });
    const wrangler = wranglerWith(spawner);
    const { ui } = fakeUi({ interactive: true });
    await ensureAccount(wrangler, ui, { env: {}, yes: false });
    expect(calls.map((c) => c.args[0])).toEqual(["whoami", "login", "whoami"]);
    expect(calls[1]?.stdin).toEqual({ kind: "inherit" });
    expect(wrangler.accountId).toBe("acc-1");
  });

  it("prompts for one of several accounts", async () => {
    const both = JSON.stringify({ loggedIn: true, accounts: [acme, other] });
    const { spawner } = fakeSpawner({ whoami: () => ({ stdout: both }) });
    const wrangler = wranglerWith(spawner);
    const { ui } = fakeUi({ interactive: true, answers: ["acc-2"] });
    expect(await ensureAccount(wrangler, ui, { env: {}, yes: false })).toEqual(other);
    expect(wrangler.accountId).toBe("acc-2");
  });

  it("does not try an OAuth login when a token is set", async () => {
    const { spawner } = fakeSpawner({ whoami: () => ({ code: 1, stdout: '{"loggedIn":false}' }) });
    await expect(
      ensureAccount(wranglerWith(spawner), fakeUi({ interactive: true }).ui, {
        env: { CLOUDFLARE_API_TOKEN: "x" },
        yes: false,
      }),
    ).rejects.toThrow("CLOUDFLARE_API_TOKEN is set");
  });

  it("reports other whoami failures as wrangler errors", async () => {
    const { spawner } = fakeSpawner({ whoami: () => ({ code: 1, stderr: "network down" }) });
    await expect(
      ensureAccount(wranglerWith(spawner), fakeUi().ui, { env: {}, yes: false }),
    ).rejects.toThrow("network down");
  });
});
