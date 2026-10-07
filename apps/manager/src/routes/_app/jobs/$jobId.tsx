import { AppflareLoader } from "@appflare/brand/loader";
import { Badge, Banner, Code, Empty, LinkButton, Table, Text } from "@cloudflare/kumo";
import {
  ArrowCounterClockwiseIcon,
  ArrowRightIcon,
  GitBranchIcon,
  ListChecksIcon,
} from "@phosphor-icons/react";
import { createFileRoute } from "@tanstack/react-router";
import { useLayoutEffect, useRef } from "react";
import { startedByLabel } from "../../../auto-update/auto-update";
import { DescriptionItem, DescriptionList } from "../../../components/description-list";
import { DocsLink } from "../../../components/docs-link";
import { TechnicalNamesSwitch, useShowTechnicalNames } from "../../../components/field-label";
import { formatTime, jobKindLabel } from "../../../components/format";
import { SendReportButton } from "../../../components/job-report-dialog";
import {
  ACTIONS_UNDER_ON_PHONE,
  BANNER_ICON,
  BannerActions,
  bannerRole,
  MessageText,
  TechnicalDetails,
} from "../../../components/message-text";
import { OpenAppButton } from "../../../components/open-app-button";
import { PageHeader } from "../../../components/page-header";
import { Section, SectionBody, SectionEmpty, SectionTable } from "../../../components/section";
import { SeedCredentialsCard } from "../../../components/seed-credentials-card";
import { StatusBadge } from "../../../components/status-badge";
import { Timestamp } from "../../../components/timestamp";
import { jobFailureTopic } from "../../../docs-topics";
import { jobFailureHeadline, jobFailureLine } from "../../../jobs/job-failure-copy";
import {
  type BuildProgressView,
  getJob,
  type JobLogRow,
  type JobView,
} from "../../../jobs/jobs.functions";
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
  const { viewer } = Route.useRouteContext();
  const isAdmin = viewer.role === "admin";
  // Technical detail such as the Worker's name and its version's id shows on request.
  const [showNames] = useShowTechnicalNames();

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
  const title = job.install !== null ? `${kind} ${job.install.label}` : kind;
  return (
    <>
      <PageHeader
        title={title}
        description={`Job ${job.id}`}
        parents={[JOBS_CRUMB]}
        actions={
          job.install !== null ? (
            <>
              {job.install.address !== null && (
                <OpenAppButton href={job.install.address} label={job.install.label} />
              )}
              <LinkButton
                href={`/apps/${job.install.id}`}
                variant="secondary"
                icon={<ArrowRightIcon />}
              >
                View install
              </LinkButton>
            </>
          ) : undefined
        }
      />
      <Section
        title="Status"
        badge={
          <span className="flex items-center gap-2">
            {isActive(job) && <AppflareLoader size="sm" />}
            <StatusBadge status={job.status} of="job" />
          </span>
        }
        action={
          job.install === null && job.workerVersionId === null ? null : <TechnicalNamesSwitch />
        }
      >
        <SectionBody>
          <DescriptionList>
            {/* The Worker's name is technical detail too: the title names the app. */}
            {job.install !== null && showNames && (
              <DescriptionItem label="Worker">
                <span className="font-mono text-[0.9em]">{job.install.workerName}</span>
              </DescriptionItem>
            )}
            {job.targetVersion !== null && (
              <DescriptionItem label="Appflare version">
                <span className="font-mono text-[0.9em]">{job.targetVersion}</span>
              </DescriptionItem>
            )}
            {/* The Worker version's id is technical detail, shown on request. */}
            {job.workerVersionId !== null && showNames && (
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
        </SectionBody>
      </Section>
      {job.kind === "install" && <SeedCredentialsCard jobId={job.id} />}
      {switching && (
        <Banner
          variant="secondary"
          icon={<AppflareLoader size="sm" aria-hidden />}
          title="Appflare is switching versions…"
          description={
            job.kind === "self_rollback"
              ? `Cloudflare is moving traffic to ${job.targetVersion ?? "the earlier version"}. This page reloads once it answers.`
              : `The current version keeps serving until ${job.targetVersion ?? "the new version"} has passed its checks and takes over. This page reloads once it answers.`
          }
        />
      )}
      {job.status === "failed" && (
        <JobFailure job={job} failureTopic={failureTopic} isAdmin={isAdmin} />
      )}
      {job.sourceBuild !== null && job.status === "succeeded" && (
        <Banner
          variant="default"
          icon={<GitBranchIcon weight="fill" />}
          title="Built. Review it next"
          description={
            job.sourceBuild.purpose === "update"
              ? "Nothing changed yet. The review shows what the new build declares; update from there."
              : "Nothing is installed yet. The review shows what the build declares; install it from there."
          }
          action={
            <LinkButton
              href={`/catalog/source/${job.id}`}
              variant="primary"
              icon={<ArrowRightIcon />}
            >
              Review
            </LinkButton>
          }
        />
      )}
      {job.build !== null && <BuildProgress build={job.build} />}
      <Section
        title="Log"
        empty={
          job.logs.length === 0 ? (
            <SectionEmpty
              size="sm"
              icon={<ListChecksIcon size={32} className="text-kumo-inactive" />}
              title={isActive(job) ? "Waiting for the first step…" : "No log lines were written"}
            />
          ) : null
        }
      >
        {/* On a phone the level sits under the time and long lines wrap: nothing to swipe to. */}
        <SectionTable label="Log" minWidth="none">
          <Table.Header>
            <Table.Row>
              <Table.Head>Time</Table.Head>
              <Table.Head className="max-sm:hidden">Level</Table.Head>
              <Table.Head>Message</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {job.logs.map((line) => (
              <LogRow key={line.id} line={line} />
            ))}
          </Table.Body>
        </SectionTable>
      </Section>
    </>
  );
}

/** Within this many pixels of the end, the output counts as read to the end. */
const AT_END_PX = 24;

/**
 * Live output of the sandbox build the job waits on; the job log gets it
 * when the build ends. The output is a box of its own that keeps up with
 * new lines, unless the admin scrolled up to read an earlier one.
 */
function BuildProgress({ build }: { build: BuildProgressView }) {
  const output = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const text = build.lines.join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs again for each new output
  useLayoutEffect(() => {
    const box = output.current;
    if (box !== null && atEnd.current) box.scrollTop = box.scrollHeight;
  }, [text]);
  return (
    <Section
      title={
        build.kind === "installer"
          ? "Running the app's installer in your sandbox Worker"
          : "Building in your sandbox Worker"
      }
      badge={
        <span className="flex items-center gap-2">
          <AppflareLoader size="sm" />
          <Badge variant="info">{build.stage}</Badge>
        </span>
      }
    >
      <SectionBody className="gap-2">
        <Text variant="secondary" size="sm">
          Last output at {formatTime(build.updatedAt)}. The end of the output goes to the log below
          when the {build.kind === "installer" ? "run" : "build"} ends.
        </Text>
        {build.lines.length === 0 ? (
          <Text variant="mono-secondary">No output yet.</Text>
        ) : (
          // Kumo's code block, as a box that scrolls; focusable so a keyboard can scroll it.
          // biome-ignore lint/a11y/useSemanticElements: a named, scrollable output box, not a group of form controls
          <div
            ref={output}
            role="group"
            aria-label={build.kind === "installer" ? "Installer output" : "Build output"}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling box must take focus to be scrolled by keyboard
            tabIndex={0}
            onScroll={(event) => {
              const box = event.currentTarget;
              atEnd.current = box.scrollHeight - box.scrollTop - box.clientHeight <= AT_END_PX;
            }}
            className="max-h-96 min-w-0 overflow-auto rounded-md border border-kumo-fill bg-kumo-base p-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand"
          >
            <Code lang="bash" code={text} />
          </div>
        )}
      </SectionBody>
    </Section>
  );
}

const LEVEL_VARIANT: Record<string, "neutral" | "info" | "warning" | "error"> = {
  debug: "neutral",
  info: "info",
  warn: "warning",
  error: "error",
};

function LogRow({ line }: { line: JobLogRow }) {
  const level = <Badge variant={LEVEL_VARIANT[line.level] ?? "neutral"}>{line.level}</Badge>;
  return (
    <Table.Row>
      <Table.Cell className="align-top whitespace-nowrap">
        <div className="grid justify-items-start gap-1.5">
          <Text as="time" variant="secondary" size="sm">
            {formatTime(line.ts)}
          </Text>
          <span className="sm:hidden">{level}</span>
        </div>
      </Table.Cell>
      <Table.Cell className="align-top max-sm:hidden">{level}</Table.Cell>
      <Table.Cell className="align-top">
        <div className="grid min-w-0 gap-1 [overflow-wrap:anywhere]">
          <Text>
            <MessageText message={line.message} />
          </Text>
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

/**
 * A failed job: what did not finish, in a plain sentence, and what that
 * means in one line; the job's own error (the step that stopped and
 * Cloudflare's answer) behind Details; then the docs, the report and
 * Install again, which go under the text on a phone.
 */
function JobFailure({
  job,
  failureTopic,
  isAdmin,
}: {
  job: JobView;
  failureTopic: ReturnType<typeof jobFailureTopic>;
  isAdmin: boolean;
}) {
  const line = jobFailureLine(job);
  const again = isAdmin && job.againHref != null ? job.againHref : null;
  return (
    <Banner
      variant="error"
      icon={BANNER_ICON.error}
      role={bannerRole("error")}
      className={ACTIONS_UNDER_ON_PHONE}
      title={jobFailureHeadline(job)}
      description={
        line === null && job.error === null ? undefined : (
          <div className="grid gap-1">
            {line !== null && <p>{line}</p>}
            {job.error !== null && <TechnicalDetails message={job.error} />}
          </div>
        )
      }
      action={
        failureTopic === null && !isAdmin ? undefined : (
          <BannerActions>
            {failureTopic !== null && <DocsLink topic={failureTopic} variant="inline" />}
            {isAdmin && <SendReportButton jobId={job.id} reportedAt={job.reportedAt} />}
            {/* An install that did not finish, once its cause is fixed. */}
            {again !== null && (
              <LinkButton href={again} variant="primary" icon={<ArrowCounterClockwiseIcon />}>
                Install again
              </LinkButton>
            )}
          </BannerActions>
        )
      }
    />
  );
}
