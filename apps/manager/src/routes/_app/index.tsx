import { Badge, Empty, LayerCard, Link, LinkButton, Table } from "@cloudflare/kumo";
import { PackageIcon, StorefrontIcon } from "@phosphor-icons/react";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "../../components/page-header";
import { StatusBadge } from "../../components/status-badge";
import { listInstalls } from "../../installs/installs.functions";

/** `/`: installed apps with status, version, and update-available. */
export const Route = createFileRoute("/_app/")({
  loader: () => listInstalls(),
  component: InstalledPage,
});

const mono = "font-mono text-[0.9em]";

function InstalledPage() {
  const rows = Route.useLoaderData();
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
      {rows.length === 0 ? (
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
      ) : (
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
                    <Link href={`/apps/${row.id}`}>{row.name}</Link>
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
                    <StatusBadge status={row.status} of="install" />
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
      )}
    </>
  );
}
