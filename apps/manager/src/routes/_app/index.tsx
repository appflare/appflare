import { Badge, Empty, LayerCard, Link, LinkButton, Table } from "@cloudflare/kumo";
import { PackageIcon, StorefrontIcon } from "@phosphor-icons/react";
import { createFileRoute, getRouteApi, useRouter } from "@tanstack/react-router";
import { HealthIcon } from "../../components/install-health";
import { PageHeader } from "../../components/page-header";
import { PendingUpdatesBanner } from "../../components/pending-updates-banner";
import { StatusBadge } from "../../components/status-badge";
import { UsageDataNotice } from "../../components/usage-data-notice";
import { type InstallRow, listInstalls } from "../../installs/installs.functions";
import { getTelemetryNotice } from "../../telemetry/telemetry.functions";

/**
 * `/`: the pending updates (apps and Appflare itself, read by the layout's
 * loader), then every install that is not uninstalled with its label, Worker
 * name, status (with an icon when its last health check did not verify the
 * Worker), version, and update-available. Several installs of one app are
 * listed one by one. Uninstalled apps that kept data are listed under
 * Settings, Removed apps; the others are not listed anywhere. Admins of a
 * manager updated from a version without usage data first see the usage-data
 * notice, until one of them answers it.
 */
export const Route = createFileRoute("/_app/")({
  staticData: { title: "Installed apps" },
  loader: async () => {
    const [rows, notice] = await Promise.all([listInstalls(), getTelemetryNotice()]);
    return { rows, notice };
  },
  component: InstalledPage,
});

const layout = getRouteApi("/_app");

const mono = "font-mono text-[0.9em]";

function InstalledPage() {
  const { rows, notice } = Route.useLoaderData();
  const pending = layout.useLoaderData();
  const router = useRouter();
  return (
    <>
      <PageHeader
        title="Installed apps"
        description="Apps Appflare manages in this Cloudflare account."
        actions={
          rows.length > 0 ? (
            <LinkButton href="/catalog" variant="secondary" icon={<StorefrontIcon />}>
              Catalog
            </LinkButton>
          ) : undefined
        }
      />
      {notice.show && (
        <UsageDataNotice status={notice.status} via="banner" onDone={() => router.invalidate()} />
      )}
      <PendingUpdatesBanner pending={pending} />
      {rows.length > 0 ? (
        <ActiveTable rows={rows} />
      ) : (
        <Empty
          icon={<PackageIcon size={48} className="text-kumo-inactive" />}
          title="No apps installed"
          description="Install an app from the catalog. It runs in this account and Appflare keeps it updated."
          contents={
            <LinkButton href="/catalog" variant="primary" icon={<StorefrontIcon />}>
              Browse the catalog
            </LinkButton>
          }
        />
      )}
    </>
  );
}

function ActiveTable({ rows }: { rows: InstallRow[] }) {
  return (
    <LayerCard className="p-0">
      <Table>
        <Table.Header>
          <Table.Row>
            <Table.Head>Name</Table.Head>
            <Table.Head>App</Table.Head>
            <Table.Head>Worker</Table.Head>
            <Table.Head>Status</Table.Head>
            <Table.Head>Version</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {rows.map((row) => (
            <Table.Row key={row.id}>
              <Table.Cell>
                <Link href={`/apps/${row.id}`}>{row.instanceName}</Link>
              </Table.Cell>
              <Table.Cell>
                <Link href={`/catalog/${row.slug}`}>{row.name}</Link>
              </Table.Cell>
              <Table.Cell>
                {row.workerUrl !== null ? (
                  <Link href={row.workerUrl} target="_blank" rel="noopener noreferrer">
                    <span className={mono}>{row.workerName}</span>
                    <Link.ExternalIcon />
                  </Link>
                ) : (
                  <span className={mono}>{row.workerName}</span>
                )}
              </Table.Cell>
              <Table.Cell>
                <div className="flex items-center gap-2">
                  <StatusBadge status={row.status} of="install" />
                  {row.status === "installed" && (
                    <HealthIcon status={row.healthStatus} checkedAt={row.healthCheckedAt} />
                  )}
                </div>
              </Table.Cell>
              <Table.Cell>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={mono}>{row.version}</span>
                  {row.updateAvailable && <Badge variant="info">Update available</Badge>}
                </div>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </LayerCard>
  );
}
