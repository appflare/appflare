import { Badge, Banner, Empty, LayerCard, Link, LinkButton, Text } from "@cloudflare/kumo";
import { ArrowRightIcon, TrashSimpleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { createFileRoute } from "@tanstack/react-router";
import { resourceKindLabel } from "../../../components/format";
import { SETTINGS_CRUMB, SETTINGS_PAGES } from "../../../components/navigation";
import { PageHeader } from "../../../components/page-header";
import { DeleteRetainedDialog, ForgetDialog } from "../../../components/removed-app-actions";
import { Timestamp } from "../../../components/timestamp";
import { listRemovedApps, type RemovedAppRow } from "../../../installs/removed-apps.functions";

/**
 * `/settings/removed-apps`: uninstalled apps that still keep data resources
 * in the account, with what each kept. Admins can delete what an app kept
 * (a job; its log opens) or forget the app, which only hides it here: the
 * resources stay in the account. Uninstalled apps that kept nothing are not
 * listed.
 */
export const Route = createFileRoute("/_app/settings/removed-apps")({
  staticData: { title: "Removed apps" },
  loader: () => listRemovedApps(),
  component: RemovedAppsPage,
});

const mono = "font-mono text-[0.9em]";

function RemovedAppsPage() {
  const rows = Route.useLoaderData();
  const { viewer } = Route.useRouteContext();
  const isAdmin = viewer.role === "admin";
  return (
    <>
      <PageHeader
        title={SETTINGS_PAGES.removedApps.label}
        description={SETTINGS_PAGES.removedApps.description}
        parents={[SETTINGS_CRUMB]}
      />
      {rows.length === 0 ? (
        <Empty
          icon={<TrashSimpleIcon size={48} className="text-kumo-inactive" />}
          title="No removed apps"
          description="No uninstalled app that keeps data is listed. Apps you forgot are not listed here even when they still keep data; their own pages show what they kept."
        />
      ) : (
        rows.map((row) => <RemovedAppCard key={row.id} row={row} isAdmin={isAdmin} />)
      )}
    </>
  );
}

function RemovedAppCard({ row, isAdmin }: { row: RemovedAppRow; isAdmin: boolean }) {
  const busy = row.activeJobId !== null;
  return (
    <LayerCard>
      <LayerCard.Secondary className="flex items-center justify-between gap-3">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <Link href={`/apps/${row.id}`}>{row.instanceName}</Link>
          <Text as="span" variant="secondary" size="sm">
            {row.name}, Worker <span className={mono}>{row.workerName}</span>, uninstalled{" "}
            <Timestamp iso={row.uninstalledAt} />
          </Text>
        </span>
        {busy && <Badge variant="info">Deleting</Badge>}
      </LayerCard.Secondary>
      <LayerCard.Primary className="grid gap-4 px-5 py-4">
        <div className="grid gap-1.5">
          <Text bold>Kept in the account</Text>
          <ul className="grid gap-1">
            {row.retained.map((r) => (
              <li key={r.id} className="flex flex-wrap items-baseline gap-x-2">
                <span>{resourceKindLabel(r.kind)}</span>
                <span className={mono}>{r.name}</span>
              </li>
            ))}
          </ul>
        </div>
        {row.lastFailure !== null && !busy && (
          <Banner
            variant="error"
            icon={<WarningCircleIcon weight="fill" />}
            title="Deleting the kept data did not finish"
            description={row.lastFailure.error ?? "The job failed."}
            action={
              <LinkButton
                href={`/jobs/${row.lastFailure.jobId}`}
                variant="secondary"
                icon={<ArrowRightIcon />}
              >
                View log
              </LinkButton>
            }
          />
        )}
        {busy ? (
          <div className="flex flex-wrap items-center gap-2">
            <LinkButton
              href={`/jobs/${row.activeJobId}`}
              variant="secondary"
              icon={<ArrowRightIcon />}
            >
              View log
            </LinkButton>
          </div>
        ) : (
          isAdmin && (
            <div className="flex flex-wrap items-center gap-2">
              <DeleteRetainedDialog app={row} />
              <ForgetDialog app={row} />
            </div>
          )
        )}
      </LayerCard.Primary>
    </LayerCard>
  );
}
