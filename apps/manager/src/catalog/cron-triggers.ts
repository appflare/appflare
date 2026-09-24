/**
 * Cron trigger limits and the words the catalog page, the install form and
 * the update dialog use about them. Client-safe: no server imports.
 *
 * Cloudflare counts cron triggers per account, across every Worker in it.
 * Workers Free allows 5. Checked against the API on 2026-09-24: `PUT
 * /workers/scripts/<name>/schedules` that would take a free account past 5
 * answers HTTP 400 with error code 10072, "This account has reached the
 * Workers Free limit of 5 cron triggers per account. Upgrade to Workers Paid
 * to increase this limit to 1,000", and changes nothing (a Worker's schedule
 * is replaced as a whole, so its own current triggers do not count against
 * the new ones).
 */

/** Cron triggers a Workers Free account may have, across all of its Workers. */
export const FREE_PLAN_CRON_TRIGGERS = 5;

/** Cron triggers a Workers Paid account may have, as Cloudflare's refusal states it. */
export const PAID_PLAN_CRON_TRIGGERS = 1000;

/** How many distinct cron triggers a Worker's schedule sets (Cloudflare stores each once). */
export function cronTriggerCount(crons: readonly string[]): number {
  return new Set(crons).size;
}

/** "3 cron triggers", "1 cron trigger". */
export function cronTriggersPhrase(count: number): string {
  return `${count} cron trigger${count === 1 ? "" : "s"}`;
}

/**
 * The note shown wherever an app's cron triggers matter before it is
 * installed or updated; null when the artifact declares none.
 */
export function cronTriggersNote(count: number): string | null {
  if (count <= 0) return null;
  return `Uses ${cronTriggersPhrase(count)} (the free plan allows ${FREE_PLAN_CRON_TRIGGERS} per account)`;
}

/**
 * The optional confirmation offered with the note for an app that does not
 * need Workers Paid itself: on Workers Paid the count check is skipped.
 */
export const WORKERS_PAID_CRON_CONFIRMATION = {
  label: "This account is on Workers Paid",
  description: `Workers Paid allows ${PAID_PLAN_CRON_TRIGGERS.toLocaleString("en-US")} cron triggers per account. Otherwise Appflare counts the cron triggers the account already uses and stops before it changes anything if this would pass ${FREE_PLAN_CRON_TRIGGERS}.`,
} as const;
