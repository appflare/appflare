import { Button, LayerCard, Link, Loader, Text } from "@cloudflare/kumo";
import { ArrowCircleUpIcon, CheckCircleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { startSelfUpdate } from "../catalog/manager-releases.functions";
import { MANAGER_UPDATES_HREF, type ManagerStatus } from "../installs/pending-updates";
import type { JobView } from "../jobs/jobs.functions";
import { useLiveJob, useVersionSwitch } from "../jobs/live-job";
import {
  type AppflareCardState,
  appflareCardState,
  type CardJob,
  UPDATED_TO_KEY,
} from "./appflare-card-state";

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
      // Storage blocked: the card shows the version without "Updated".
    }
  }, []);
  return updatedTo;
}

/**
 * The bottom of the sidebar, above the account menu: Appflare's own
 * version. Quiet while it is up to date; when a newer release is known, a
 * card with the version and, for admins, "Update", which starts the
 * self-update right here. The card then follows the job (its newest log
 * line), waits for the new version to answer, and reloads the page onto it;
 * a failure is shown in the card with a link to the log. The self-update's
 * details and the automatic-update setting stay on Settings, Appflare updates.
 */
export function AppflareCard({ manager, isAdmin }: { manager: ManagerStatus; isAdmin: boolean }) {
  const [jobId, setJobId] = useState<string | null>(manager.activeJobId);
  useEffect(() => {
    // A self-update started elsewhere (Settings, the cron) shows here too.
    if (manager.activeJobId !== null) setJobId(manager.activeJobId);
  }, [manager.activeJobId]);
  const job = useLiveJob(jobId, jobId === null ? null : undefined);
  const onArrived = useCallback((version: string) => {
    try {
      window.sessionStorage.setItem(UPDATED_TO_KEY, version);
    } catch {
      // Storage blocked: the reloaded page shows the version without "Updated".
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
    isAdmin,
  });
  return (
    <CardBody
      state={state}
      jobId={jobId}
      starting={starting}
      error={error}
      onUpdate={(version) => void onUpdate(version)}
    />
  );
}

function CardBody({
  state,
  jobId,
  starting,
  error,
  onUpdate,
}: {
  state: AppflareCardState;
  jobId: string | null;
  starting: boolean;
  error: string | null;
  onUpdate(version: string): void;
}) {
  if (state.kind === "current" || state.kind === "updated") {
    return (
      <div className="flex min-w-0 items-center gap-2 px-2">
        {state.kind === "updated" && (
          <CheckCircleIcon weight="fill" className="shrink-0 text-kumo-success" />
        )}
        <Text size="sm" variant="secondary" truncate>
          <Link href={MANAGER_UPDATES_HREF} variant="plain" className="text-inherit">
            {state.kind === "updated" ? "Updated to Appflare" : "Appflare"}{" "}
            <span className="font-mono text-[0.9em]">{state.version}</span>
          </Link>
        </Text>
      </div>
    );
  }
  const logLink =
    jobId === null ? null : (
      <Link href={`/jobs/${jobId}`} variant="inline">
        View log
      </Link>
    );
  return (
    <LayerCard>
      <LayerCard.Primary className="grid gap-2 px-3 py-2.5 whitespace-normal">
        {state.kind === "available" && (
          <>
            <div className="grid gap-0.5">
              <Text bold>Appflare {state.latest} is available</Text>
              <Text size="sm" variant="secondary">
                Running {state.current}
              </Text>
            </div>
            {state.canUpdate && (
              <Button
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
                {state.error ?? "The current version keeps serving."}
              </Text>
            </div>
            {logLink}
            {state.retry !== null && (
              <Button
                size="sm"
                variant="secondary"
                icon={<ArrowCircleUpIcon />}
                loading={starting}
                onClick={() => state.retry !== null && onUpdate(state.retry)}
              >
                Try again
              </Button>
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
  );
}
