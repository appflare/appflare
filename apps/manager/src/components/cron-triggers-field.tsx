import { Text } from "@cloudflare/kumo";
import { ClockIcon } from "@phosphor-icons/react";
import { cronTriggersNote, WORKERS_PAID_CRON_CONFIRMATION } from "../catalog/cron-triggers";
import {
  WorkersPaidConfirmation,
  type WorkersPaidConfirmationState,
} from "./workers-paid-confirmation";

/**
 * "Uses N cron triggers (the free plan allows 5 per account)", for an app
 * whose artifact declares any, with an optional "This account is on Workers
 * Paid" confirmation under it (install form and update dialog, for an app
 * that does not need Workers Paid itself, while the account's plan in
 * Settings says free). Renders nothing for zero.
 */
export function CronTriggersField({
  count,
  confirmation = null,
}: {
  count: number;
  confirmation?: WorkersPaidConfirmationState | null;
}) {
  const note = cronTriggersNote(count);
  if (note === null) return null;
  return (
    <div className="grid gap-2">
      <Text as="p" variant="secondary" size="sm">
        <span className="inline-flex items-center gap-1.5">
          <ClockIcon aria-hidden />
          {note}.
        </span>
      </Text>
      {confirmation !== null && (
        <WorkersPaidConfirmation
          state={confirmation}
          label={WORKERS_PAID_CRON_CONFIRMATION.label}
          description={WORKERS_PAID_CRON_CONFIRMATION.description}
        />
      )}
    </div>
  );
}
