import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { selfUnits } from "./client";

/**
 * The real `SELF` service binding: wrangler.jsonc binds the manager to its own
 * `JobUnits` entrypoint, and the test pool points that binding at the test
 * Worker (src/test/entry.ts exports the class). A call crosses a real RPC
 * boundary and runs in its own invocation.
 *
 * No unit can succeed here: every one calls the Cloudflare API with the API
 * token from the callee's own env, the test Worker has none (the Workflow
 * engine test relies on that), and the test pool offers no way to answer the
 * callee's outbound fetches, so a successful call would reach the real
 * internet. These tests cover the RPC boundary (results and failures as plain
 * data, validation on arrival); the job tests cover the units' work with a
 * fake `SELF` against a fake Cloudflare API.
 */

const self = selfUnits(env);

describe("JobUnits over the SELF binding", () => {
  it("is bound", () => {
    expect(self).toBeDefined();
  });

  it("returns a failure as plain data across the call, with the API token read from its own env", async () => {
    expect(env.CF_API_TOKEN).toBeUndefined();
    const result = await self?.emptyR2Page({
      accountId: "acc0000000000000000000000000000a",
      bucket: "cut-files",
      name: "cut-files",
      perPage: 36,
      previousFirst: null,
    });
    expect(result).toEqual({
      ok: false,
      failure: {
        kind: "final",
        message: "the Cloudflare API token is not configured; finish setup first",
      },
      log: { lines: [], requests: [] },
      subrequests: 0,
    });
  });

  it("validates its input on arrival", async () => {
    const result = await self?.emptyR2Page({
      accountId: "acc0000000000000000000000000000a",
      bucket: "cut-files",
      name: "cut-files",
      // More than one invocation's subrequests could delete.
      perPage: 1000,
      previousFirst: null,
    });
    expect(result).toMatchObject({
      ok: false,
      failure: {
        kind: "final",
        message: expect.stringMatching(/^the running version of Appflare cannot run emptyR2Page/),
      },
    });
  });
});
