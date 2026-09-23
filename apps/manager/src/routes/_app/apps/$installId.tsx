import { Badge, Banner, Empty, LayerCard, Link, LinkButton, Table, Text } from "@cloudflare/kumo";
import {
  ArrowRightIcon,
  ArrowSquareOutIcon,
  InfoIcon,
  PackageIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { formatDateTime, jobKindLabel, resourceKindLabel } from "../../../components/format";
import { Markdown } from "../../../components/markdown";
import { PageHeader } from "../../../components/page-header";
import { StatusBadge } from "../../../components/status-badge";
import { UninstallDialog } from "../../../components/uninstall-dialog";
import { UpdateBanner } from "../../../components/update-banner";
import { VersionsSection } from "../../../components/versions-section";
import {
  getInstall,
  type InstallDetail,
  type ResourceView,
} from "../../../installs/installs.functions";
import { listSnapshots } from "../../../installs/versions.functions";

/**
 * `/apps/$installId`: status, resources, secret names, jobs, the app's
 * post-install notes, update and rollback, and uninstall. After an uninstall
 * it shows the `uninstalled` state, the resources that were kept, and the job
 * history.
 */
export const Route = createFileRoute("/_app/apps/$installId")({
  loader: async ({ params }) => {
    const [install, snapshots] = await Promise.all([
      getInstall({ data: { installId: params.installId } }),
      listSnapshots({ data: { installId: params.installId } }),
    ]);
    return { install, snapshots };
  },
  // The deepest route's title wins over the root's "<page> · Appflare".
  head: ({ loaderData }) => ({
    meta: [{ title: `${loaderData?.install?.instanceName ?? "Install"} · Appflare` }],
  }),
  component: InstallPage,
});

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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-3">
      <Text variant="heading" as="h2">
        {title}
      </Text>
      {children}
    </section>
  );
}

const mono = "font-mono text-[0.9em]";

function InstallPage() {
  const { install, snapshots } = Route.useLoaderData();
  const { viewer } = Route.useRouteContext();
  const isAdmin = viewer.role === "admin";
  if (install === null) {
    return (
      <>
        <PageHeader title="Install" />
        <Empty
          icon={<PackageIcon size={48} className="text-kumo-inactive" />}
          title="No such install"
          description="The link may be wrong, or the install was removed."
        />
      </>
    );
  }
  const gone = install.status === "uninstalled";
  return (
    <>
      <PageHeader
        title={install.instanceName}
        description={`${install.name}, Worker "${install.workerName}"`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {isAdmin && install.uninstall !== null && (
              <UninstallDialog install={install} mode={install.uninstall} />
            )}
            {install.workerUrl !== null && (
              <LinkButton
                href={install.workerUrl}
                external
                variant="primary"
                icon={<ArrowSquareOutIcon />}
              >
                Open app
              </LinkButton>
            )}
          </div>
        }
      />
      <UpdateBanner install={install} isAdmin={isAdmin} />
      <UninstallState install={install} />
      <Overview install={install} />
      {!gone && install.postInstall.length > 0 && (
        <Section title="Next steps">
          <LayerCard>
            <LayerCard.Primary className="grid gap-4 px-5 py-4">
              {install.postInstall.map((content) => (
                <Markdown key={content}>{content}</Markdown>
              ))}
            </LayerCard.Primary>
          </LayerCard>
        </Section>
      )}
      {install.retained.length > 0 && (
        <Section title="Kept in the account">
          <Text variant="secondary">
            These were kept when the app was uninstalled. Appflare no longer uses them; delete them
            in the Cloudflare dashboard when you no longer need the data.
          </Text>
          <ResourceTable rows={install.retained} />
        </Section>
      )}
      {!gone && (
        <Section title="Resources">
          {install.resources.length === 0 ? (
            <Text variant="secondary">No resources have been created yet.</Text>
          ) : (
            <ResourceTable rows={install.resources} />
          )}
        </Section>
      )}
      {!gone && (
        <Section title="Secrets">
          {install.secretNames.length === 0 ? (
            <Text variant="secondary">No secrets are set.</Text>
          ) : (
            <div className="grid gap-1.5">
              <div className="flex flex-wrap gap-2">
                {install.secretNames.map((name) => (
                  <Badge key={name} variant="outline">
                    {name}
                  </Badge>
                ))}
              </div>
              <Text variant="secondary" size="sm">
                Secret values are stored encrypted on the Worker and cannot be shown.
              </Text>
            </div>
          )}
        </Section>
      )}
      {!gone && <VersionsSection install={install} snapshots={snapshots} isAdmin={isAdmin} />}
      <Section title="Jobs">
        <LayerCard className="p-0">
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>Job</Table.Head>
                <Table.Head>Status</Table.Head>
                <Table.Head>Started</Table.Head>
                <Table.Head>Finished</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {install.jobs.map((job) => (
                <Table.Row key={job.id}>
                  <Table.Cell>
                    <Link href={`/jobs/${job.id}`}>{jobKindLabel(job.kind, job.restore)}</Link>
                  </Table.Cell>
                  <Table.Cell>
                    <StatusBadge status={job.status} of="job" />
                  </Table.Cell>
                  <Table.Cell>{formatDateTime(job.startedAt)}</Table.Cell>
                  <Table.Cell>{formatDateTime(job.finishedAt)}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </LayerCard>
      </Section>
    </>
  );
}

function ResourceTable({ rows }: { rows: ResourceView[] }) {
  return (
    <LayerCard className="p-0">
      <Table>
        <Table.Header>
          <Table.Row>
            <Table.Head>Kind</Table.Head>
            <Table.Head>Binding</Table.Head>
            <Table.Head>Name</Table.Head>
            <Table.Head>ID</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {rows.map((r) => (
            <Table.Row key={r.id}>
              <Table.Cell>{resourceKindLabel(r.kind)}</Table.Cell>
              <Table.Cell>
                <span className={mono}>{r.binding ?? ""}</span>
              </Table.Cell>
              <Table.Cell>
                <span className={mono}>{r.name}</span>
              </Table.Cell>
              <Table.Cell>
                <span className={mono}>{r.cfId ?? ""}</span>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </LayerCard>
  );
}

/** Where an uninstall stands: running (link to its log), stopped part way, or done. */
function UninstallState({ install }: { install: InstallDetail }) {
  if (install.status === "uninstalled") {
    return (
      <Banner
        variant="secondary"
        icon={<InfoIcon weight="fill" />}
        title={`Uninstalled ${formatDateTime(install.uninstalledAt)}`}
        description={
          install.retained.length > 0
            ? "The Worker is deleted. The resources listed under Kept in the account are still there."
            : "The Worker and every resource Appflare created for it are deleted."
        }
      />
    );
  }
  if (install.status !== "uninstalling") return null;
  if (install.activeJobId !== null) {
    return (
      <Banner
        variant="secondary"
        icon={<InfoIcon weight="fill" />}
        title="Uninstalling"
        action={
          <LinkButton
            href={`/jobs/${install.activeJobId}`}
            variant="secondary"
            icon={<ArrowRightIcon />}
          >
            View log
          </LinkButton>
        }
      />
    );
  }
  return (
    <Banner
      variant="error"
      icon={<WarningCircleIcon weight="fill" />}
      title="The uninstall did not finish"
      description="Resources already deleted stay deleted. An admin can retry the uninstall to delete what is left, and keep anything Cloudflare refuses to delete."
    />
  );
}

function Overview({ install }: { install: InstallDetail }) {
  const vars = Object.entries(install.vars);
  return (
    <LayerCard>
      <LayerCard.Secondary className="flex items-center justify-between gap-3">
        <span>Overview</span>
        <div className="flex items-center gap-2">
          {install.updateAvailable && <Badge variant="info">Update available</Badge>}
          <StatusBadge status={install.status} of="install" />
        </div>
      </LayerCard.Secondary>
      <LayerCard.Primary className="px-5 py-4">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2">
          <Row label="Name">{install.instanceName}</Row>
          <Row label="App">
            <Link href={`/catalog/${install.slug}`}>{install.slug}</Link>
          </Row>
          <Row label="Version">
            <span className={mono}>{install.version}</span>
            {install.updateAvailable && install.latestVersion !== null && (
              <Text as="span" variant="secondary">
                {" "}
                (catalog has <span className={mono}>{install.latestVersion}</span>)
              </Text>
            )}
          </Row>
          <Row label="Worker">
            <span className={mono}>{install.workerName}</span>
          </Row>
          <Row label="URL">
            {install.workerUrl !== null ? (
              <Link href={install.workerUrl} target="_blank" rel="noopener noreferrer">
                {install.workerUrl}
                <Link.ExternalIcon />
              </Link>
            ) : install.status === "uninstalled" ? (
              "None; the Worker is deleted"
            ) : (
              "Not serving yet"
            )}
          </Row>
          <Row label="Worker version">
            <span className={mono}>{install.currentVersionId ?? "None yet"}</span>
          </Row>
          {install.pinSha !== null && (
            <Row label="Built from">
              <span className={mono}>{install.pinSha.slice(0, 12)}</span>
            </Row>
          )}
          {vars.map(([name, value]) => (
            <Row key={name} label={name}>
              <span className={mono}>{value}</span>
            </Row>
          ))}
          <Row label="Last change">{formatDateTime(install.updatedAt)}</Row>
        </dl>
      </LayerCard.Primary>
    </LayerCard>
  );
}
