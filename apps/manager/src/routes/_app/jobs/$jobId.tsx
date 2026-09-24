import { Badge, Banner, Empty, LayerCard, LinkButton, Loader, Table, Text } from "@cloudflare/kumo";
import {
  ArrowRightIcon,
  ArrowsClockwiseIcon,
  ListChecksIcon,
  ShippingContainerIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { createFileRoute } from "@tanstack/react-router";
import { startedByLabel } from "../../../auto-update/auto-update";
import { DescriptionItem, DescriptionList } from "../../../components/description-list";
import { DocsLink } from "../../../components/docs-link";
import { formatTime, jobKindLabel } from "../../../components/format";
import { PageHeader } from "../../../components/page-header";
import { Section } from "../../../components/section";
import { StatusBadge } from "../../../components/status-badge";
import { Timestamp } from "../../../components/timestamp";
import { jobFailureTopic } from "../../../docs-topics";
import { installLabel } from "../../../installs/display-name";
import { type BuildProgressView, getJob, type JobLogRow } from "../../../jobs/jobs.functions";
import { isActive, useLiveJob, useVersionSwitch } from "../../../jobs/live-job";

const JOBS_CRUMB = { label: "Jobs", href: "/jobs" };

/** `/jobs/$jobId`: the live job log. */
export const Route = createFileRoute("/_app/jobs/$jobId")({
  staticData: { title: "Job" },
  loader: ({ params }) => getJob({ data: { jobId: params.jobId } }),
  component: JobPage,
});

function JobPage() {
  const { jobId } = Route.useParams();
  const job = useLiveJob(jobId, Route.useLoaderData()) ?? null;
  const { switching } = useVersionSwitch(job);

  if (job === null) {
    return (
      <>
        <PageHeader title="Job not found" parents={[JOBS_CRUMB]} />
        <Empty
          icon={<ListChecksIcon size={48} className="text-kumo-inactive" />}
          title="No such job"
          description="The link may be wrong."
        />
      </>
    );
  }

  const kind = jobKindLabel(job);
  const failureTopic = jobFailureTopic(job);
  const title = job.install !== null ? `${kind} ${installLabel(job.install)}` : kind;
  return (
    <>
      <PageHeader
        title={title}
        description={`Job ${job.id}`}
        parents={[JOBS_CRUMB]}
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
          <DescriptionList>
            {job.install !== null && (
              <DescriptionItem label="Worker">
                <span className="font-mono text-[0.9em]">{job.install.workerName}</span>
              </DescriptionItem>
            )}
            {job.targetVersion !== null && (
              <DescriptionItem label="Appflare version">
                <span className="font-mono text-[0.9em]">{job.targetVersion}</span>
              </DescriptionItem>
            )}
            {job.workerVersionId !== null && (
              <DescriptionItem
                label={
                  job.kind === "update" || job.kind === "self_update" || job.kind === "reconfigure"
                    ? "New Worker version"
                    : "Worker version"
                }
              >
                <span className="font-mono text-[0.9em]">{job.workerVersionId}</span>
              </DescriptionItem>
            )}
            <DescriptionItem label="Started by">{startedByLabel(job.startedBy)}</DescriptionItem>
            <DescriptionItem label="Started">
              <Timestamp iso={job.startedAt} />
            </DescriptionItem>
            <DescriptionItem label="Finished">
              <Timestamp iso={job.finishedAt} />
            </DescriptionItem>
          </DescriptionList>
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
          action={
            failureTopic === null ? undefined : <DocsLink topic={failureTopic} variant="inline" />
          }
        />
      )}
      {job.build !== null && <BuildProgress build={job.build} />}
      <Section title="Log">
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
      </Section>
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
          {build.kind === "installer"
            ? "Running the app's installer in your sandbox Worker"
            : "Building in your sandbox Worker"}
        </span>
        <div className="flex items-center gap-2">
          <Loader size="sm" />
          <Badge variant="info">{build.stage}</Badge>
        </div>
      </LayerCard.Secondary>
      <LayerCard.Primary className="grid gap-2 px-5 py-4">
        <Text variant="secondary" size="sm">
          Last output at {formatTime(build.updatedAt)}. The end of the output goes to the log below
          when the {build.kind === "installer" ? "run" : "build"} ends.
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
