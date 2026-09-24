import { NonRetryableError } from "cloudflare:workflows";
import { CloudflareApiError, createClient } from "@appflare/cf-api";
import { describe, expect, it } from "vitest";
import { type FakeRoute, fakeCloudflare } from "../../test/fake-cloudflare";
import { JobError, toStepError } from "../errors";
import {
  CRON_LIMIT_ERROR_CODE,
  countAccountCronTriggers,
  cronLimitError,
  cronLimitRefusal,
  isCronLimitError,
  putSchedulesChecked,
} from "./cron-limit";

const ACC = "acc0000000000000000000000000000a";
const A = `/accounts/${ACC}`;

/** Cloudflare's answer to `PUT .../schedules` on a free account at its limit (seen on 2026-09-24). */
const LIMIT_ERROR = {
  code: 10072,
  message:
    "This account has reached the Workers Free limit of 5 cron triggers per account. Upgrade to Workers Paid to increase this limit to 1,000: https://dash.cloudflare.com/<account>/workers/plans",
};

function client(routes: Record<string, FakeRoute>) {
  const api = fakeCloudflare(routes);
  return { api, cf: createClient({ accountId: ACC, token: "t", fetch: api.fetch }) };
}

const schedules = (...crons: string[]): FakeRoute => ({
  result: { schedules: crons.map((cron) => ({ cron })) },
});

describe("countAccountCronTriggers", () => {
  it("reads the schedules of the Workers with a scheduled handler, except the one being set", async () => {
    const { api, cf } = client({
      [`GET ${A}/workers/scripts`]: {
        result: [
          { id: "appflare", handlers: ["fetch", "scheduled"] },
          { id: "docs", handlers: ["fetch"] },
          { id: "second-brain", handlers: ["fetch", "scheduled"] },
          { id: "cut", handlers: ["fetch", "scheduled"] },
          { id: "old" },
        ],
      },
      [`GET ${A}/workers/scripts/appflare/schedules`]: schedules("*/30 * * * *"),
      [`GET ${A}/workers/scripts/second-brain/schedules`]: schedules("0 1 * * *", "0 2 * * *"),
      // Deleted between the list and the read: counts nothing.
      [`GET ${A}/workers/scripts/old/schedules`]: {
        status: 404,
        errors: [{ code: 10007, message: "This Worker does not exist on your account." }],
      },
    });
    expect(await countAccountCronTriggers(cf, { exclude: "cut", maxWorkers: 20 })).toEqual({
      kind: "counted",
      total: 3,
      byWorker: [
        { worker: "second-brain", count: 2 },
        { worker: "appflare", count: 1 },
      ],
      read: 3,
    });
    expect(api.keys()).toEqual([
      `GET ${A}/workers/scripts`,
      `GET ${A}/workers/scripts/appflare/schedules`,
      `GET ${A}/workers/scripts/second-brain/schedules`,
      `GET ${A}/workers/scripts/old/schedules`,
    ]);
  });

  it("skips an account with more scheduled Workers than it reads, after the one list call", async () => {
    const { api, cf } = client({
      [`GET ${A}/workers/scripts`]: {
        result: Array.from({ length: 21 }, (_, i) => ({ id: `w${i}`, handlers: ["scheduled"] })),
      },
    });
    expect(await countAccountCronTriggers(cf, { exclude: "cut", maxWorkers: 20 })).toEqual({
      kind: "skipped",
      reason:
        "the account has 21 Workers with scheduled handlers, more than the 20 this check reads",
    });
    expect(api.keys()).toEqual([`GET ${A}/workers/scripts`]);
  });

  it("passes on any other API error", async () => {
    const { cf } = client({
      [`GET ${A}/workers/scripts`]: { result: [{ id: "appflare", handlers: ["scheduled"] }] },
      [`GET ${A}/workers/scripts/appflare/schedules`]: {
        status: 403,
        errors: [{ code: 10000, message: "Authentication error" }],
      },
    });
    await expect(countAccountCronTriggers(cf, { exclude: "cut", maxWorkers: 20 })).rejects.toThrow(
      CloudflareApiError,
    );
  });
});

describe("cronLimitRefusal", () => {
  const others = (byWorker: Array<{ worker: string; count: number }>) => ({
    kind: "counted" as const,
    total: byWorker.reduce((n, w) => n + w.count, 0),
    byWorker,
    read: byWorker.length,
  });
  const check = { subject: "this app" };

  it("names the count, the Workers using it, and both ways out", () => {
    expect(
      cronLimitRefusal({
        ...check,
        others: others([
          { worker: "second-brain", count: 2 },
          { worker: "appflare", count: 1 },
          { worker: "flaremo", count: 1 },
        ]),
        wanted: 2,
      }),
    ).toBe(
      "this app needs 2 cron triggers and the account's other Workers already use 4 (second-brain: 2, appflare: 1, flaremo: 1); Workers Free allows 5 per account, so this would make 6. Remove a cron trigger from another Worker (for example by uninstalling an app that uses one), or upgrade the account to Workers Paid (1,000 per account). If it is already on Workers Paid, record that in Settings under Workers plan. Then try again.",
    );
    expect(cronLimitRefusal({ ...check, others: others([]), wanted: 7 })).toBe(
      "this app needs 7 cron triggers and the account's other Workers already use 0; Workers Free allows 5 per account, so this would make 7. Remove 2 cron triggers from other Workers (for example by uninstalling an app that uses them), or upgrade the account to Workers Paid (1,000 per account). If it is already on Workers Paid, record that in Settings under Workers plan. Then try again.",
    );
  });

  it("lets triggers that fit the free plan through, up to exactly 5", () => {
    expect(
      cronLimitRefusal({ ...check, others: others([{ worker: "appflare", count: 1 }]), wanted: 4 }),
    ).toBeNull();
  });

  it("does not refuse on an account that already has more than a free account can", () => {
    expect(
      cronLimitRefusal({ ...check, others: others([{ worker: "big", count: 6 }]), wanted: 3 }),
    ).toBeNull();
  });
});

describe("the cron limit refusal at the schedule call", () => {
  const refused = (status: number, errors: Array<{ code: number; message: string }>) =>
    new CloudflareApiError({
      status,
      method: "PUT",
      path: `${A}/workers/scripts/cut/schedules`,
      errors,
    });

  it("is recognised by its code or its message", () => {
    expect(CRON_LIMIT_ERROR_CODE).toBe(10072);
    expect(isCronLimitError(refused(400, [LIMIT_ERROR]))).toBe(true);
    expect(isCronLimitError(refused(400, [{ code: 10072, message: "too_many_crons" }]))).toBe(true);
    expect(
      isCronLimitError(
        refused(400, [
          { code: 1, message: "You have reached the limit of 5 cron triggers per account" },
        ]),
      ),
    ).toBe(true);
    expect(isCronLimitError(refused(400, [{ code: 10021, message: "invalid cron" }]))).toBe(false);
    expect(isCronLimitError(new Error("cron triggers per account"))).toBe(false);
  });

  it("becomes a readable job error that is never retried, whatever the status", () => {
    const error = cronLimitError(
      refused(400, [LIMIT_ERROR]),
      2,
      "The Worker keeps the cron triggers it had.",
    );
    expect(error).toBeInstanceOf(JobError);
    expect(error.message).toBe(
      "Cloudflare refused 2 cron triggers: this account has reached the Workers Free limit of 5 cron triggers per account. The Worker keeps the cron triggers it had. Remove a cron trigger from another Worker (for example by uninstalling an app that uses one), or upgrade the account to Workers Paid (1,000 per account), then try again.",
    );
    expect(toStepError(error)).toBeInstanceOf(NonRetryableError);
    // Even an answer that would otherwise be retried.
    expect(toStepError(cronLimitError(refused(429, [LIMIT_ERROR]), 1, ""))).toBeInstanceOf(
      NonRetryableError,
    );
  });

  it("does not offer Workers Paid when that is the limit reached", () => {
    const error = cronLimitError(
      refused(400, [
        {
          code: 10072,
          message: "This account has reached the limit of 1,000 cron triggers per account.",
        },
      ]),
      1,
      "The Worker keeps the cron triggers it had.",
    );
    expect(error.message).toBe(
      "Cloudflare refused 1 cron trigger: this account has reached its limit of 1,000 cron triggers per account. The Worker keeps the cron triggers it had. Remove a cron trigger from another Worker (for example by uninstalling an app that uses one), then try again.",
    );
  });

  it("maps the refusal of a schedule call and passes other errors on", async () => {
    const limited = client({
      [`PUT ${A}/workers/scripts/cut/schedules`]: { status: 400, errors: [LIMIT_ERROR] },
    });
    await expect(
      putSchedulesChecked(
        limited.cf,
        "cut",
        ["0 1 * * *"],
        "The Worker keeps the cron triggers it had.",
      ),
    ).rejects.toThrow(
      /^Cloudflare refused 1 cron trigger: this account has reached the Workers Free limit/,
    );
    expect(limited.api.calls[0]?.body).toBe('[{"cron":"0 1 * * *"}]');

    const invalid = client({
      [`PUT ${A}/workers/scripts/cut/schedules`]: {
        status: 400,
        errors: [{ code: 10021, message: "invalid cron" }],
      },
    });
    await expect(putSchedulesChecked(invalid.cf, "cut", ["nope"], "")).rejects.toThrow(
      CloudflareApiError,
    );
  });
});
