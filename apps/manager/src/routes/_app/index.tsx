import { Badge, Collapsible, Empty, LayerCard, Link, LinkButton, Table } from "@cloudflare/kumo";
import { PackageIcon, StorefrontIcon } from "@phosphor-icons/react";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { formatDateTime } from "../../components/format";
import { HealthIcon } from "../../components/install-health";
import { PageHeader } from "../../components/page-header";
import { StatusBadge } from "../../components/status-badge";
import { type InstallRow, listInstalls } from "../../installs/installs.functions";

/**
 * `/`: every install with its label, Worker name, status (with an icon when
 * its last health check did not verify the Worker), version, and
 * update-available. Several installs of one app are listed one by one.
 * Uninstalled installs sit in a collapsed section below.
 */
export const Route = createFileRoute("/_app/")({
  staticData: { title: "Installed apps" },
  loader: () => listInstalls(),
  component: InstalledPage,
});

const mono = "font-mono text-[0.9em]";

function InstalledPage() {
  const rows = Route.useLoaderData();
  const [showUninstalled, setShowUninstalled] = useState(false);
  const active = rows.filter((r) => r.status !== "uninstalled");
  const uninstalled = rows.filter((r) => r.status === "uninstalled");
  return (
    <>
      <PageHeader
        title="Installed apps"
        description="Apps Appflare manages in this Cloudflare account."
        actions={
          active.length > 0 ? (
            <LinkButton href="/catalog" variant="secondary" icon={<StorefrontIcon />}>
              Catalog
            </LinkButton>
          ) : undefined
        }
      />
      {active.length > 0 ? (
        <ActiveTable rows={active} />
      ) : (
        !showUninstalled && (
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
        )
      )}
      {uninstalled.length > 0 && (
        <Collapsible.Root open={showUninstalled} onOpenChange={setShowUninstalled}>
          <Collapsible.DefaultTrigger>
            Uninstalled ({uninstalled.length})
          </Collapsible.DefaultTrigger>
          <Collapsible.DefaultPanel>
            <UninstalledTable rows={uninstalled} />
          </Collapsible.DefaultPanel>
        </Collapsible.Root>
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

function UninstalledTable({ rows }: { rows: InstallRow[] }) {
  return (
    <LayerCard className="p-0">
      <Table>
        <Table.Header>
          <Table.Row>
            <Table.Head>Name</Table.Head>
            <Table.Head>App</Table.Head>
            <Table.Head>Worker</Table.Head>
            <Table.Head>Uninstalled</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {rows.map((row) => (
            <Table.Row key={row.id}>
              <Table.Cell>
                <Link href={`/apps/${row.id}`}>{row.instanceName}</Link>
              </Table.Cell>
              <Table.Cell>{row.name}</Table.Cell>
              <Table.Cell>
                <span className={mono}>{row.workerName}</span>
              </Table.Cell>
              <Table.Cell>{formatDateTime(row.uninstalledAt ?? row.updatedAt)}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </LayerCard>
  );
}
