import { Button, cn, Link, LinkButton, Loader, Meter, Text } from "@cloudflare/kumo";
import {
  CheckCircleIcon,
  CircleDashedIcon,
  InfoIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { Tooltip } from "../components/tooltip";
import {
  buildChecklist,
  type ChecklistLink,
  type ChecklistRow,
  type ChecklistStatus,
  checklistProgress,
  checklistRowAnchor,
  groupChecklist,
  needsYouCount,
  rowHelp,
} from "./checklist";
import type { ChecklistData } from "./checklist.server";

/**
 * How the onboarding checklist looks, the same in the last setup step and on
 * Settings › Account and capabilities: progress (rows done out of the rows
 * that count), then every row as one line of the same height (status icon,
 * title with a help tooltip, a short value, the action on the right). Rows
 * that need the admin come first, then the done ones, then the optional
 * ones, quieter, under their own heading. Presentational only;
 * `onboarding-checklist.tsx` wires Re-check and "Enable now".
 */

const STATUS_ICONS: Record<ChecklistStatus, ReactNode> = {
  "needs-you": (
    <WarningCircleIcon weight="fill" className="text-kumo-warning" aria-label="Needs you" />
  ),
  done: <CheckCircleIcon weight="fill" className="text-kumo-success" aria-label="Done" />,
  optional: <CircleDashedIcon className="text-kumo-inactive" aria-label="Optional" />,
};

/** The row's action as a link: a small button when the row needs the admin, else a text link. */
function RowLink({ link, prominent }: { link: ChecklistLink; prominent: boolean }) {
  if (prominent) {
    return (
      <LinkButton href={link.href} external={link.external} variant="secondary" size="sm">
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

/** The help icon beside a title: the value in full, then what it means and why it matters. */
function RowHelp({ row }: { row: ChecklistRow }) {
  return (
    <Tooltip
      content={
        <>
          <strong className="font-medium">{row.value}.</strong> {rowHelp(row)}
        </>
      }
      render={
        <Button
          variant="ghost"
          size="xs"
          shape="square"
          icon={<InfoIcon />}
          aria-label={`About ${row.label}`}
          className="shrink-0 text-kumo-subtle"
        />
      }
    />
  );
}

/**
 * One row, one line, the same height whatever it holds. The title keeps its
 * width; the value gives way first (ellipsis; the help tooltip starts with
 * it in full).
 */
function Row({ row, action }: { row: ChecklistRow; action: ReactNode }) {
  const secondary = row.status === "optional";
  return (
    <li id={checklistRowAnchor(row)} className="flex h-11 min-w-0 items-center gap-3">
      <span className="flex shrink-0 items-center">{STATUS_ICONS[row.status]}</span>
      <span className="flex min-w-0 flex-1 items-center gap-1">
        <span className="min-w-0 shrink-0 truncate">
          <Text
            as="span"
            truncate
            bold={row.status === "needs-you"}
            variant={secondary ? "secondary" : "body"}
          >
            {row.label}
          </Text>
        </span>
        <RowHelp row={row} />
        <span
          className={cn(
            // The value gives way long before the title does.
            "ml-auto min-w-0 shrink-[1000] truncate pl-2 text-right",
            // On a phone a row with an action says it with the action; the
            // value stays in the help tooltip.
            action !== null && "hidden sm:block",
          )}
        >
          <Text variant="secondary" size="sm" as="span">
            {row.value}
          </Text>
        </span>
      </span>
      {action !== null && <span className="flex shrink-0 items-center">{action}</span>}
    </li>
  );
}

/** What the short "Enabling…" status stands for. */
const ENABLING_MORE =
  "Turning sandbox builds on takes about two minutes. You can go on meanwhile; the link opens the job's log.";

/**
 * An enable in progress: a spinner and "Enabling…", linked to the job's log,
 * with the rest in a tooltip. The same after "Enable now" and after a reload.
 */
export function EnablingStatus({ jobId }: { jobId: string }) {
  return (
    <Tooltip
      content={ENABLING_MORE}
      render={
        <span role="status" className="flex items-center gap-1.5">
          <Loader size="sm" />
          <Text size="sm" as="span">
            <Link href={`/jobs/${jobId}`}>Enabling…</Link>
          </Text>
          <span className="sr-only">{ENABLING_MORE}</span>
        </span>
      }
    />
  );
}

/** The job id in a row's link to `/jobs/<id>`. */
function jobIdOf(link: ChecklistLink | null): string | null {
  const match = link?.href.match(/^\/jobs\/([^/?#]+)$/);
  return match?.[1] ?? null;
}

/** The action a row shows: its link, or "Enable now" (admins only) on the sandbox row. */
function actionOf(row: ChecklistRow, enableNow: ReactNode): ReactNode {
  if (row.action === "enable-sandbox") return enableNow;
  if (row.action === "enabling") {
    const jobId = jobIdOf(row.link);
    return jobId === null ? null : <EnablingStatus jobId={jobId} />;
  }
  // Done rows need nothing; their dashboard link would only repeat the tick.
  if (row.link === null || row.status === "done") return null;
  return <RowLink link={row.link} prominent={row.status === "needs-you"} />;
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

function RowList({ rows, enableNow }: { rows: ChecklistRow[]; enableNow: ReactNode }) {
  return (
    // Rows never wrap, so the grid must let them shrink below their text width.
    <ul className="grid min-w-0 grid-cols-[minmax(0,1fr)] divide-y divide-kumo-hairline">
      {rows.map((row) => (
        <Row key={row.id} row={row} action={actionOf(row, enableNow)} />
      ))}
    </ul>
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
    <div className="grid min-w-0 gap-4">
      <Progress rows={rows} />
      <div className="grid min-w-0 gap-3">
        {needsYou.length + done.length > 0 && (
          <RowList rows={[...needsYou, ...done]} enableNow={enableNow} />
        )}
        {optional.length > 0 && (
          <section className="grid min-w-0 gap-0.5" aria-label="Optional">
            <Text variant="secondary" size="sm" as="h2">
              Optional, for more apps
            </Text>
            <RowList rows={optional} enableNow={enableNow} />
          </section>
        )}
      </div>
    </div>
  );
}
