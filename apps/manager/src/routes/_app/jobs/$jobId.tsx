import { Badge, Banner, Empty, LayerCard, LinkButton, Loader, Table, Text } from "@cloudflare/kumo";
import { ArrowRightIcon, ListChecksIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { createFileRoute } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { formatDateTime, formatTime } from "../../../components/format";
import { PageHeader } from "../../../components/page-header";
import { StatusBadge } from "../../../components/status-badge";
import { getJob, type JobLogRow, type JobView } from "../../../jobs/jobs.functions";

/** How often the page re-reads a queued or running job. */
const POLL_MS = 2000;

const KIND_LABELS: Record<string, string> = {
  install: "Install",
  update: "Update",
  uninstall: "Uninstall",
  rollback: "Rollback",
  self_update: "Appflare update",
};

function isActive(job: JobView | null): boolean {
  return job !== null && (job.status === "queued" || job.status === "running");
}

/** `/jobs/$jobId`: the live job log. */
export const Route = createFileRoute("/_app/jobs/$jobId")({
  loader: ({ params }) => getJob({ data: { jobId: params.jobId } }),
  component: JobPage,
});

/**
 * Polls `getJob` every 2 s while the job is queued or running and stops once it
 * has finished (the free plan allows 100k requests a day).
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
        if (!cancelled) setJob(next);
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

  const kind = KIND_LABELS[job.kind] ?? job.kind;
  const title = job.install !== null ? `${kind} ${job.install.slug}` : kind;
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
            <Row label="Started">{formatDateTime(job.startedAt)}</Row>
            <Row label="Finished">{formatDateTime(job.finishedAt)}</Row>
          </dl>
        </LayerCard.Primary>
      </LayerCard>
      {job.status === "failed" && job.error !== null && (
        <Banner
          variant="error"
          icon={<WarningCircleIcon weight="fill" />}
          title="The job failed"
          description={job.error}
        />
      )}
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
