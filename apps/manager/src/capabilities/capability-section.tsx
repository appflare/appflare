import {
  Badge,
  type BadgeVariant,
  Button,
  Collapsible,
  Link,
  LinkButton,
  Meter,
  Radio,
  Text,
} from "@cloudflare/kumo";
import { ArrowClockwiseIcon, ArrowSquareOutIcon } from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import {
  ACCOUNT_PLAN_COPY,
  ACCOUNT_PLANS,
  type AccountPlan,
  accountPlanSchema,
} from "../account/plan";
import { setAccountPlan } from "../account/plan.functions";
import type { ConnectionKind } from "../cloudflare/connection-view";
import { BusyButton } from "../components/busy-button";
import { ConfirmDialog } from "../components/confirm-dialog";
import { DocsLink } from "../components/docs-link";
import { ErrorMessageBanner, MessageText } from "../components/message-text";
import { Section, SectionRow, SectionRows } from "../components/section";
import { settingsSection } from "../components/settings-links";
import { Timestamp } from "../components/timestamp";
import { type CapabilitiesView, manualPlanControl } from "./capabilities";
import {
  CAPABILITY_STATE_LABELS,
  type CapabilityRow,
  type CapabilityState,
  capabilityAnchor,
  capabilityProgress,
  capabilityRows,
  progressLabel,
} from "./capability-rows";
import { checkCapabilitiesAgain, getCapabilityRowsData } from "./capability-rows.functions";
import type { CapabilityRowsData } from "./capability-rows.server";

/**
 * "What this account can run", drawn the same on Your account and in the
 * last setup step: a meter of the rows that are ready, then one row per
 * capability (its name, why apps need it, a state badge, its one action on
 * the right, and its details behind "Details"), and "Check again" for
 * admins. The rows come from `capabilityRows`; nothing here decides a state.
 */

const STATE_BADGES: Record<CapabilityState, BadgeVariant> = {
  ready: "success",
  "needs-action": "warning",
  "not-set-up": "outline",
  "paid-only": "info",
  "could-not-check": "secondary",
};

export function CapabilityStateBadge({ state }: { state: CapabilityState }) {
  return <Badge variant={STATE_BADGES[state]}>{CAPABILITY_STATE_LABELS[state]}</Badge>;
}

/** "5 of 7 ready", over the rows that can be ready on this plan; green once all are. */
export function CapabilityMeter({ rows }: { rows: readonly CapabilityRow[] }) {
  const progress = capabilityProgress(rows);
  const label = progressLabel(progress);
  const complete = progress.total > 0 && progress.ready === progress.total;
  return (
    <Meter
      label={label}
      showValue={false}
      value={progress.ready}
      max={Math.max(progress.total, 1)}
      getAriaValueText={() => label}
      className="w-40 gap-1"
      trackClassName="h-1.5"
      indicatorClassName={
        complete ? "from-kumo-success via-kumo-success to-kumo-success" : undefined
      }
    />
  );
}

/** When the probes last ran, as the section's header and the setup step say it. */
export function CheckedAt({ iso }: { iso: string | null }) {
  return iso === null ? (
    <>Not checked yet.</>
  ) : (
    <>
      Checked <Timestamp iso={iso} />.
    </>
  );
}

/**
 * The Workers plan an admin states while Appflare cannot detect it: a
 * dialog with the two plans, saved with Save.
 */
function ChoosePlanDialog({
  view,
  connection,
  onSaved,
}: {
  view: CapabilitiesView;
  connection: ConnectionKind;
  onSaved: () => Promise<void>;
}) {
  const [choice, setChoice] = useState<AccountPlan | null>(view.manualPlan);
  const control = manualPlanControl(view, connection);
  return (
    <ConfirmDialog
      trigger={(p) => (
        <Button {...p} variant="secondary" size="sm">
          Choose plan
        </Button>
      )}
      title={ACCOUNT_PLAN_COPY.manualLegend}
      description="Appflare cannot read the plan from Cloudflare, so it uses the one you choose here."
      actionLabel="Save"
      destructive={false}
      disabled={choice === null}
      onOpen={() => setChoice(view.manualPlan)}
      onConfirm={async () => {
        if (choice === null) return;
        await setAccountPlan({ data: { plan: choice } });
        await onSaved();
      }}
    >
      <Radio.Group
        legend="Workers plan"
        description={
          control.show && control.billingHint ? ACCOUNT_PLAN_COPY.billingHint : undefined
        }
        value={choice ?? ""}
        onValueChange={(next: string) => {
          const parsed = accountPlanSchema.safeParse(next);
          if (parsed.success) setChoice(parsed.data);
        }}
        appearance="card"
      >
        {ACCOUNT_PLANS.map((plan) => (
          <Radio.Item
            key={plan}
            label={ACCOUNT_PLAN_COPY.labels[plan]}
            description={ACCOUNT_PLAN_COPY.descriptions[plan]}
            value={plan}
          />
        ))}
      </Radio.Group>
    </ConfirmDialog>
  );
}

/** What the rows need: who is looking, the plan choice, and whether links open in a new tab (the setup step keeps its place). */
interface RowOptions {
  isAdmin: boolean;
  view: CapabilitiesView;
  /** How Appflare connects, for the plan choice's hint. */
  connection: ConnectionKind;
  /** After the admin chose a plan: read the rows again. */
  onPlanSaved: () => Promise<void>;
  newTab: boolean;
}

/** The row's one action, at its right. "Choose plan" is for admins only. */
function RowAction({ row, options }: { row: CapabilityRow; options: RowOptions }) {
  const action = row.action;
  if (action === null) return null;
  switch (action.kind) {
    case "turn-on":
    case "add-domain":
    case "edit-token":
      return (
        <LinkButton href={action.href} external variant="secondary" size="sm">
          {action.label}
          <ArrowSquareOutIcon aria-hidden />
        </LinkButton>
      );
    case "reconnect":
    case "set-up":
      return (
        <LinkButton
          href={action.href}
          variant="secondary"
          size="sm"
          {...(options.newTab ? { target: "_blank", rel: "noopener" } : {})}
        >
          {action.label}
        </LinkButton>
      );
    case "choose-plan":
      return options.isAdmin ? (
        <ChoosePlanDialog
          view={options.view}
          connection={options.connection}
          onSaved={options.onPlanSaved}
        />
      ) : null;
  }
}

/** "Workers Free, detected by Appflare." */
function foundLine(row: CapabilityRow): string | null {
  const { found, source } = row.details;
  if (found === null) return null;
  if (source === "detected") return `${found}, detected by Appflare.`;
  if (source === "set-by-you") return `${found}, set by you.`;
  return `${found}.`;
}

/**
 * What "Details" opens, under the row: what was found and by whom, what went
 * wrong, anything else worth knowing, who uses it, and when it was checked.
 */
function RowDetails({ row, newTab }: { row: CapabilityRow; newTab: boolean }) {
  const { details } = row;
  const lines = [foundLine(row), details.problem, details.note, details.usedBy].filter(
    (line): line is string => line !== null,
  );
  return (
    <Collapsible.DefaultPanel>
      <div className="grid gap-1 break-words">
        {lines.map((line) => (
          <Text key={line} variant="secondary" size="sm">
            <MessageText message={line} newTab={newTab} />
          </Text>
        ))}
        {details.job !== null && (
          <Text variant="secondary" size="sm">
            <Link
              href={details.job.href}
              {...(newTab ? { target: "_blank", rel: "noopener" } : {})}
            >
              {details.job.label}
            </Link>
          </Text>
        )}
        {/* Before the first check, the row's problem already says so. */}
        {details.checkedAt !== null && (
          <Text variant="secondary" size="sm">
            <CheckedAt iso={details.checkedAt} />
          </Text>
        )}
      </div>
    </Collapsible.DefaultPanel>
  );
}

/**
 * The rows, split by dividers: the name and its state, why apps need it,
 * and on the right the row's action and "Details", which opens the details
 * under the row. `narrow` is for a list in a narrow card with padding of its
 * own (the setup step): no side padding, and the actions always under the
 * text, so every row is laid out alike.
 */
export function CapabilityRowList({
  rows,
  options,
  narrow = false,
}: {
  rows: readonly CapabilityRow[];
  options: RowOptions;
  narrow?: boolean;
}) {
  return (
    <SectionRows>
      {rows.map((row) => (
        <Collapsible.Root key={row.id}>
          <SectionRow
            id={capabilityAnchor(row.id)}
            className={narrow ? "px-0" : undefined}
            stackAction={narrow}
            title={
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {row.name}
                <CapabilityStateBadge state={row.state} />
              </span>
            }
            description={row.why}
            action={
              <>
                <RowAction row={row} options={options} />
                <Collapsible.DefaultTrigger className="h-7 text-sm font-normal text-kumo-subtle">
                  Details
                </Collapsible.DefaultTrigger>
              </>
            }
          >
            <RowDetails row={row} newTab={options.newTab} />
          </SectionRow>
        </Collapsible.Root>
      ))}
    </SectionRows>
  );
}

/** Runs the probes again; `onDone` receives the rows' data as it now reads. */
export function useCheckAgain(onDone: (data: CapabilityRowsData) => Promise<void> | void) {
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function checkAgain() {
    setChecking(true);
    setError(null);
    try {
      await onDone(await checkCapabilitiesAgain());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not check the account.");
    }
    setChecking(false);
  }
  return { checking, error, checkAgain };
}

export function CheckAgainButton({
  checking,
  onClick,
  size = "base",
}: {
  checking: boolean;
  onClick(): void;
  size?: "sm" | "base";
}) {
  return (
    <BusyButton
      pending={checking}
      variant="secondary"
      size={size}
      icon={<ArrowClockwiseIcon />}
      onClick={onClick}
    >
      Check again
    </BusyButton>
  );
}

/**
 * The section on Your account. "Check again" (admins) runs the probes and
 * reloads the page, so every section that reads them shows the new values;
 * so does saving a chosen plan.
 */
export function CapabilitiesSection({
  data,
  isAdmin,
}: {
  data: CapabilityRowsData;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const reload = () => router.invalidate();
  const { checking, error, checkAgain } = useCheckAgain(reload);
  const rows = capabilityRows(data);
  return (
    <Section
      {...settingsSection("account", "capabilities")}
      titleAction={<DocsLink topic="capabilities" />}
      badge={<CapabilityMeter rows={rows} />}
      description={
        <>
          What your Cloudflare account has that apps rely on.{" "}
          <CheckedAt iso={data.view.checkedAt} />
        </>
      }
      action={
        isAdmin ? <CheckAgainButton checking={checking} onClick={() => void checkAgain()} /> : null
      }
      error={error}
    >
      <CapabilityRowList
        rows={rows}
        options={{
          isAdmin,
          view: data.view,
          connection: data.connection?.kind ?? "api_token",
          onPlanSaved: reload,
          newTab: false,
        }}
      />
    </Section>
  );
}

/**
 * The last setup step's content: the meter, the same rows, when they were
 * checked, and Check again. Links open in a new tab, so setup keeps its
 * place; Check again and a chosen plan hand the new reading to `onChanged`,
 * so the step updates in place.
 */
export function SetupCapabilities({
  data,
  onChanged,
}: {
  data: CapabilityRowsData;
  onChanged: (data: CapabilityRowsData) => void;
}) {
  const { checking, error, checkAgain } = useCheckAgain(onChanged);
  const rows = capabilityRows(data);
  return (
    <div className="grid min-w-0 gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CapabilityMeter rows={rows} />
        <CheckAgainButton checking={checking} onClick={() => void checkAgain()} size="sm" />
      </div>
      {error !== null && <ErrorMessageBanner message={error} newTab />}
      <CapabilityRowList
        rows={rows}
        narrow
        options={{
          isAdmin: true,
          view: data.view,
          connection: data.connection?.kind ?? "api_token",
          onPlanSaved: async () => onChanged(await getCapabilityRowsData()),
          newTab: true,
        }}
      />
      <Text variant="secondary" size="sm">
        <CheckedAt iso={data.view.checkedAt} />
      </Text>
    </div>
  );
}
