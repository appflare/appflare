import {
  FREE_PLAN_CRON_TRIGGERS,
  PAID_PLAN_CRON_TRIGGERS,
  WORKERS_PAID_CRON_CONFIRMATION,
} from "./cron-triggers";

/**
 * Per-account limits an install or update meets when it creates its
 * resources, where Workers Free's are low enough that an account that has
 * tried a few apps reaches them, and the words the install form and the
 * update dialog use about them. Client-safe: no server imports.
 *
 * As Cloudflare's limits pages state them (checked 2026-10-17): D1
 * databases, 10 on Workers Free and 50,000 on Workers Paid; Hyperdrive
 * configurations, 10 on Workers Free and 25 on Workers Paid; Vectorize
 * indexes, 100 on Workers Free and 50,000 on Workers Paid. KV namespaces
 * (1,000), queues (10,000) and R2 buckets (1,000,000) are far from anything
 * an install meets, on either plan.
 */

export type LimitedKind = "d1" | "hyperdrive" | "vectorize";

export const LIMITED_KINDS: readonly LimitedKind[] = ["d1", "hyperdrive", "vectorize"];

export interface KindLimit {
  /** One of them, and several, as the messages name them. */
  one: string;
  many: string;
  free: number;
  /** Workers Paid's limit, when an install could meet it; null when it cannot. */
  paid: number | null;
  /** Workers Paid's limit as the advice to upgrade states it. */
  paidStated: number;
}

export const KIND_LIMITS: Record<LimitedKind, KindLimit> = {
  d1: { one: "D1 database", many: "D1 databases", free: 10, paid: null, paidStated: 50_000 },
  hyperdrive: {
    one: "Hyperdrive configuration",
    many: "Hyperdrive configurations",
    free: 10,
    paid: 25,
    paidStated: 25,
  },
  vectorize: {
    one: "Vectorize index",
    many: "Vectorize indexes",
    free: 100,
    paid: null,
    paidStated: 50_000,
  },
};

/** How many of each limited kind `creates` (an app's resources to create) has; empty when none. */
export function limitedCreates(
  creates: ReadonlyArray<{ kind: string }>,
): Partial<Record<LimitedKind, number>> {
  const counts: Partial<Record<LimitedKind, number>> = {};
  for (const { kind } of creates) {
    if ((LIMITED_KINDS as readonly string[]).includes(kind)) {
      const limited = kind as LimitedKind;
      counts[limited] = (counts[limited] ?? 0) + 1;
    }
  }
  return counts;
}

/** Whether `counts` names any resource to create. */
export function hasLimited(counts: Partial<Record<LimitedKind, number>>): boolean {
  return LIMITED_KINDS.some((kind) => (counts[kind] ?? 0) > 0);
}

function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/**
 * The "This account is on Workers Paid" confirmation offered, while
 * Appflare does not know the account's plan, for an app that does not need
 * Workers Paid itself but sets cron triggers or creates resources of a
 * limited kind: on Workers Paid the counts are skipped. Null when it does
 * neither.
 */
export function workersPaidLimitsConfirmation(input: {
  cronTriggers: number;
  creates: Partial<Record<LimitedKind, number>>;
}): { label: string; description: string } | null {
  const kinds = LIMITED_KINDS.filter((kind) => (input.creates[kind] ?? 0) > 0);
  if (kinds.length === 0) {
    return input.cronTriggers > 0 ? WORKERS_PAID_CRON_CONFIRMATION : null;
  }
  const limits = [
    ...(input.cronTriggers > 0
      ? [{ many: "cron triggers", free: FREE_PLAN_CRON_TRIGGERS, paid: PAID_PLAN_CRON_TRIGGERS }]
      : []),
    ...kinds.map((kind) => ({
      many: KIND_LIMITS[kind].many,
      free: KIND_LIMITS[kind].free,
      paid: KIND_LIMITS[kind].paidStated,
    })),
  ];
  const n = (count: number) => count.toLocaleString("en-US");
  const paid = listWords(limits.map((l) => `${n(l.paid)} ${l.many}`));
  const description =
    limits.length === 1
      ? `Workers Paid allows ${paid} per account. Otherwise Appflare counts the ${limits[0]?.many} the account already has and stops before it changes anything if this would pass ${n(limits[0]?.free ?? 0)}.`
      : `Workers Paid allows ${paid} per account. Otherwise Appflare counts what the account already has and stops before it changes anything if this would pass Workers Free's limits (${limits.map((l) => `${n(l.free)} ${l.many}`).join(", ")}).`;
  return { label: WORKERS_PAID_CRON_CONFIRMATION.label, description };
}
