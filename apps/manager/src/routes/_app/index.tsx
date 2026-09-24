import {
  Badge,
  Banner,
  Button,
  Empty,
  LayerCard,
  Link,
  LinkButton,
  Table,
  Text,
} from "@cloudflare/kumo";
import {
  ArrowCircleUpIcon,
  PackageIcon,
  StorefrontIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { createFileRoute, getRouteApi, useRouter } from "@tanstack/react-router";
import { AppIcon } from "../../components/catalog-media";
import { HealthIcon } from "../../components/install-health";
import { PageHeader } from "../../components/page-header";
import { PendingUpdatesBanner } from "../../components/pending-updates-banner";
import { StatusBadge } from "../../components/status-badge";
import { type StartUpdateHandle, useStartUpdate } from "../../components/update-banner";
import { UsageDataNotice } from "../../components/usage-data-notice";
import { type InstallRow, listInstalls } from "../../installs/installs.functions";
import { getTelemetryNotice } from "../../telemetry/telemetry.functions";

/**
 * `/` (Home): the pending app updates (read by the layout's loader), with
 * "Update" for one and "Update all" for several (admins), then every install
 * that is not uninstalled with its icon, label, app, Worker, status (with an
 * icon when its last health check did not verify the Worker), version, and
 * update-available (for admins with a single pending update, an "Update"
 * button on its row). Appflare's own update is
 * offered by the sidebar's Appflare card, not here. Several
 * installs of one app are listed one by one. Uninstalled apps that kept data
 * are listed under Settings, Removed apps; the others are not listed
 * anywhere. Admins of a manager updated from a version without usage data
 * first see the usage-data notice, until one of them answers it.
 */
export const Route = createFileRoute("/_app/")({
  staticData: { title: "Home" },
  loader: async () => {
    const [rows, notice] = await Promise.all([listInstalls(), getTelemetryNotice()]);
    return { rows, notice };
  },
  component: HomePage,
});

const layout = getRouteApi("/_app");

const mono = "font-mono text-[0.9em]";

function HomePage() {
  const { rows, notice } = Route.useLoaderData();
  const pending = layout.useLoaderData();
  const { viewer } = layout.useRouteContext();
  const isAdmin = viewer.role === "admin";
  const router = useRouter();
  const update = useStartUpdate();
  return (
    <>
      <PageHeader
        title="Home"
        description="The apps Appflare manages in this Cloudflare account."
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
      <PendingUpdatesBanner apps={pending.apps} isAdmin={isAdmin} update={update} />
      {update.error !== null && (
        <Banner
          variant="error"
          icon={<WarningCircleIcon weight="fill" />}
          title={update.error.message}
        />
      )}
      {update.dialog}
      {rows.length > 0 ? (
        <InstalledTable
          rows={rows}
          // One pending update: its row starts it too. Several: Update all only.
          update={isAdmin && pending.apps.length === 1 ? update : null}
        />
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

function InstalledTable({
  rows,
  update,
}: {
  rows: InstallRow[];
  /**
   * Starts an app's update from its row; null for members, and while
   * several updates are pending (Update all starts them).
   */
  update: StartUpdateHandle | null;
}) {
  return (
    <LayerCard className="p-0">
      <Table>
        <Table.Header>
          <Table.Row>
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
                <div className="flex min-w-0 items-center gap-3">
                  <AppIcon src={row.icon} size={28} />
                  <div className="grid min-w-0">
                    <Link href={`/apps/${row.id}`}>{row.instanceName}</Link>
                    {row.name !== row.instanceName && (
                      <Text as="span" variant="secondary" size="sm" truncate>
                        {row.name}
                      </Text>
                    )}
                  </div>
                </div>
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
                  {row.updateAvailable &&
                    (update !== null ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        icon={<ArrowCircleUpIcon />}
                        title={`Update to ${row.latestVersion ?? "the newest version"}`}
                        loading={update.pendingId === row.id}
                        onClick={() => update.start({ id: row.id, instanceName: row.instanceName })}
                      >
                        Update
                      </Button>
                    ) : (
                      <Badge variant="info">Update available</Badge>
                    ))}
                </div>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </LayerCard>
  );
}
