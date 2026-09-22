import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { scrubEnv } from "./scrub-env.ts";

/** Names of every env var a real child process sees when spawned with `env`. */
function childEnvNames(env: NodeJS.ProcessEnv): string[] {
  const res = spawnSync(
    process.execPath,
    ["-e", 'process.stdout.write(Object.keys(process.env).join(","))'],
    { env, encoding: "utf8" },
  );
  expect(res.status, res.stderr).toBe(0);
  return res.stdout.split(",");
}

describe("scrubEnv", () => {
  it("keeps credentials out of spawned children but passes unrelated vars through", () => {
    const secret = "do-not-leak";
    const base: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      UNRELATED_VAR: "keep-me",
      MY_CUSTOM_KEY_VAR: secret, // the --sign-key-env name, arbitrary on purpose
      CATALOG_SIGNING_KEY: secret,
      APPFLARE_TEST_SIGN_KEY: secret,
      GITHUB_TOKEN: secret,
      GH_TOKEN: secret,
      NPM_TOKEN: secret,
      NODE_AUTH_TOKEN: secret,
      CLOUDFLARE_API_TOKEN: secret,
      CLOUDFLARE_ACCOUNT_ID: secret,
      WRANGLER_LOG: "debug",
    };

    const names = childEnvNames(scrubEnv(base, ["MY_CUSTOM_KEY_VAR"]));

    for (const leaked of [
      "MY_CUSTOM_KEY_VAR",
      "CATALOG_SIGNING_KEY",
      "APPFLARE_TEST_SIGN_KEY",
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "NPM_TOKEN",
      "NODE_AUTH_TOKEN",
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_ACCOUNT_ID",
      "WRANGLER_LOG",
    ]) {
      expect(names).not.toContain(leaked);
    }
    expect(names).toContain("UNRELATED_VAR");
    expect(names).toContain("PATH");
    // Only the packer's own safe settings are re-added.
    expect(names).toContain("WRANGLER_SEND_METRICS");
  });

  it("drops the named key variable even when it matches no pattern", () => {
    const out = scrubEnv({ KEY_MATERIAL: "x", OTHER: "y" }, ["KEY_MATERIAL"]);
    expect(out.KEY_MATERIAL).toBeUndefined();
    expect(out.OTHER).toBe("y");
  });
});
