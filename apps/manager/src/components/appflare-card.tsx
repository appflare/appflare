import { Button, LayerCard, Link, Loader, Sidebar, Text } from "@cloudflare/kumo";
import {
  ArrowCircleUpIcon,
  CheckCircleIcon,
  WarningCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { startSelfUpdate } from "../catalog/manager-releases.functions";
import { MANAGER_UPDATES_HREF, type ManagerStatus } from "../installs/pending-updates";
import type { JobView } from "../jobs/jobs.functions";
import { POLL_MS, useLiveJob, useVersionSwitch } from "../jobs/live-job";
import {
  type AppflareCardState,
  type AppflareRailItem,
  appflareCardState,
  appflareRailItem,
  type CardJob,
  UPDATED_CARD_MS,
  UPDATED_TO_KEY,
} from "./appflare-card-state";
import { SendReportButton } from "./job-report-dialog";
import { MessageText } from "./message-text";

/** Log lines and errors can hold long URLs: wrap anywhere, and show at most four lines. */
const clamp = "line-clamp-4 [overflow-wrap:anywhere]";

function cardJob(job: JobView | null | undefined): CardJob | null | undefined {
  if (job == null) return job;
  return {
    status: job.status,
    targetVersion: job.targetVersion,
    error: job.error,
    lastStep: job.logs.at(-1)?.message ?? null,
  };
}

/** Reads (once) the version the previous page saw Appflare switch to, and forgets it. */
function useUpdatedTo(): string | null {
  const [updatedTo, setUpdatedTo] = useState<string | null>(null);
  useEffect(() => {
    try {
      const value = window.sessionStorage.getItem(UPDATED_TO_KEY);
      window.sessionStorage.removeItem(UPDATED_TO_KEY);
      setUpdatedTo(value);
    } catch {
      // Storage blocked: no "updated" card; the footer shows the new version.
    }
  }, []);
  return updatedTo;
}

/**
 * Ends the "updated" card (while `version` is the one it announces) at the
 * first health poll that finds that version answering, or after
 * UPDATED_CARD_MS, whichever comes first. The sidebar stays mounted across
 * pages, so without this the card would stay until the next reload.
 */
function useUpdatedCardTimeout(version: string | null, onDone: () => void): void {
  useEffect(() => {
    if (version === null) return;
    let cancelled = false;
    const done = () => {
      if (!cancelled) onDone();
    };
    const timeout = setTimeout(done, UPDATED_CARD_MS);
    const poll = setInterval(async () => {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        const body = (await res.json()) as { version?: unknown };
        if (body.version === version) done();
      } catch {
        // Unreachable for now; the next poll or the timeout ends the card.
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
      clearInterval(poll);
    };
  }, [version, onDone]);
}

/**
 * The footer's Appflare version, next to the account menu: muted, blue on
 * hover, linking to Settings, Updates.
 */
export function AppflareVersion({ version }: { version: string }) {
  return (
    <Text variant="secondary" truncate>
      {/* `text-kumo-subtle` wins over the plain variant's colour at rest; its hover colour stays. */}
      <Link href={MANAGER_UPDATES_HREF} variant="plain" className="text-kumo-subtle">
        {/* Plain text: a smaller monospace span sat above the baseline in Kumo's inline-flex Link. */}
        Appflare {version}
      </Link>
    </Text>
  );
}

const RAIL_ICONS: Record<AppflareRailItem["tone"], ReactNode> = {
  success: <CheckCircleIcon weight="fill" className="size-4 shrink-0 text-kumo-success" />,
  update: <ArrowCircleUpIcon weight="fill" className="size-4 shrink-0 text-kumo-link" />,
  progress: <Loader size="sm" />,
  warning: <WarningCircleIcon weight="fill" className="size-4 shrink-0 text-kumo-warning" />,
  danger: <WarningCircleIcon weight="fill" className="size-4 shrink-0 text-kumo-danger" />,
};

/** The card in the folded sidebar: a menu button whose tooltip carries the message. */
function RailItem({ item }: { item: AppflareRailItem }) {
  return (
    <div className="shrink-0 px-[11px] pb-2">
      <Sidebar.Menu>
        <Sidebar.MenuButton href={item.href} icon={RAIL_ICONS[item.tone]} tooltip={item.label}>
          {item.label}
        </Sidebar.MenuButton>
      </Sidebar.Menu>
    </div>
  );
}

/**
 * The bottom of the sidebar, above the footer: Appflare's own update. No
 * card while Appflare is up to date (the footer shows the version). When a
 * newer release is known, a card with the version and, for admins,
 * "Update", which starts the self-update right here. The card then follows
 * the job (its newest log line), waits for the new version to answer, and
 * reloads the page onto it; the reloaded page says it was updated (until
 * dismissed, the next health poll, or 30 seconds), and a failure is shown in
 * the card with a link to the log. The self-update's
 * details and the automatic-update setting stay on Settings, Updates.
 * In the folded sidebar (`collapsed`) the card is one icon with its message
 * as a tooltip, linking to the job's log or to Settings, Updates;
 * it keeps following the job, so the page still reloads onto a new version.
 */
export function AppflareCard({
  manager,
  isAdmin,
  collapsed = false,
}: {
  manager: ManagerStatus;
  isAdmin: boolean;
  collapsed?: boolean;
}) {
  const [jobId, setJobId] = useState<string | null>(manager.activeJobId);
  const [updatedDone, setUpdatedDone] = useState(false);
  const endUpdated = useCallback(() => setUpdatedDone(true), []);
  useEffect(() => {
    // A self-update started elsewhere (Settings, the cron) shows here too.
    if (manager.activeJobId !== null) {
      setJobId(manager.activeJobId);
      setUpdatedDone(false);
    }
  }, [manager.activeJobId]);
  const job = useLiveJob(jobId, jobId === null ? null : undefined);
  const onArrived = useCallback((version: string) => {
    try {
      window.sessionStorage.setItem(UPDATED_TO_KEY, version);
    } catch {
      // Storage blocked: the reloaded page shows no "updated" card, only the footer's version.
    }
  }, []);
  const { switching, stalled } = useVersionSwitch(job, {
    clientVersion: manager.current,
    onArrived,
  });
  const updatedTo = useUpdatedTo();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onUpdate(version: string) {
    setStarting(true);
    setError(null);
    try {
      const started = await startSelfUpdate({ data: { version } });
      setJobId(started.jobId);
      setUpdatedDone(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the update.");
    }
    setStarting(false);
  }

  const state = appflareCardState({
    manager,
    job: cardJob(job),
    switching,
    stalled,
    updatedTo,
    updatedDone,
    isAdmin,
  });
  useUpdatedCardTimeout(state.kind === "updated" ? state.version : null, endUpdated);
  if (collapsed) {
    const item = appflareRailItem(state, jobId, MANAGER_UPDATES_HREF);
    return item === null ? null : <RailItem item={item} />;
  }
  return (
    <CardBody
      state={state}
      jobId={jobId}
      starting={starting}
      error={error}
      onUpdate={(version) => void onUpdate(version)}
      onDismiss={endUpdated}
      isAdmin={isAdmin}
      reportedAt={job?.reportedAt ?? null}
    />
  );
}

function CardBody({
  state,
  jobId,
  starting,
  error,
  onUpdate,
  onDismiss,
  isAdmin,
  reportedAt,
}: {
  state: AppflareCardState;
  jobId: string | null;
  starting: boolean;
  error: string | null;
  onUpdate(version: string): void;
  onDismiss(): void;
  isAdmin: boolean;
  /** When the followed job's failure was reported to the Appflare team. */
  reportedAt: string | null;
}) {
  // Up to date: no card; the footer shows the version (AppflareVersion).
  if (state.kind === "current") return null;
  const logLink =
    jobId === null ? null : (
      <Link href={`/jobs/${jobId}`} variant="inline">
        View log
      </Link>
    );
  return (
    // The wrapper holds the sidebar's inset: a layered LayerCard is `w-full`,
    // so a margin on the card itself pushed it past the sidebar's right edge.
    <div className="shrink-0 px-3 pb-3">
      <LayerCard>
        <LayerCard.Primary className="grid gap-2 px-3 py-2.5 whitespace-normal">
          {state.kind === "updated" && (
            <div className="flex items-center gap-2">
              <CheckCircleIcon weight="fill" className="shrink-0 text-kumo-success" />
              <Text bold>Appflare updated to {state.version}</Text>
              <Button
                className="ml-auto"
                shape="square"
                size="sm"
                variant="ghost"
                icon={XIcon}
                aria-label="Dismiss"
                title="Dismiss"
                onClick={onDismiss}
              />
            </div>
          )}
          {state.kind === "available" && (
            <>
              {/* No "running" line: the footer right below shows the current version. */}
              <Text bold>Appflare {state.latest} is available</Text>
              {state.canUpdate && (
                <Button
                  className="justify-self-start"
                  size="sm"
                  variant="primary"
                  icon={<ArrowCircleUpIcon />}
                  loading={starting}
                  onClick={() => onUpdate(state.latest)}
                >
                  Update
                </Button>
              )}
            </>
          )}
          {(state.kind === "running" || state.kind === "switching") && (
            <>
              <div className="flex items-center gap-2">
                <Loader size="sm" />
                <Text bold>
                  {state.kind === "running" ? "Updating" : "Switching"} to {state.target}
                </Text>
              </div>
              <div className={clamp}>
                <Text size="sm" variant="secondary">
                  {state.kind === "switching"
                    ? "This page reloads once the new version answers."
                    : (state.step ?? "Starting…")}
                </Text>
              </div>
              {logLink}
            </>
          )}
          {state.kind === "stalled" && (
            <>
              <div className="flex items-center gap-2">
                <WarningCircleIcon weight="fill" className="shrink-0 text-kumo-warning" />
                <Text bold>Updated to {state.target}</Text>
              </div>
              <Text size="sm" variant="secondary">
                The new version did not answer yet.{" "}
                <Link
                  href="#"
                  variant="inline"
                  onClick={(event) => {
                    event.preventDefault();
                    window.location.reload();
                  }}
                >
                  Reload
                </Link>
              </Text>
              {logLink}
            </>
          )}
          {state.kind === "failed" && (
            <>
              <div className="flex items-center gap-2">
                <WarningCircleIcon weight="fill" className="shrink-0 text-kumo-danger" />
                <Text bold>Update to {state.target} failed</Text>
              </div>
              <div className={clamp}>
                <Text size="sm" variant="secondary">
                  {state.error === null ? (
                    "The current version keeps serving."
                  ) : (
                    <MessageText message={state.error} />
                  )}
                </Text>
              </div>
              {logLink}
              {state.retry !== null && (
                <Button
                  className="justify-self-start"
                  size="sm"
                  variant="secondary"
                  icon={<ArrowCircleUpIcon />}
                  loading={starting}
                  onClick={() => state.retry !== null && onUpdate(state.retry)}
                >
                  Try again
                </Button>
              )}
              {isAdmin && jobId !== null && (
                <div className="justify-self-start">
                  <SendReportButton jobId={jobId} reportedAt={reportedAt} />
                </div>
              )}
            </>
          )}
          {error !== null && (
            <Text size="sm" variant="error">
              {error}
            </Text>
          )}
        </LayerCard.Primary>
      </LayerCard>
    </div>
  );
}
