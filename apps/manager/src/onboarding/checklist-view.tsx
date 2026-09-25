import { Link, LinkButton, Meter, Text } from "@cloudflare/kumo";
import { CheckCircleIcon, CircleDashedIcon, WarningCircleIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import {
  buildChecklist,
  type ChecklistLink,
  type ChecklistRow,
  checklistProgress,
  checklistRowAnchor,
  groupChecklist,
  needsYouCount,
  rowLine,
} from "./checklist";
import type { ChecklistData } from "./checklist.server";

/**
 * How the onboarding checklist looks, the same in the last setup step and on
 * Settings › Account and capabilities: progress (rows done out of the rows
 * that count), then the rows that need the admin, expanded, with their one
 * action; the done rows on one line each with a tick; the optional ones last
 * and quieter. Presentational only; `onboarding-checklist.tsx` wires
 * Re-check and "Enable now".
 */

/** The status icon column: aligned with the title's first line. */
function StatusIcon({ children }: { children: ReactNode }) {
  return <span className="flex h-lh shrink-0 items-center">{children}</span>;
}

function RowLink({ link, prominent }: { link: ChecklistLink; prominent: boolean }) {
  if (prominent) {
    return (
      <LinkButton
        href={link.href}
        external={link.external}
        variant="secondary"
        size="sm"
        className="shrink-0"
      >
        {link.label}
      </LinkButton>
    );
  }
  return (
    <Text size="sm" as="span">
      {link.external ? (
        <Link href={link.href} target="_blank" rel="noopener noreferrer">
          {link.label}
          <Link.ExternalIcon />
        </Link>
      ) : (
        <Link href={link.href}>{link.label}</Link>
      )}
    </Text>
  );
}

/**
 * A row's text with its action: beside it from the `sm` breakpoint, under it
 * on a phone, so the text keeps its width.
 */
function RowBody({ action, children }: { action: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-start sm:gap-3">
      <div className="grid min-w-0 flex-1 gap-0.5">{children}</div>
      {action !== null && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/** A row that needs the admin: expanded, with its action beside it. */
function NeedsYouRow({ row }: { row: ChecklistRow }) {
  return (
    <li id={checklistRowAnchor(row)} className="flex items-start gap-3 py-3">
      <StatusIcon>
        <WarningCircleIcon weight="fill" className="text-kumo-warning" aria-label="Needs you" />
      </StatusIcon>
      <RowBody action={row.link === null ? null : <RowLink link={row.link} prominent />}>
        <Text bold>
          {row.label}
          <span className="font-normal text-kumo-subtle"> · {row.value}</span>
        </Text>
        <Text variant="secondary" size="sm">
          {rowLine(row)}
        </Text>
      </RowBody>
    </li>
  );
}

/** A done row: one line, a tick, what was found. */
function DoneRow({ row }: { row: ChecklistRow }) {
  return (
    <li id={checklistRowAnchor(row)} className="flex items-center gap-3 py-2">
      <StatusIcon>
        <CheckCircleIcon weight="fill" className="text-kumo-success" aria-label="Done" />
      </StatusIcon>
      <Text as="span">{row.label}</Text>
      <span className="ml-auto min-w-0 truncate text-right">
        <Text variant="secondary" size="sm" as="span">
          {row.value}
        </Text>
      </span>
    </li>
  );
}

/** An optional row: quieter, its action a text link or a small button. */
function OptionalRow({ row, enableNow }: { row: ChecklistRow; enableNow: ReactNode }) {
  return (
    <li id={checklistRowAnchor(row)} className="flex items-start gap-3 py-2.5">
      <StatusIcon>
        <CircleDashedIcon className="text-kumo-inactive" aria-label="Optional" />
      </StatusIcon>
      <RowBody action={row.action === "enable-sandbox" ? enableNow : null}>
        <Text as="span">
          {row.label}
          <span className="text-kumo-subtle"> · {row.value}</span>
        </Text>
        <Text variant="secondary" size="sm">
          {rowLine(row)}
        </Text>
        {row.link !== null && (
          <span>
            <RowLink link={row.link} prominent={false} />
          </span>
        )}
      </RowBody>
    </li>
  );
}

function Progress({ rows }: { rows: ChecklistRow[] }) {
  const { done, total } = checklistProgress(rows);
  const pending = needsYouCount(rows);
  return (
    <Meter
      label={
        pending === 0
          ? "Nothing here needs you"
          : `${pending} ${pending === 1 ? "item needs" : "items need"} you`
      }
      customValue={`${done} of ${total} done`}
      value={done}
      max={Math.max(total, 1)}
      getAriaValueText={() => `${done} of ${total} done`}
      trackClassName="h-1.5"
      indicatorClassName={
        pending === 0 ? "from-kumo-success via-kumo-success to-kumo-success" : undefined
      }
    />
  );
}

export function ChecklistBody({
  data,
  enableNow,
}: {
  data: ChecklistData;
  /** The "Enable now" control for the sandbox row; null for someone who cannot enable. */
  enableNow: ReactNode;
}) {
  const rows = buildChecklist(data);
  const { needsYou, done, optional } = groupChecklist(rows);
  return (
    <div className="grid gap-4">
      <Progress rows={rows} />
      <div className="grid gap-3">
        {needsYou.length + done.length > 0 && (
          <ul className="grid divide-y divide-kumo-hairline">
            {needsYou.map((row) => (
              <NeedsYouRow key={row.id} row={row} />
            ))}
            {done.map((row) => (
              <DoneRow key={row.id} row={row} />
            ))}
          </ul>
        )}
        {optional.length > 0 && (
          <section className="grid gap-1" aria-label="Optional">
            <Text variant="secondary" size="sm" as="h2">
              Optional, for more apps
            </Text>
            <ul className="grid divide-y divide-kumo-hairline">
              {optional.map((row) => (
                <OptionalRow key={row.id} row={row} enableNow={enableNow} />
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
