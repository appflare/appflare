import { Badge, Banner, Empty, LayerCard, LinkButton, Loader, Table, Text } from "@cloudflare/kumo";
import {
  ArrowRightIcon,
  ArrowsClockwiseIcon,
  ListChecksIcon,
  ShippingContainerIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { createFileRoute } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { compareVersions } from "../../../catalog/versions";
import { formatDateTime, formatTime, jobKindLabel } from "../../../components/format";
import { PageHeader } from "../../../components/page-header";
import { StatusBadge } from "../../../components/status-badge";
import {
  type BuildProgressView,
  getJob,
  type JobLogRow,
  type JobView,
} from "../../../jobs/jobs.functions";

/** How often the page re-reads a queued or running job. */
const POLL_MS = 2000;

function isActive(job: JobView | null): boolean {
  return job !== null && (job.status === "queued" || job.status === "running");
}

/** `/jobs/$jobId`: the live job log. */
export const Route = createFileRoute("/_app/jobs/$jobId")({
  staticData: { title: "Job" },
  loader: ({ params }) => getJob({ data: { jobId: params.jobId } }),
  component: JobPage,
});

/**
 * Polls `getJob` every 2 s while the job is queued or running and stops once it
 * has finished (the free plan allows 100k requests a day). A failed poll (for
 * example a 5xx or 404 while Appflare switches versions) is retried on the next
 * tick; an answer without the job never replaces the job already shown.
 */
function useLiveJob(jobId: string, initial: JobView | null): JobView | null {
  const [job, setJob] = useState(initial);
  useEffect(() => setJob(initial), [initial]);
  const active = isActive(job);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const next = await getJob({ data: { jobId } });
        if (!cancelled && next !== null) setJob(next);
      } catch {
        // A missed poll is retried on the next tick.
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [jobId, active]);
  return job;
}

/** A finished self-update's page stops watching for the switch after this long. */
const SWITCH_WATCH_MS = 5 * 60 * 1000;

/**
 * A self-update replaces the code serving this page. Polls `/api/health` (a
 * plain URL every version serves, unlike server functions, whose ids change
 * between builds) while the job runs, and after it succeeded until a version
 * at least as new as the target answers (at most a few minutes). Reports
 * whether an older version still answers. When the target version starts
 * answering after an older one did, the page reloads once to load the new
 * version's client.
 */
function useVersionSwitch(job: JobView | null): { switching: boolean } {
  const target = job?.kind === "self_update" ? job.targetVersion : null;
  const [seen, setSeen] = useState<string | null>(null);
  const [sawOlder, setSawOlder] = useState(false);
  /** The answering version is the target or newer (or cannot be compared). */
  const arrived = seen !== null && target !== null && (compareVersions(seen, target) ?? 0) >= 0;
  const recentlyFinished =
    job?.finishedAt == null || Date.now() - new Date(job.finishedAt).getTime() < SWITCH_WATCH_MS;
  const watching =
    target !== null &&
    job !== null &&
    (isActive(job) || (job.status === "succeeded" && recentlyFinished && !arrived));
  useEffect(() => {
    if (!watching || target === null) return;
    let cancelled = false;
    async function check() {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        const body = (await res.json()) as { version?: unknown };
        if (cancelled || typeof body.version !== "string") return;
        const version = body.version;
        setSeen(version);
        if ((compareVersions(version, target ?? version) ?? 0) < 0) setSawOlder(true);
      } catch {
        // Unreachable during the switch; the next tick retries.
      }
    }
    void check();
    const timer = setInterval(check, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [watching, target]);
  useEffect(() => {
    if (arrived && sawOlder && job?.status !== "failed") window.location.reload();
  }, [arrived, sawOlder, job?.status]);
  return { switching: watching && seen !== null && !arrived };
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <Text as="dt" variant="secondary">
        {label}
      </Text>
      <Text as="dd">{children}</Text>
    </>
  );
}

function JobPage() {
  const { jobId } = Route.useParams();
  const job = useLiveJob(jobId, Route.useLoaderData());
  const { switching } = useVersionSwitch(job);

  if (job === null) {
    return (
      <>
        <PageHeader title="Job" />
        <Empty
          icon={<ListChecksIcon size={48} className="text-kumo-inactive" />}
          title="No such job"
          description="The link may be wrong."
        />
      </>
    );
  }

  const kind = jobKindLabel(job.kind, job.restore);
  const title =
    job.install !== null ? `${kind} ${job.install.instanceName ?? job.install.workerName}` : kind;
  return (
    <>
      <PageHeader
        title={title}
        description={`Job ${job.id}`}
        actions={
          job.install !== null ? (
            <LinkButton
              href={`/apps/${job.install.id}`}
              variant="secondary"
              icon={<ArrowRightIcon />}
            >
              View install
            </LinkButton>
          ) : undefined
        }
      />
      <LayerCard>
        <LayerCard.Secondary className="flex items-center justify-between gap-3">
          <span>Status</span>
          <div className="flex items-center gap-2">
            {isActive(job) && <Loader size="sm" />}
            <StatusBadge status={job.status} of="job" />
          </div>
        </LayerCard.Secondary>
        <LayerCard.Primary className="px-5 py-4">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2">
            {job.install !== null && (
              <Row label="Worker">
                <span className="font-mono text-[0.9em]">{job.install.workerName}</span>
              </Row>
            )}
            {job.targetVersion !== null && (
              <Row label="Appflare version">
                <span className="font-mono text-[0.9em]">{job.targetVersion}</span>
              </Row>
            )}
            {job.workerVersionId !== null && (
              <Row
                label={
                  job.kind === "update" || job.kind === "self_update"
                    ? "New Worker version"
                    : "Worker version"
                }
              >
                <span className="font-mono text-[0.9em]">{job.workerVersionId}</span>
              </Row>
            )}
            <Row label="Started">{formatDateTime(job.startedAt)}</Row>
            <Row label="Finished">{formatDateTime(job.finishedAt)}</Row>
          </dl>
        </LayerCard.Primary>
      </LayerCard>
      {switching && (
        <Banner
          variant="secondary"
          icon={<ArrowsClockwiseIcon />}
          title="Appflare is switching versions…"
          description={`The current version keeps serving until ${job.targetVersion ?? "the new version"} has passed its checks and takes over. This page reloads once it answers.`}
        />
      )}
      {job.status === "failed" && job.error !== null && (
        <Banner
          variant="error"
          icon={<WarningCircleIcon weight="fill" />}
          title="The job failed"
          description={job.error}
        />
      )}
      {job.build !== null && <BuildProgress build={job.build} />}
      <section className="grid gap-3">
        <Text variant="heading" as="h2">
          Log
        </Text>
        {job.logs.length === 0 ? (
          <Text variant="secondary">
            {isActive(job) ? "Waiting for the first step…" : "No log lines were written."}
          </Text>
        ) : (
          <LayerCard className="p-0">
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Time</Table.Head>
                  <Table.Head>Level</Table.Head>
                  <Table.Head>Message</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {job.logs.map((line) => (
                  <LogRow key={line.id} line={line} />
                ))}
              </Table.Body>
            </Table>
          </LayerCard>
        )}
      </section>
    </>
  );
}

/** Live output of the sandbox build the job waits on; the job log gets it when the build ends. */
function BuildProgress({ build }: { build: BuildProgressView }) {
  return (
    <LayerCard>
      <LayerCard.Secondary className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2">
          <ShippingContainerIcon aria-hidden />
          Building in your sandbox Worker
        </span>
        <div className="flex items-center gap-2">
          <Loader size="sm" />
          <Badge variant="info">{build.stage}</Badge>
        </div>
      </LayerCard.Secondary>
      <LayerCard.Primary className="grid gap-2 px-5 py-4">
        <Text variant="secondary" size="sm">
          Last output at {formatTime(build.updatedAt)}. The end of the output goes to the log below
          when the build ends.
        </Text>
        <div className="grid gap-0.5 overflow-x-auto">
          {build.lines.length === 0 ? (
            <Text variant="mono-secondary">No output yet.</Text>
          ) : (
            build.lines.map((line, i) => (
              // Output lines are not unique; they only ever render in order.
              // biome-ignore lint/suspicious/noArrayIndexKey: display-only list in output order
              <Text key={i} variant="mono-secondary">
                {line.length > 0 ? line : " "}
              </Text>
            ))
          )}
        </div>
      </LayerCard.Primary>
    </LayerCard>
  );
}

const LEVEL_VARIANT: Record<string, "neutral" | "info" | "warning" | "error"> = {
  debug: "neutral",
  info: "info",
  warn: "warning",
  error: "error",
};

function LogRow({ line }: { line: JobLogRow }) {
  return (
    <Table.Row>
      <Table.Cell className="align-top whitespace-nowrap">
        <Text as="time" variant="secondary" size="sm">
          {formatTime(line.ts)}
        </Text>
      </Table.Cell>
      <Table.Cell className="align-top">
        <Badge variant={LEVEL_VARIANT[line.level] ?? "neutral"}>{line.level}</Badge>
      </Table.Cell>
      <Table.Cell className="align-top">
        <div className="grid gap-1">
          <Text>{line.message}</Text>
          {line.requests.map((r, i) => (
            // Request lines are not unique (the same call may repeat).
            // biome-ignore lint/suspicious/noArrayIndexKey: display-only list in log order
            <Text key={i} variant="mono-secondary">
              {r}
            </Text>
          ))}
          {line.detail !== null && <Text variant="mono-secondary">{line.detail}</Text>}
        </div>
      </Table.Cell>
    </Table.Row>
  );
}
