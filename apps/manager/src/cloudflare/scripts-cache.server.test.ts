import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { jobCreator } from "../jobs/create-job.server";
import { JOB_HANDLERS, runJob } from "../jobs/run-job";
import { fakeStep } from "../test/fake-step";
import {
  cachedScriptNames,
  invalidateScriptsCache,
  SCRIPTS_CACHE_MS,
} from "./scripts-cache.server";

/** A listing that counts how often it ran and answers `names`. */
function listing(names: string[]) {
  let calls = 0;
  return {
    load: async () => {
      calls += 1;
      return names;
    },
    calls: () => calls,
  };
}

const T = 1_000_000;

beforeEach(() => invalidateScriptsCache());

describe("the account's Worker names", () => {
  it("are listed once a minute per account", async () => {
    const a = listing(["cut", "blog"]);
    expect(await cachedScriptNames("acc-a", a.load, T)).toEqual(["cut", "blog"]);
    expect(await cachedScriptNames("acc-a", a.load, T + SCRIPTS_CACHE_MS - 1)).toEqual([
      "cut",
      "blog",
    ]);
    expect(a.calls()).toBe(1);
    await cachedScriptNames("acc-a", a.load, T + SCRIPTS_CACHE_MS);
    expect(a.calls()).toBe(2);
    // Another account is listed on its own.
    const b = listing(["other"]);
    expect(await cachedScriptNames("acc-b", b.load, T)).toEqual(["other"]);
    expect(b.calls()).toBe(1);
  });

  it("are listed again after an invalidation", async () => {
    const a = listing(["cut"]);
    await cachedScriptNames("acc-a", a.load, T);
    invalidateScriptsCache();
    await cachedScriptNames("acc-a", a.load, T + 1);
    expect(a.calls()).toBe(2);
  });

  it("keep no listing that was under way when they were invalidated", async () => {
    let release: (names: string[]) => void = () => {};
    const slow = cachedScriptNames(
      "acc-a",
      () => new Promise<string[]>((resolve) => (release = resolve)),
      T,
    );
    invalidateScriptsCache();
    release(["before-the-job"]);
    expect(await slow).toEqual(["before-the-job"]);
    const a = listing(["after-the-job"]);
    expect(await cachedScriptNames("acc-a", a.load, T + 1)).toEqual(["after-the-job"]);
  });

  it("keep no failed listing", async () => {
    await expect(
      cachedScriptNames("acc-a", () => Promise.reject(new Error("API down")), T),
    ).rejects.toThrow("API down");
    const a = listing(["cut"]);
    await cachedScriptNames("acc-a", a.load, T + 1);
    expect(a.calls()).toBe(1);
  });

  it("are dropped when a job starts here", async () => {
    const a = listing(["cut"]);
    await cachedScriptNames("acc-a", a.load, T);
    const created: string[] = [];
    const create = jobCreator({
      create: async ({ id }) => {
        created.push(id);
        return { id };
      },
    });
    await create("job1", { kind: "install", jobId: "job1" });
    expect(created).toEqual(["job1"]);
    await cachedScriptNames("acc-a", a.load, T + 1);
    expect(a.calls()).toBe(2);
  });

  it("are dropped when a job runs and when it ends", async () => {
    await reset();
    await createMigrator(migrations).ensure(env.DB);
    const a = listing(["cut"]);
    const seen: number[] = [];
    await cachedScriptNames("acc-a", a.load, T);
    await runJob({ kind: "uninstall", jobId: "job1" }, fakeStep(), env, {
      ...JOB_HANDLERS,
      uninstall: async () => {
        // Dropped as the job starts: the page lists the account again.
        await cachedScriptNames("acc-a", a.load, T + 1);
        seen.push(a.calls());
      },
    });
    expect(seen).toEqual([2]);
    // And again when it ended.
    await cachedScriptNames("acc-a", a.load, T + 2);
    expect(a.calls()).toBe(3);
  });
});
