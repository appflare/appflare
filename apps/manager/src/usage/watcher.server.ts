import {
  CloudflareApiError,
  type CloudflareClient,
  CloudflareGraphQLError,
  missingSpendProtectionScopes,
} from "@appflare/cf-api";
import { accountPlanRead } from "../account/plan.server";
import { getCfClient } from "../cloudflare/client.server";
import { grantRead } from "../cloudflare/grant-store.server";
import { readTogether } from "../db/batch";
import { createDb, type Database } from "../db/client";
import { SETTING, settingsRead } from "../db/settings";
import { type AccountDay, accountToday } from "./account-day";
import { checkAccountLimits, deliverAccountLimitEvents } from "./account-limits.server";
import {
  ACCOUNT_DAY_READ,
  accountDayFrom,
  type CollectSource,
  type CollectTarget,
  collectUsage,
  HOUR,
  LEVEL_PRODUCTS,
} from "./collect";
import { addAccountResources, changedHours, storedIndex, watchedAppsRead } from "./collect.server";
import { DAY_MS, dayStart, HOUR_MS, type ProductKey, type Usage } from "./math";
import { recentResumesRead, resumeWindows } from "./resume.server";
import { pruneActivityStatement } from "./store/activity.server";
import { pruneAlertFiringsStatement } from "./store/alert-rules.server";
import {
  type HourlyUsage,
  pruneUsageStatements,
  readUsage,
  recordHourlyUsage,
  type UsageRow,
  usageRead,
} from "./store/series.server";
import { usageStatesOf, usageStatesRead } from "./store/usage-state.server";
import { type CheckInput, type CheckUnitResult, checkUnit, runCheck } from "./watcher-check.server";
import { ALL_HISTORY, historyBounds, loadHistory, usageByInstall } from "./watcher-history.server";
import {
  judge,
  message,
  type SpendWatchDeps,
  type SpendWatchEnv,
  type SpendWatchReport,
  SUBREQUEST_BUDGET,
  storedUsage,
  writeOverview,
} from "./watcher-judge.server";
import { shardUnit } from "./watcher-shard.server";
import { type SpendWatchStatus, storedAccountDay, writeSpendWatchStatus } from "./watcher-status";

export type { SpendWatchDeps, SpendWatchEnv, SpendWatchReport } from "./watcher-judge.server";
export { SUBREQUEST_BUDGET } from "./watcher-judge.server";

/**
 * The spend watcher: every five minutes, what each installed app used, kept
 * in Appflare's own hourly snapshots, then judged by the spend protection
 * rules (evaluate.ts), which alert, record what happened, and pause apps.
 *
 * One check, in order:
 * 1. Without the analytics permission (an OAuth grant from before it was
 *    asked for, or an API token without "Account Analytics"), nothing else
 *    happens: the status says so and pages show "Reconnect to see usage".
 * 2. Apps installed less than 15 minutes ago are left for later: the
 *    analytics show a brand-new Durable Object namespace only after about
 *    13 minutes, so an early read would store hours that look like nothing
 *    happened. Their first check reads from their install on. On Workers
 *    Free, a check with no app to read (none, or all too new) still reads
 *    the account's totals alone, in one request, and judges the account's
 *    free daily limits (account-limits.ts).
 * 3. Collect (collect.ts): each dataset once for all apps, for the hours
 *    that can still change (the last three) and any missed since the app's
 *    last check (up to eight days back for an app never checked, enough
 *    for its normal hour). Only hours whose value changed are written:
 *    each write rolls the touched days up again, and rows read count on
 *    the Workers Free plan.
 * 4. Judge every app and act: states, activity, notifications (sent at once
 *    over `SELF` while this invocation has subrequests to spare, else by
 *    the scheduled run), alert firings, pauses.
 *    On Workers Free (10 ms of CPU time per run) this happens in an
 *    invocation of its own (watcher-check.server.ts), which judges the apps
 *    in parts of a few apps, each an invocation of its own too
 *    (watcher-shard.server.ts).
 *
 * Every invocation's CPU time counts on Workers Free, and code that runs
 * once every five minutes is never optimized by the runtime: what costs is
 * each call made, not only the work. So a check reads D1 in as few round
 * trips as it can (db/batch.ts), asks the analytics for every dataset in one
 * request, and validates what it hands its own units without Zod.
 *
 * On the half-hour checks it also prunes the usage history, activity and
 * alert firings past their retention (each delete reads through an index on
 * time, so only the rows it deletes).
 *
 * A check never throws: what failed is in the report and the status.
 */

/** An app this young is not read yet (the analytics' blind spot for new apps). */
export const NEW_APP_MS = 15 * 60_000;
/** Hours read again on every check: the analytics may still change them. */
export const RECENT_HOURS = 3;
/** The furthest back a check reads (an app never checked, or a long gap). */
export const MAX_BACKFILL_DAYS = 8;
/**
 * Whether Cloudflare refused a read for lack of permission, by what it
 * says in codes: the GraphQL API's `authz` extension code, or the REST
 * envelope's 401/403 status and authentication codes (9106 missing or bad
 * credentials, 9109 unauthorized, 10000 authentication error).
 */
export function isAccessRefusal(error: unknown): boolean {
  if (error instanceof CloudflareGraphQLError) return error.codes.includes("authz");
  if (error instanceof CloudflareApiError) {
    return (
      error.status === 401 ||
      error.status === 403 ||
      error.errors.some((e) => e.code === 9106 || e.code === 9109 || e.code === 10000)
    );
  }
  return false;
}

/**
 * The recent hours a check lays over the history: those from the
 * history's cut-off on, with what the check wrote in place of what was
 * stored, oldest first. Earlier hours are in the history already (it is
 * read afresh when the check wrote any of them), compacted into days where
 * the math needs no hours: laying them over it again would count them twice.
 */
export function recentRows(
  stored: readonly UsageRow[],
  written: readonly HourlyUsage[],
  cutoff: number,
): UsageRow[] {
  const rows = new Map<string, UsageRow>();
  const key = (r: { installId: string; product: string }, t: number) =>
    `${r.installId}\u0000${r.product}\u0000${t}`;
  for (const row of stored) if (row.t >= cutoff) rows.set(key(row, row.t), row);
  for (const c of written) {
    if (c.hour >= cutoff)
      rows.set(key(c, c.hour), {
        installId: c.installId,
        product: c.product,
        t: c.hour,
        value: c.value,
      });
  }
  return [...rows.values()].sort((a, b) => a.t - b.t);
}

/** The first hour a check reads for an app (unix seconds). */
export function readFrom(
  app: { installedAt: number },
  lastCheckedAt: number | null,
  now: number,
): number {
  const hourOf = (t: number) => Math.floor(t / HOUR_MS) * HOUR_MS;
  const floor = Math.max(
    Math.floor(now / DAY_MS) * DAY_MS - MAX_BACKFILL_DAYS * DAY_MS,
    hourOf(app.installedAt),
  );
  const recent = hourOf(now) - RECENT_HOURS * HOUR_MS;
  const from =
    lastCheckedAt === null
      ? floor
      : Math.min(recent, hourOf(lastCheckedAt) - RECENT_HOURS * HOUR_MS);
  return Math.max(from, floor) / 1000;
}

/** Each storage product's level in the hour before `from`, from the stored usage. */
function levelsBefore(usage: Usage | undefined, from: number): Partial<Record<ProductKey, number>> {
  const out: Partial<Record<ProductKey, number>> = {};
  if (usage === undefined) return out;
  for (const product of LEVEL_PRODUCTS) {
    const series = usage[product];
    if (series === undefined) continue;
    let latest: number | undefined;
    for (const point of series) if (point.hour < from * 1000) latest = point.value;
    if (latest !== undefined) out[product] = latest;
  }
  return out;
}

/** Prunes the usage history, activity and alert firings past their retention, in one batch. */
async function prune(db: Database, now: number): Promise<number> {
  const at = new Date(now);
  const results = await db.batch([
    ...pruneUsageStatements(db, at),
    pruneActivityStatement(db, at),
    pruneAlertFiringsStatement(db, at),
  ]);
  return results.reduce((sum, r) => sum + r.meta.changes, 0);
}

/** One check; see the module comment. */
export async function watchSpend(
  env: SpendWatchEnv,
  options: { maintenance?: boolean } = {},
  deps: SpendWatchDeps = {},
): Promise<SpendWatchReport> {
  const now = (deps.now ?? Date.now)();
  const db = createDb(env.DB);
  const budget = deps.budget ?? SUBREQUEST_BUDGET;
  const report: SpendWatchReport = {
    status: "idle",
    apps: 0,
    newApps: 0,
    rowsWritten: 0,
    alerts: 0,
    pauses: 0,
    deferred: 0,
    subrequests: 0,
    history: null,
    pruned: null,
  };
  /** The pages' numbers a check on Workers Free worked out, stored with the status. */
  let overview: string | null = null;
  /**
   * Workers Free: the account's totals for the free daily limits, stored
   * with the status: this check's reading, else the last one of the day.
   */
  let accountDay: AccountDay | null = null;
  const finish = async (checked: SpendWatchStatus | null) => {
    if (checked !== null) {
      // A reading from an earlier day is no use to anyone: left out.
      const day = accountDay !== null && accountToday(accountDay, now) !== null ? accountDay : null;
      const status: SpendWatchStatus = day === null ? checked : { ...checked, account: day };
      report.status = status.state;
      if (status.state === "failed") report.error = status.error;
      try {
        const { alongsideError } = await writeSpendWatchStatus(
          db,
          status,
          overview === null ? {} : { [SETTING.spendOverview]: overview },
        );
        if (alongsideError !== undefined) {
          console.error("spend watcher: overview not stored", { error: message(alongsideError) });
        }
      } catch (error) {
        console.error("spend watcher: status not stored", { error: message(error) });
        if (overview !== null) {
          console.error("spend watcher: overview not stored", { error: message(error) });
        }
      }
    }
    return report;
  };

  if (options.maintenance) {
    try {
      report.pruned = await prune(db, now);
    } catch (error) {
      console.error("spend watcher: pruning failed", { error: message(error) });
    }
  }

  try {
    // What the check reads before it asks Cloudflare, in one round trip
    // (db/batch.ts): the apps, the connection, the plan, what the last
    // checks remembered, the latest resumes, and the stored hours the check
    // reads again (from the history's cut-off on; an app that fell further
    // behind reads its older hours just below).
    const { cutoff } = historyBounds(now);
    const hourNow = Math.floor(now / HOUR_MS) * (HOUR_MS / 1000);
    const [all, grant, plan, account, storedStates, latestResumes, storedRecent] =
      await readTogether(db, [
        watchedAppsRead(db),
        grantRead(db),
        accountPlanRead(db),
        settingsRead(db, [SETTING.accountId, SETTING.spendWatch]),
        usageStatesRead(db, null),
        recentResumesRead(db, now),
        usageRead(db, { from: cutoff - HOUR, to: hourNow + HOUR, grain: "hour" }),
      ] as const);
    // The day's last reading of the account's totals, kept unless this check reads them anew.
    if (plan === "free") accountDay = storedAccountDay(account[SETTING.spendWatch]);
    /**
     * Workers Free: the rest of the check (the account's sums, the parts
     * that judge the apps, the pages' numbers) in an invocation of its own,
     * the `spendCheck` unit (watcher-check.server.ts), or in place without it.
     */
    const checkRest = async (
      input: Omit<CheckInput, "budget">,
      options: { history: boolean },
    ): Promise<void> => {
      const unit = checkUnit(env);
      if (unit !== null) report.subrequests += 1;
      const full: CheckInput = { ...input, budget: budget - report.subrequests };
      let result: CheckUnitResult;
      if (unit === null) result = { ok: true, value: await runCheck(env, full, deps) };
      else {
        try {
          result = await unit.spendCheck(full);
        } catch (error) {
          result = { ok: false, error: message(error) };
        }
      }
      if (!result.ok) throw new Error(result.error);
      const done = result.value;
      report.alerts += done.alerts;
      report.pauses += done.pauses;
      report.deferred += done.deferred;
      report.subrequests += done.subrequests;
      if (done.parts !== undefined) report.parts = done.parts;
      if (options.history) report.history = done.history;
      overview = done.overview;
    };
    /**
     * The pages' numbers from what is stored, for a check that collects
     * nothing. Best effort: the status the check is about to store (say,
     * that the connection needs access) matters more than the numbers.
     */
    const storedOverview = async (options: { withAccount?: boolean } = {}) => {
      // Workers Free: the account's free daily limits are judged even with no
      // app to read, from this check's reading of the account alone.
      const accountUsed =
        options.withAccount === true && plan === "free" ? accountToday(accountDay, now) : null;
      if (plan !== "free" || shardUnit(env) === null) {
        if (accountUsed === null) {
          await writeOverview(env, db, { now, all });
          return;
        }
        const usage = await storedUsage(db, env.KV, now);
        const checked = await checkAccountLimits(
          env,
          db,
          { now, accountToday: accountUsed, usage, listed: new Set(all.map((a) => a.installId)) },
          deps,
          report,
        );
        await deliverAccountLimitEvents(env, checked.deliver, budget, report);
        await writeOverview(env, db, { now, all, usage });
        return;
      }
      try {
        await checkRest(
          {
            now,
            plan,
            all,
            judge: [],
            incomplete: [],
            alarms: {},
            fresh: [],
            resumes: {},
            ...(accountUsed === null ? {} : { accountToday: { ...accountUsed } }),
          },
          { history: false },
        );
      } catch (error) {
        console.error("spend watcher: overview not stored", { error: message(error) });
      }
    };
    /** The Cloudflare client of this check, made once, counting its subrequests. */
    let client: CloudflareClient | null = null;
    const cloudflare = async (): Promise<CloudflareClient> => {
      client ??= await getCfClient(env, {
        grant,
        accountId: account[SETTING.accountId] ?? "",
        ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
        onRequest: () => {
          report.subrequests += 1;
        },
      });
      return client;
    };
    /**
     * Workers Free with no app to read yet (none installed, or all too new):
     * the account's totals alone, in one request, since Cloudflare stops a
     * product for the whole account (Appflare's own Worker and database too)
     * once something else uses up its daily limit.
     */
    const readAccountAlone = async (): Promise<void> => {
      if (plan !== "free") return;
      try {
        const api = await cloudflare();
        const read = await api.usage.batched().accountTotals({
          from: dayStart(now) / 1000,
          to: Math.floor(now / 1000),
          datasets: ACCOUNT_DAY_READ,
        });
        const fresh = accountDayFrom(read, now);
        const earlier = accountToday(accountDay, now) ?? {};
        accountDay = { at: fresh.at, used: { ...earlier, ...fresh.used } };
        if (read.failed.length > 0) report.failedReads = ["account"];
      } catch (error) {
        report.failedReads = ["account"];
        console.warn("spend watcher: the account's totals not read", { error: message(error) });
      }
    };
    if (all.length === 0) {
      await readAccountAlone();
      await storedOverview({ withAccount: true });
      return await finish({ state: "watching", at: now });
    }
    if (grant !== null) {
      const missing = missingSpendProtectionScopes(grant.scopes);
      if (missing.length > 0) {
        await storedOverview();
        return await finish({ state: "needs_access", at: now, via: "oauth", missing });
      }
    }
    const apps = all.filter((a) => now - a.installedAt >= NEW_APP_MS);
    report.newApps = all.length - apps.length;
    report.apps = apps.length;
    if (apps.length === 0) {
      await readAccountAlone();
      await storedOverview({ withAccount: true });
      return await finish({ state: "watching", at: now });
    }

    const api = await cloudflare();
    const states = usageStatesOf(
      storedStates,
      apps.map((a) => a.installId),
    );

    // What is stored for the hours this check reads again, and the hour
    // before them (each storage level to carry forward).
    const froms = new Map(
      apps.map((a) => [
        a.installId,
        readFrom(a, states.get(a.installId)?.lastCheckedAt ?? null, now),
      ]),
    );
    const recentFrom = Math.min(cutoff, ...froms.values());
    const stored =
      recentFrom < cutoff
        ? [
            ...(await readUsage(db, { from: recentFrom - HOUR, to: cutoff - HOUR, grain: "hour" })),
            ...storedRecent,
          ]
        : storedRecent;
    const before = usageByInstall([], stored);

    // The account's Durable Object namespaces and containers: without
    // them, those products are left out for this check (not the rest).
    const notListed = await addAccountResources(api, apps, plan);
    const unread: CollectSource[] = notListed?.unread ?? [];
    if (notListed !== null) {
      console.warn(`spend watcher: ${notListed.what} not listed`, {
        error: message(notListed.error),
      });
    }
    const targets: CollectTarget[] = apps.map((a) => {
      const from = froms.get(a.installId) ?? hourNow;
      return {
        ...a.resources,
        from,
        levelsBefore: levelsBefore(before.get(a.installId), from),
        unread,
      };
    });
    // Workers Free: the whole account's totals for the free daily limits too,
    // in the same request (nothing on Paid limits use per day).
    const collected = await collectUsage(api.usage, targets, Math.floor(now / 1000), {
      accountTotals: plan === "free",
    });
    if (collected.accountTotals !== null) {
      const fresh = accountDayFrom(collected.accountTotals, now);
      // A product whose dataset failed keeps the day's last reading of it:
      // a count only grows during the day, so an older one is never too high.
      const earlier = accountToday(accountDay, now) ?? {};
      accountDay = { at: fresh.at, used: { ...earlier, ...fresh.used } };
    }
    const accountUsed = accountToday(accountDay, now);
    if (collected.failures.length > 0) {
      // Every read refused for lack of permission: the connection cannot read analytics.
      if (collected.succeeded === 0 && collected.failures.every((f) => isAccessRefusal(f.error))) {
        await storedOverview();
        return await finish({
          state: "needs_access",
          at: now,
          via: grant === null ? "token" : "oauth",
          missing: [],
        });
      }
      report.failedReads = collected.failures.map((f) => f.source);
      console.warn(
        `spend watcher: ${collected.failures.length} read(s) failed; their apps keep their last values this check`,
        {
          failed: collected.failures.map((f) => ({
            source: f.source,
            apps: f.installIds.length,
            error: message(f.error),
          })),
        },
      );
    }

    const changes = changedHours(collected.hours, storedIndex(stored));
    // The apps the check wrote hours of that cached histories hold already:
    // their histories are read afresh.
    const rewritten = new Set<string>();
    if (changes.length > 0) {
      const written = await recordHourlyUsage(db, changes, {
        levels: LEVEL_PRODUCTS,
        now: new Date(now),
      });
      report.rowsWritten = written.written;
      for (const c of changes) if (c.hour < cutoff) rewritten.add(c.installId);
    }
    const recent = recentRows(stored, changes, cutoff);
    // The apps resumed lately, each judged on what it did since: the resume
    // hour's base comes from the rows as stored before this check wrote any.
    const resumes = await resumeWindows(db, env.KV, {
      now,
      installIds: apps.map((a) => a.installId),
      // Read only for an app resumed lately: none, most checks.
      usage: latestResumes.size === 0 ? new Map() : usageByInstall([], recent),
      before,
      resumes: latestResumes,
      keep: true,
    });
    if (plan === "free" && shardUnit(env) !== null) {
      // Workers Free: the apps are judged in parts, each with CPU time of
      // its own (watcher-shard.server.ts), and the account's sums are worked
      // out in an invocation of their own (watcher-check.server.ts).
      await checkRest(
        {
          now,
          plan,
          all: all.map((a) => ({ installId: a.installId, installedAt: a.installedAt })),
          judge: apps.map((a) => a.installId),
          incomplete: [...collected.incomplete],
          alarms: Object.fromEntries(collected.alarms),
          fresh: [...rewritten],
          resumes: Object.fromEntries(resumes),
          ...(accountUsed === null ? {} : { accountToday: { ...accountUsed } }),
        },
        { history: true },
      );
    } else {
      const history = await loadHistory(db, env.KV, now, ALL_HISTORY, { fresh: rewritten });
      report.history = history.source;
      const usage = usageByInstall(history.series, recent);
      // Workers Free: first the whole account's warning, which owns its products for the day.
      const account =
        plan === "free"
          ? await checkAccountLimits(
              env,
              db,
              {
                now,
                accountToday: accountUsed,
                usage,
                listed: new Set(all.map((a) => a.installId)),
              },
              deps,
              report,
            )
          : undefined;
      const limitsCovered = account?.covered;
      const { paused } = await judge(
        env,
        db,
        {
          now,
          plan,
          apps,
          usage,
          states,
          alarms: collected.alarms,
          incomplete: collected.incomplete,
          installed: new Set(all.map((a) => a.installId)),
          resumes,
          ...(plan === "free" && accountUsed !== null ? { accountToday: accountUsed } : {}),
          ...(limitsCovered === undefined ? {} : { limitsCovered }),
        },
        deps,
        budget,
        report,
      );
      // After the apps: their pauses come first for the subrequests.
      if (account !== undefined) {
        await deliverAccountLimitEvents(env, account.deliver, budget, report);
      }
      await writeOverview(env, db, { now, all, plan, usage, paused, resumes });
    }
    return await finish({ state: "watching", at: now });
  } catch (error) {
    console.error("spend watcher: check failed", { error: message(error) });
    return await finish({ state: "failed", at: now, error: message(error) });
  }
}

/** The one-line summary of a check for the Worker's logs. */
export function spendWatchLog(report: SpendWatchReport): string {
  const parts = [
    `spend watcher: ${report.status}`,
    `${report.apps} app(s)`,
    ...(report.newApps > 0 ? [`${report.newApps} too new`] : []),
    `${report.rowsWritten} row(s) written`,
    `${report.alerts} alert(s)`,
    `${report.pauses} pause(s)`,
    ...(report.deferred > 0 ? [`${report.deferred} left for the next check`] : []),
    `${report.subrequests} subrequest(s)`,
    ...(report.history === null ? [] : [`history from ${report.history}`]),
    ...(report.pruned === null ? [] : [`${report.pruned} old row(s) pruned`]),
    ...(report.failedReads === undefined ? [] : [`failed reads: ${report.failedReads.join(", ")}`]),
    ...(report.parts === undefined
      ? []
      : [
          `${report.parts.count} part(s)` +
            (report.parts.ran < report.parts.count
              ? ` (${report.parts.count - report.parts.ran} left for the next check)`
              : "") +
            (report.parts.failed > 0 ? ` (${report.parts.failed} failed)` : ""),
        ]),
  ];
  return parts.join(", ") + (report.error === undefined ? "" : `: ${report.error}`);
}
