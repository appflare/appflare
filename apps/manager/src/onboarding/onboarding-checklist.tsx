import { Badge, Banner, Button, LayerCard, Link, Text } from "@cloudflare/kumo";
import { ArrowClockwiseIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Timestamp } from "../components/timestamp";
import {
  buildChecklist,
  type ChecklistRow,
  type ChecklistStatus,
  needsYouCount,
  STATUS_LABELS,
} from "./checklist";
import { recheckChecklist } from "./checklist.functions";
import type { ChecklistData } from "./checklist.server";

const STATUS_VARIANT: Record<ChecklistStatus, "success" | "warning" | "neutral"> = {
  done: "success",
  "needs-you": "warning",
  optional: "neutral",
};

function Row({ row }: { row: ChecklistRow }) {
  return (
    <li className="grid gap-1 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <Text bold>{row.label}</Text>
        <Badge variant={STATUS_VARIANT[row.status]}>{STATUS_LABELS[row.status]}</Badge>
      </div>
      <Text>{row.value}</Text>
      <Text variant="secondary" size="sm">
        {row.why}
      </Text>
      {row.note !== null && (
        <Text variant="secondary" size="sm">
          {row.note}
        </Text>
      )}
      {row.link !== null && (
        <Text size="sm">
          {row.link.external ? (
            <Link href={row.link.href} target="_blank" rel="noopener noreferrer">
              {row.link.label}
              <Link.ExternalIcon />
            </Link>
          ) : (
            <Link href={row.link.href}>{row.link.label}</Link>
          )}
        </Text>
      )}
    </li>
  );
}

/**
 * Re-check: runs the probes, then reloads the route, so this checklist and
 * every other card that reads the same probes show the new values.
 */
function useRecheck() {
  const router = useRouter();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function recheck() {
    setChecking(true);
    setError(null);
    try {
      await recheckChecklist();
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not check the account.");
    }
    setChecking(false);
  }
  return { checking, error, recheck };
}

function RecheckButton({ checking, onClick }: { checking: boolean; onClick(): void }) {
  return (
    <Button
      variant="secondary"
      size="sm"
      icon={<ArrowClockwiseIcon />}
      loading={checking}
      onClick={onClick}
    >
      Re-check
    </Button>
  );
}

function Summary({ rows, checkedAt }: { rows: ChecklistRow[]; checkedAt: string | null }) {
  const pending = needsYouCount(rows);
  return (
    <Text variant="secondary">
      {pending === 0
        ? "Nothing here needs you. Optional rows unlock more apps."
        : `${pending} ${pending === 1 ? "item needs" : "items need"} you before some apps can be installed.`}{" "}
      {checkedAt === null ? (
        "The account has not been checked yet."
      ) : (
        <>
          Checked <Timestamp iso={checkedAt} />.
        </>
      )}
    </Text>
  );
}

function ChecklistBody({
  data,
  onAccountSettings,
}: {
  data: ChecklistData;
  onAccountSettings: boolean;
}) {
  const rows = buildChecklist({ ...data, onAccountSettings });
  return (
    <div className="grid gap-4">
      <Summary rows={rows} checkedAt={data.view.checkedAt} />
      <ul className="grid divide-y divide-kumo-hairline">
        {rows.map((row) => (
          <Row key={row.id} row={row} />
        ))}
      </ul>
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={message} />;
}

/** The last setup step's content: the checklist and Re-check (the page adds Finish). */
export function SetupChecklist({ data }: { data: ChecklistData }) {
  const { checking, error, recheck } = useRecheck();
  return (
    <div className="grid gap-4">
      <ChecklistBody data={data} onAccountSettings={false} />
      {error !== null && <ErrorBanner message={error} />}
      <div className="flex justify-end">
        <RecheckButton checking={checking} onClick={() => void recheck()} />
      </div>
    </div>
  );
}

/** Settings › Account and capabilities: the same checklist as a card. */
export function OnboardingChecklistCard({
  data,
  isAdmin,
}: {
  data: ChecklistData;
  isAdmin: boolean;
}) {
  const { checking, error, recheck } = useRecheck();
  return (
    <LayerCard>
      <LayerCard.Secondary className="flex items-center justify-between gap-3">
        <span>Onboarding checklist</span>
        {isAdmin && <RecheckButton checking={checking} onClick={() => void recheck()} />}
      </LayerCard.Secondary>
      <LayerCard.Primary className="grid gap-4 px-5 py-4">
        <ChecklistBody data={data} onAccountSettings />
        {error !== null && <ErrorBanner message={error} />}
      </LayerCard.Primary>
    </LayerCard>
  );
}
