import { Empty, Link, Table, Text } from "@cloudflare/kumo";
import { ListChecksIcon } from "@phosphor-icons/react";
import { createFileRoute } from "@tanstack/react-router";
import { startedByLabel } from "../../../auto-update/auto-update";
import { jobKindLabel } from "../../../components/format";
import { PageHeader } from "../../../components/page-header";
import { ResponsiveTable } from "../../../components/responsive-table";
import { StatusBadge } from "../../../components/status-badge";
import { Timestamp } from "../../../components/timestamp";
import { JOB_LIST_LIMIT } from "../../../jobs/job-list";
import { listJobs } from "../../../jobs/jobs.functions";

/**
 * `/jobs`: the most recent jobs of every app and of Appflare itself, newest
 * first, each linked to its log and to its app's page. Older jobs stay on
 * each app's page, under Jobs.
 */
export const Route = createFileRoute("/_app/jobs/")({
  staticData: { title: "Jobs" },
  loader: () => listJobs(),
  component: JobsPage,
});

function JobsPage() {
  const rows = Route.useLoaderData();
  return (
    <>
      <PageHeader
        title="Jobs"
        description="Installs, updates, settings changes, rollbacks and uninstalls, newest first."
      />
      {rows.length === 0 ? (
        <Empty
          icon={<ListChecksIcon size={48} className="text-kumo-inactive" />}
          title="No jobs yet"
          description="Every install, update and uninstall runs as a job with its own log, listed here."
        />
      ) : (
        <>
          <ResponsiveTable label="Jobs" minWidth="lg" stickyFirstColumn>
            <Table.Header>
              <Table.Row>
                <Table.Head>Job</Table.Head>
                <Table.Head>App</Table.Head>
                <Table.Head>Status</Table.Head>
                <Table.Head>Started by</Table.Head>
                <Table.Head>Started</Table.Head>
                <Table.Head>Finished</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {rows.map((job) => (
                <Table.Row key={job.id}>
                  <Table.Cell>
                    <Link href={`/jobs/${job.id}`}>{jobKindLabel(job)}</Link>
                  </Table.Cell>
                  <Table.Cell>
                    {job.install === null ? (
                      "Appflare"
                    ) : (
                      <Link href={`/apps/${job.install.id}`}>{job.install.label}</Link>
                    )}
                  </Table.Cell>
                  <Table.Cell>
                    <StatusBadge status={job.status} of="job" />
                  </Table.Cell>
                  <Table.Cell>{startedByLabel(job.startedBy)}</Table.Cell>
                  <Table.Cell className="whitespace-nowrap">
                    <Timestamp iso={job.startedAt} />
                  </Table.Cell>
                  <Table.Cell className="whitespace-nowrap">
                    <Timestamp iso={job.finishedAt} />
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </ResponsiveTable>
          {rows.length >= JOB_LIST_LIMIT && (
            <Text variant="secondary" size="sm">
              The {JOB_LIST_LIMIT} most recent jobs. Each app's page lists all of its own.
            </Text>
          )}
        </>
      )}
    </>
  );
}
