import {
  Badge,
  Banner,
  Empty,
  InlineCopyText,
  LayerCard,
  Link,
  LinkButton,
  Table,
  Tabs,
  Text,
} from "@cloudflare/kumo";
import { ArrowRightIcon, InfoIcon, PackageIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { z } from "zod";
import { startedByLabel } from "../../../auto-update/auto-update";
import { InstallAutoUpdateCard } from "../../../auto-update/install-auto-update-card";
import { AppCredentialsCard } from "../../../components/app-credentials-card";
import { AppSettingsSection } from "../../../components/app-settings-section";
import { AppTokenPermissions } from "../../../components/app-token-permissions";
import { AppIcon } from "../../../components/catalog-media";
import { CatalogSourceBadge } from "../../../components/catalog-source-badge";
import { CustomDomainsSection } from "../../../components/custom-domains-section";
import { DescriptionItem, DescriptionList } from "../../../components/description-list";
import { DocsLink } from "../../../components/docs-link";
import { DomainName, DomainNameList } from "../../../components/domain-name";
import { ExternalDomainsSection } from "../../../components/external-domains-section";
import { jobKindLabel, resourceKindLabel } from "../../../components/format";
import { InstallHealth } from "../../../components/install-health";
import { Markdown } from "../../../components/markdown";
import { OpenAppButton } from "../../../components/open-app-button";
import { OriginBadge } from "../../../components/origin-badge";
import { PageHeader } from "../../../components/page-header";
import { DeleteRetainedDialog, ForgetDialog } from "../../../components/removed-app-actions";
import { RenameInstallDialog } from "../../../components/rename-install-dialog";
import { Section } from "../../../components/section";
import { SourceChangesCard } from "../../../components/source-changes-card";
import { StatusBadge } from "../../../components/status-badge";
import { Timestamp } from "../../../components/timestamp";
import { UninstallDialog } from "../../../components/uninstall-dialog";
import { UpdateBanner } from "../../../components/update-banner";
import { VersionsSection } from "../../../components/versions-section";
import { WorkersDevSwitch } from "../../../components/workers-dev-switch";
import {
  getInstall,
  type InstallDetail,
  type ResourceView,
} from "../../../installs/installs.functions";
import { NOT_REACHABLE_NOTE, type OtherWorkerView } from "../../../installs/other-workers";
import { getInstallSettings } from "../../../installs/reconfigure.functions";
import type { InstallSettings } from "../../../installs/reconfigure.server";
import { listSnapshots } from "../../../installs/versions.functions";
import type { SnapshotView } from "../../../installs/versions.server";

const TABS = ["overview", "settings", "domains", "resources", "jobs"] as const;
type Tab = (typeof TABS)[number];

const TAB_LABELS: Record<Tab, string> = {
  overview: "Overview",
  settings: "Settings",
  domains: "Domains and email",
  resources: "Resources",
  jobs: "Jobs",
};

/**
 * `/apps/$installId`: the install's display name (else the app's name) and icon,
 * with "Rename" beside it for admins, its update or uninstall state,
 * then tabs. Overview: details and health, next steps, the Cloudflare token
 * the app needs for itself (if any), and, at the bottom for admins, the
 * danger zone (uninstall, finishing an uninstall, or once uninstalled
 * deleting what was kept or forgetting the app). Settings: the app's
 * settings and secrets (admins change them and redeploy) and automatic
 * updates. Domains and email: the workers.dev switch, custom domains, external domains, email
 * routes. Resources: what the install created, and what an uninstall kept.
 * Jobs: versions to roll back to, and every job with who started it. The
 * tab is in the URL (`?tab=`), so links and reloads keep it.
 */
export const Route = createFileRoute("/_app/apps/$installId")({
  validateSearch: z.object({ tab: z.enum(TABS).optional() }),
  loader: async ({ params }) => {
    const [install, snapshots, settings] = await Promise.all([
      getInstall({ data: { installId: params.installId } }),
      listSnapshots({ data: { installId: params.installId } }),
      getInstallSettings({ data: { installId: params.installId } }),
    ]);
    return { install, snapshots, settings };
  },
  // The deepest route's title wins over the root's "<page> · Appflare".
  head: ({ loaderData }) => ({
    meta: [
      {
        title: `${loaderData?.install == null ? "App" : pageTitle(loaderData.install)} · Appflare`,
      },
    ],
  }),
  component: InstallPage,
});

const HOME_CRUMB = { label: "Home", href: "/" };

/**
 * The page's title: the install's display name when it has one (the app and
 * Worker names go beneath), else the app's name.
 */
function pageTitle(install: Pick<InstallDetail, "displayName" | "name">): string {
  return install.displayName ?? install.name;
}

const mono = "font-mono text-[0.9em]";

/** Tabs an uninstalled app still has: nothing to configure, but what it kept and its history. */
function tabsFor(install: InstallDetail): readonly Tab[] {
  return install.status === "uninstalled" ? ["overview", "resources", "jobs"] : TABS;
}

function InstallPage() {
  const { install, snapshots, settings } = Route.useLoaderData();
  const { viewer } = Route.useRouteContext();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const isAdmin = viewer.role === "admin";
  if (install === null) {
    return (
      <>
        <PageHeader title="App not found" parents={[HOME_CRUMB]} />
        <Empty
          icon={<PackageIcon size={48} className="text-kumo-inactive" />}
          title="No such install"
          description="The link may be wrong, or the install was removed."
        />
      </>
    );
  }
  const tabs = tabsFor(install);
  const tab: Tab = search.tab !== undefined && tabs.includes(search.tab) ? search.tab : "overview";
  return (
    <>
      <PageHeader
        title={pageTitle(install)}
        description={
          install.displayName === null
            ? `Worker ${install.workerName}`
            : `${install.name}, Worker ${install.workerName}`
        }
        parents={[HOME_CRUMB]}
        icon={<AppIcon src={install.icon} name={install.name} size={40} />}
        titleAction={isAdmin ? <RenameInstallDialog install={install} /> : undefined}
        actions={
          install.address !== null ? (
            <OpenAppButton href={install.address} label={install.label} variant="primary" />
          ) : undefined
        }
      />
      <UpdateBanner install={install} isAdmin={isAdmin} />
      <UninstallState install={install} />
      <Tabs
        variant="underline"
        value={tab}
        onValueChange={(next) => {
          const picked = TABS.find((t) => t === next) ?? "overview";
          void navigate({
            search: picked === "overview" ? {} : { tab: picked },
            replace: true,
            resetScroll: false,
          });
        }}
        tabs={tabs.map((value) => ({ value, label: TAB_LABELS[value] }))}
      />
      {tab === "overview" && <OverviewTab install={install} isAdmin={isAdmin} />}
      {tab === "settings" && (
        <SettingsTab install={install} settings={settings} isAdmin={isAdmin} />
      )}
      {tab === "domains" && <DomainsTab install={install} isAdmin={isAdmin} />}
      {tab === "resources" && <ResourcesTab install={install} />}
      {tab === "jobs" && <JobsTab install={install} snapshots={snapshots} isAdmin={isAdmin} />}
    </>
  );
}

function OverviewTab({ install, isAdmin }: { install: InstallDetail; isAdmin: boolean }) {
  const gone = install.status === "uninstalled";
  return (
    <>
      <Details install={install} isAdmin={isAdmin} />
      {!gone && <SourceChangesCard install={install} isAdmin={isAdmin} />}
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
      {!gone && (
        <AppTokenPermissions
          appName={install.name}
          permissions={install.tokenPermissions}
          custody={install.build.kind === "self-deploying" ? "sandbox" : "app"}
        />
      )}
      {!gone && install.build.kind === "self-deploying" && (
        <AppCredentialsCard
          installId={install.id}
          appName={install.name}
          secretNames={install.secretNames}
          canEdit={isAdmin}
        />
      )}
      {isAdmin && <DangerZone install={install} />}
    </>
  );
}

function SettingsTab({
  install,
  settings,
  isAdmin,
}: {
  install: InstallDetail;
  settings: InstallSettings | null;
  isAdmin: boolean;
}) {
  return (
    <>
      {settings !== null ? (
        <AppSettingsSection
          // A saved change reloads the page; the form starts from the new values.
          key={install.updatedAt}
          install={install}
          settings={settings}
          isAdmin={isAdmin}
        />
      ) : (
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
      {install.origin === "catalog" ? (
        <InstallAutoUpdateCard install={install} isAdmin={isAdmin} />
      ) : (
        <Section title="Automatic updates">
          <Text variant="secondary">
            {install.origin === "repository"
              ? "Never: this app is not from the catalog. Check for changes on the Overview tab, then rebuild and review the update."
              : "Never: this app was built from source at a commit you chose. Update it from the catalog, or rebuild it from the Overview tab."}
          </Text>
        </Section>
      )}
    </>
  );
}

function DomainsTab({ install, isAdmin }: { install: InstallDetail; isAdmin: boolean }) {
  return (
    <>
      {isAdmin && install.build.kind !== "self-deploying" && (
        <Section title="workers.dev URL">
          <WorkersDevSwitch install={install} />
        </Section>
      )}
      {isAdmin ? (
        <CustomDomainsSection install={install} />
      ) : (
        <Section
          title={install.wildcard === null ? "Custom domains" : "Wildcard domain"}
          titleAction={<DocsLink topic="customDomains" />}
        >
          {install.domains.length === 0 ? (
            <Text variant="secondary">The app is served on its workers.dev URL only.</Text>
          ) : (
            <DomainNameList domains={install.domains} />
          )}
        </Section>
      )}
      <ExternalDomainsSection install={install} isAdmin={isAdmin} />
      <Section title="Email">
        {install.emailRoutes.length === 0 ? (
          <Text variant="secondary">This app does not receive email through Email Routing.</Text>
        ) : (
          <LayerCard>
            <LayerCard.Primary className="grid gap-3 px-5 py-4">
              <ul className="grid list-disc gap-1 pl-5">
                {install.emailRoutes.map((r) => (
                  <li key={r.id}>
                    <Text as="span">{r.label}.</Text>
                  </li>
                ))}
              </ul>
              <Text variant="secondary" size="sm">
                To receive email for another zone, use the Settings tab.
              </Text>
            </LayerCard.Primary>
          </LayerCard>
        )}
      </Section>
    </>
  );
}

function ResourcesTab({ install }: { install: InstallDetail }) {
  const gone = install.status === "uninstalled";
  return (
    <>
      {install.retained.length > 0 && (
        <Section
          title="Kept in the account"
          description="These were kept when the app was uninstalled. Appflare no longer uses them. When you no longer need the data, an admin can delete them from the danger zone on the Overview tab, or you can delete them in the Cloudflare dashboard."
        >
          <ResourceTable rows={install.retained} />
        </Section>
      )}
      {!gone && (
        <Section title="Resources" description="What the install created in this account.">
          {install.resources.length === 0 ? (
            <Text variant="secondary">No resources have been created yet.</Text>
          ) : (
            <ResourceTable rows={install.resources} />
          )}
        </Section>
      )}
      {gone && install.retained.length === 0 && (
        <Text variant="secondary">
          The Worker and every resource Appflare created for it are deleted.
        </Text>
      )}
    </>
  );
}

function JobsTab({
  install,
  snapshots,
  isAdmin,
}: {
  install: InstallDetail;
  snapshots: SnapshotView[];
  isAdmin: boolean;
}) {
  return (
    <>
      {install.status !== "uninstalled" && (
        <VersionsSection install={install} snapshots={snapshots} isAdmin={isAdmin} />
      )}
      <Section title="Job history">
        <LayerCard className="p-0">
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>Job</Table.Head>
                <Table.Head>Status</Table.Head>
                <Table.Head>Started by</Table.Head>
                <Table.Head>Started</Table.Head>
                <Table.Head>Finished</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {install.jobs.map((job) => (
                <Table.Row key={job.id}>
                  <Table.Cell>
                    <Link href={`/jobs/${job.id}`}>{jobKindLabel(job)}</Link>
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
          </Table>
        </LayerCard>
      </Section>
    </>
  );
}

/** One action of the danger zone: what it does, and its buttons. */
function DangerAction({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div className="grid max-w-prose gap-1">
        <Text bold>{title}</Text>
        <Text variant="secondary">{description}</Text>
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

/**
 * The irreversible actions of the page (admins), at the bottom of Overview:
 * uninstall (for a self-deploying app the same dialog runs its installer's
 * destroy command), or finishing an uninstall that stopped part way; once
 * uninstalled, deleting what the uninstall kept, or forgetting the app.
 * Nothing when no action applies.
 */
function DangerZone({ install }: { install: InstallDetail }) {
  const kept = install.status === "uninstalled" && install.retained.length > 0;
  if (install.uninstall === null && !kept) return null;
  const selfDeploying = install.build.kind === "self-deploying";
  const busy = install.activeJobId !== null;
  return (
    <Section title="Danger zone">
      <LayerCard>
        <LayerCard.Primary className="grid gap-4 px-5 py-4">
          {install.uninstall === "start" && (
            <DangerAction
              title="Uninstall"
              description={
                selfDeploying
                  ? "Runs the app's own installer to delete everything it created. Nothing can be kept."
                  : "Deletes the Worker and everything bound to it. You choose which data resources to keep."
              }
            >
              <UninstallDialog install={install} mode="start" />
            </DangerAction>
          )}
          {install.uninstall === "retry" && (
            <DangerAction
              title="Finish uninstalling"
              description="Deletes what the last attempt left. You can keep a resource Cloudflare refuses to delete."
            >
              <UninstallDialog install={install} mode="retry" />
            </DangerAction>
          )}
          {kept && (
            <DangerAction
              title="Kept data"
              description={
                install.forgotten
                  ? "Delete retained data deletes the resources this app kept, with everything in them. The app was forgotten, so Removed apps no longer lists it."
                  : "Delete retained data deletes the resources this app kept, with everything in them. Forget only stops listing the app under Removed apps; the resources stay in the account."
              }
            >
              <DeleteRetainedDialog app={install} disabled={busy} />
              {!install.forgotten && <ForgetDialog app={install} disabled={busy} />}
            </DangerAction>
          )}
        </LayerCard.Primary>
      </LayerCard>
    </Section>
  );
}

function ResourceTable({ rows }: { rows: ResourceView[] }) {
  const managedColumn = rows.some((r) => r.managedByApp);
  return (
    <LayerCard className="p-0">
      <Table>
        <Table.Header>
          <Table.Row>
            <Table.Head>Kind</Table.Head>
            <Table.Head>Binding</Table.Head>
            <Table.Head>Name</Table.Head>
            <Table.Head>ID</Table.Head>
            {managedColumn && <Table.Head>Managed by</Table.Head>}
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
                {r.cfId !== null && (
                  <InlineCopyText
                    labels={{ copyAction: `Copy the ID of ${r.name}`, copied: "ID copied" }}
                  >
                    {r.cfId}
                  </InlineCopyText>
                )}
              </Table.Cell>
              {managedColumn && (
                <Table.Cell>
                  {r.managedByApp ? (
                    <Badge variant="outline">The app's installer</Badge>
                  ) : (
                    "Appflare"
                  )}
                </Table.Cell>
              )}
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
        title="Uninstalled"
        description={
          <>
            Uninstalled <Timestamp iso={install.uninstalledAt} />.{" "}
            {install.retained.length > 0
              ? "The Worker is deleted. The resources listed on the Resources tab, under Kept in the account, are still there."
              : "The Worker and every resource Appflare created for it are deleted."}
          </>
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
      description="Resources already deleted stay deleted. An admin can finish the uninstall from the danger zone at the bottom of the Overview tab, and keep anything Cloudflare refuses to delete."
    />
  );
}

/**
 * The app's Workers besides its own: each one's Worker name, with its
 * workers.dev URL, or a note when its catalog entry keeps it off the internet.
 */
function OtherWorkers({ workers }: { workers: OtherWorkerView[] }) {
  return (
    <ul className="grid gap-2">
      {workers.map((w) => (
        <li key={w.name} className="grid gap-0.5">
          <span className={mono}>{w.workerName}</span>
          {!w.public ? (
            <Text as="span" variant="secondary" size="sm">
              {NOT_REACHABLE_NOTE}
            </Text>
          ) : w.url !== null ? (
            <Link href={w.url} target="_blank" rel="noopener noreferrer">
              {w.url}
              <Link.ExternalIcon />
            </Link>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** The Overview's details: what is installed, where it serves, its health and build. */
function Details({ install, isAdmin }: { install: InstallDetail; isAdmin: boolean }) {
  const vars = Object.entries(install.vars);
  return (
    <LayerCard>
      <LayerCard.Secondary className="flex items-center justify-between gap-3">
        <span>Details</span>
        <div className="flex items-center gap-2">
          <OriginBadge origin={install.origin} />
          {install.updateAvailable && <Badge variant="info">Update available</Badge>}
          <StatusBadge status={install.status} of="install" />
        </div>
      </LayerCard.Secondary>
      <LayerCard.Primary className="px-5 py-4">
        <DescriptionList>
          <DescriptionItem label="App">
            {install.origin === "repository" ? (
              install.name
            ) : (
              <Link href={`/catalog/${install.slug}`}>{install.name}</Link>
            )}
          </DescriptionItem>
          {install.catalogSource !== null && (
            <DescriptionItem label="Source">
              {/* Updates, form revisions and install checks come from this catalog only. */}
              <CatalogSourceBadge source={install.catalogSource} />
            </DescriptionItem>
          )}
          <DescriptionItem label="Name">
            {install.displayName ?? (
              <Text as="span" variant="secondary">
                None; the Worker name is shown
              </Text>
            )}
          </DescriptionItem>
          <DescriptionItem label="Version">
            <span className={mono}>{install.version}</span>
            {install.updateAvailable && install.latestVersion !== null && (
              <Text as="span" variant="secondary">
                {" "}
                (catalog has <span className={mono}>{install.latestVersion}</span>)
              </Text>
            )}
          </DescriptionItem>
          <DescriptionItem label="Worker">
            <span className={mono}>{install.workerName}</span>
          </DescriptionItem>
          <DescriptionItem label="URL">
            {install.status === "installed" &&
            (install.address !== null || install.domains.length > 0) ? (
              <span className="grid gap-1">
                {install.workersDevEnabled && install.workersDevUrl !== null && (
                  <Link href={install.workersDevUrl} target="_blank" rel="noopener noreferrer">
                    {install.workersDevUrl}
                    <Link.ExternalIcon />
                  </Link>
                )}
                {install.domains.map((d) => (
                  <DomainName key={d.id} domain={d} showUrl />
                ))}
                {!install.workersDevEnabled && (
                  <Text as="span" variant="secondary" size="sm">
                    Not served on workers.dev
                  </Text>
                )}
              </span>
            ) : install.status === "uninstalled" ? (
              "None; the Worker is deleted"
            ) : (
              "Not serving yet"
            )}
          </DescriptionItem>
          {install.otherWorkers.length > 0 && install.status !== "uninstalled" && (
            <DescriptionItem label="Other Workers">
              <OtherWorkers workers={install.otherWorkers} />
            </DescriptionItem>
          )}
          {(install.status === "installed" || install.status === "updating") && (
            <DescriptionItem label="Health">
              <InstallHealth
                installId={install.id}
                status={install.healthStatus}
                checkedAt={install.healthCheckedAt}
                canCheck={isAdmin && install.status === "installed" && install.activeJobId === null}
              />
            </DescriptionItem>
          )}
          <DescriptionItem label="Worker version">
            {install.currentVersionId === null ? (
              "None yet"
            ) : (
              <InlineCopyText
                labels={{ copyAction: "Copy the Worker version", copied: "Worker version copied" }}
              >
                {install.currentVersionId}
              </InlineCopyText>
            )}
          </DescriptionItem>
          {install.build.kind === "self-deploying" ? (
            <DescriptionItem label="Deployed">
              <span className="grid gap-1">
                <span>
                  By the app's own installer
                  {install.build.installer === null ? "" : ` (${install.build.installer})`} from{" "}
                  <span className={mono}>
                    {install.pinSha?.slice(0, 12) ?? "an unknown commit"}
                  </span>{" "}
                  in your sandbox Worker, as stage{" "}
                  <span className={mono}>{install.build.stage ?? "unknown"}</span>. Unsigned; no
                  rollback.
                </span>
                {install.build.builtAt !== null && (
                  <Text as="span" variant="secondary" size="sm">
                    <Timestamp iso={install.build.builtAt} />
                    {install.build.image === null ? "" : ` with ${install.build.image}`}
                  </Text>
                )}
              </span>
            </DescriptionItem>
          ) : install.build.kind === "sandbox" ? (
            <DescriptionItem label="Built">
              <span className="grid gap-1">
                <span>
                  {install.source !== null ? (
                    <>
                      Built in your account from{" "}
                      {install.source.url.replace("https://github.com/", "")} at{" "}
                      <span className={mono}>{install.source.ref}</span>,{" "}
                    </>
                  ) : (
                    "Built in your account from "
                  )}
                  <span className={mono}>
                    {install.pinSha?.slice(0, 12) ?? "an unknown commit"}
                  </span>{" "}
                  with image <span className={mono}>{install.build.image ?? "unknown"}</span>,
                  unsigned
                </span>
                {install.build.builtAt !== null && (
                  <Text as="span" variant="secondary" size="sm">
                    <Timestamp iso={install.build.builtAt} />
                  </Text>
                )}
              </span>
            </DescriptionItem>
          ) : (
            install.pinSha !== null && (
              <DescriptionItem label="Built from">
                <span className={mono}>{install.pinSha.slice(0, 12)}</span>
                <Text as="span" variant="secondary">
                  {" "}
                  (signed release)
                </Text>
              </DescriptionItem>
            )
          )}
          {vars.map(([name, value]) => (
            <DescriptionItem key={name} label={name}>
              <span className={mono}>{value}</span>
            </DescriptionItem>
          ))}
          <DescriptionItem label="Last change">
            <Timestamp iso={install.updatedAt} />
          </DescriptionItem>
        </DescriptionList>
      </LayerCard.Primary>
    </LayerCard>
  );
}
