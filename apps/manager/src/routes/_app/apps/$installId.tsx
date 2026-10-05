import {
  Badge,
  Banner,
  Empty,
  InlineCopyText,
  Link,
  LinkButton,
  Table,
  Tabs,
  Text,
} from "@cloudflare/kumo";
import { ArrowRightIcon, InfoIcon, PackageIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { createFileRoute, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { InstallAccessView } from "../../../access/app-access";
import { startedByLabel } from "../../../auto-update/auto-update";
import { InstallAutoUpdateCard } from "../../../auto-update/install-auto-update-card";
import { AppAccessSection } from "../../../components/app-access-section";
import { AppCredentialsCard } from "../../../components/app-credentials-card";
import {
  APP_TAB_LABELS,
  APP_TABS,
  type AppTab,
  appLink,
  appSectionTab,
} from "../../../components/app-links";
import { AppSettingsSection } from "../../../components/app-settings-section";
import { AppIcon } from "../../../components/catalog-media";
import { CatalogSourceBadge } from "../../../components/catalog-source-badge";
import { CustomDomainsSection } from "../../../components/custom-domains-section";
import { DescriptionItem, DescriptionList } from "../../../components/description-list";
import { DocsLink } from "../../../components/docs-link";
import { DomainName, DomainNameList } from "../../../components/domain-name";
import { ExternalDomainsSection } from "../../../components/external-domains-section";
import { TechnicalNamesSwitch, useShowTechnicalNames } from "../../../components/field-label";
import { jobKindLabel, resourceKindLabel } from "../../../components/format";
import { FLUSH_RING_CLASS } from "../../../components/hash-target";
import { InstallHealth } from "../../../components/install-health";
import { Markdown } from "../../../components/markdown";
import { OpenAppButton } from "../../../components/open-app-button";
import { OriginBadge } from "../../../components/origin-badge";
import { PageHeader } from "../../../components/page-header";
import { DeleteRetainedDialog, ForgetDialog } from "../../../components/removed-app-actions";
import { RenameInstallDialog } from "../../../components/rename-install-dialog";
import { revealSelectedTab } from "../../../components/reveal-tab";
import {
  Section,
  SectionBody,
  SectionRow,
  SectionRows,
  SectionTable,
} from "../../../components/section";
import { SourceChangesCard } from "../../../components/source-changes-card";
import { StatusBadge } from "../../../components/status-badge";
import { Timestamp } from "../../../components/timestamp";
import { UninstallDialog } from "../../../components/uninstall-dialog";
import { UpdateBanner } from "../../../components/update-banner";
import { VersionsSection } from "../../../components/versions-section";
import { WorkersDevSwitch } from "../../../components/workers-dev-switch";
import {
  getInstallPage,
  type InstallDetail,
  type ResourceView,
} from "../../../installs/installs.functions";
import { NOT_REACHABLE_NOTE, type OtherWorkerView } from "../../../installs/other-workers";
import type { InstallSettings } from "../../../installs/reconfigure.server";
import type { SnapshotView } from "../../../installs/versions.server";
import { INSTALL_PAGE_STALE_MS } from "../../../router-timing";

const TABS = APP_TABS;
type Tab = AppTab;

/**
 * `/apps/$installId`: the install's display name (else the app's name) and icon,
 * with "Rename" beside it for admins, its update or uninstall state,
 * then tabs. Overview: details and health, next steps (the Cloudflare token
 * an app needs for itself is explained where it is entered: the install
 * form, Settings, and a self-deploying app's token card), and, at the bottom for admins, the
 * danger zone (uninstall, finishing an uninstall, or once uninstalled
 * deleting what was kept or forgetting the app). Settings: the app's
 * settings and secrets (admins change them and redeploy) and automatic
 * updates. Domains and email: the workers.dev switch, custom domains, external domains,
 * Cloudflare Access protection, email routes. Resources: what the install created, and what an uninstall kept.
 * Jobs: versions to roll back to, and every job with who started it. The
 * tab is in the URL (`?tab=`), so links and reloads keep it. A link to one
 * section (`#secrets`, see `app-links.ts`) opens the tab that holds it.
 */
export const Route = createFileRoute("/_app/apps/$installId")({
  validateSearch: z.object({ tab: z.enum(TABS).optional() }),
  // One request with one session check: the install, its snapshots and its settings.
  loader: ({ params }) => getInstallPage({ data: { installId: params.installId } }),
  staleTime: INSTALL_PAGE_STALE_MS,
  // The deepest route's title wins over the root's "<page> · Appflare".
  head: ({ loaderData }) => ({
    meta: [
      {
        title: `${loaderData?.install == null ? "App" : loaderData.install.label} · Appflare`,
      },
    ],
  }),
  component: InstallPage,
});

const HOME_CRUMB = { label: "Home", href: "/" };

const mono = "font-mono text-[0.9em]";

/** Tabs an uninstalled app still has: nothing to configure, but what it kept and its history. */
function tabsFor(install: InstallDetail): readonly Tab[] {
  return install.status === "uninstalled" ? ["overview", "resources", "jobs"] : TABS;
}

function InstallPage() {
  const { install, snapshots, settings, access } = Route.useLoaderData();
  const { viewer } = Route.useRouteContext();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const hash = useLocation({ select: (location) => location.hash });
  // The tab a link to a section asks for, read after the first render: the
  // server never sees the hash, so the first render matches its markup.
  const [hashTab, setHashTab] = useState<Tab | null>(null);
  useEffect(() => setHashTab(appSectionTab(hash)), [hash]);
  // On a phone the tab strip scrolls sideways: keep the open tab in sight,
  // above all when a link opened a tab far along it.
  const tabsRef = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs again whenever the open tab changes, which only the DOM shows.
  useEffect(() => revealSelectedTab(tabsRef.current), [hashTab, search.tab]);
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
  const wanted = search.tab ?? hashTab ?? "overview";
  const tab: Tab = tabs.includes(wanted) ? wanted : "overview";
  return (
    <>
      <PageHeader
        // The install's display name (the app's name goes beneath), else the
        // app's name; the Worker's name only tells two installs apart that
        // would read the same, as in the sidebar. Details lists it.
        title={install.label}
        description={install.displayName === null ? undefined : install.name}
        parents={[HOME_CRUMB]}
        icon={<AppIcon src={install.icon} name={install.name} size={40} eager />}
        titleAction={isAdmin ? <RenameInstallDialog install={install} /> : undefined}
        actions={
          install.address !== null ? (
            <OpenAppButton href={install.address} label={install.label} variant="primary" />
          ) : undefined
        }
      />
      <UpdateBanner install={install} isAdmin={isAdmin} />
      <UninstallState install={install} />
      <div ref={tabsRef} className="min-w-0">
        <Tabs
          variant="underline"
          value={tab}
          onValueChange={(next) => {
            const picked = TABS.find((t) => t === next) ?? "overview";
            setHashTab(null);
            void navigate({
              search: picked === "overview" ? {} : { tab: picked },
              replace: true,
              resetScroll: false,
            });
          }}
          tabs={tabs.map((value) => ({ value, label: APP_TAB_LABELS[value] }))}
        />
      </div>
      {tab === "overview" && <OverviewTab install={install} isAdmin={isAdmin} />}
      {tab === "settings" && (
        <SettingsTab install={install} settings={settings} isAdmin={isAdmin} />
      )}
      {tab === "domains" && <DomainsTab install={install} access={access} isAdmin={isAdmin} />}
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
        <Section id="next-steps" title="Next steps" className={FLUSH_RING_CLASS}>
          <SectionBody>
            {install.postInstall.map((content) => (
              <Markdown key={content}>{content}</Markdown>
            ))}
          </SectionBody>
        </Section>
      )}
      {!gone && install.build.kind === "self-deploying" && (
        <AppCredentialsCard
          installId={install.id}
          appName={install.name}
          secretNames={install.secretNames}
          tokenPermissions={install.tokenPermissions}
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
        <SecretNamesSection names={install.secretNames} />
      )}
      {install.origin === "catalog" ? (
        <InstallAutoUpdateCard install={install} isAdmin={isAdmin} />
      ) : (
        <Section id="automatic-updates" title="Automatic updates" className={FLUSH_RING_CLASS}>
          <SectionBody>
            <Text variant="secondary">
              {install.origin === "repository" ? (
                <>
                  Never: this app is not from the catalog. Check for changes under{" "}
                  <Link href={appLink(install.id, "source")}>Source</Link>, then rebuild and review
                  the update.
                </>
              ) : (
                <>
                  Never: this app was built from source at a commit you chose. Update it from the
                  catalog, or rebuild it under{" "}
                  <Link href={appLink(install.id, "source")}>Source</Link>.
                </>
              )}
            </Text>
          </SectionBody>
        </Section>
      )}
    </>
  );
}

/**
 * The secrets an install has, when its settings cannot be read: how many,
 * with their names (technical detail) behind "Show technical names".
 */
function SecretNamesSection({ names }: { names: readonly string[] }) {
  const [showNames] = useShowTechnicalNames();
  return (
    <Section
      id="secrets"
      title="Secrets"
      className={FLUSH_RING_CLASS}
      action={names.length === 0 ? null : <TechnicalNamesSwitch />}
    >
      <SectionBody className="gap-1.5">
        <Text variant="secondary">
          {names.length === 0
            ? "No secrets are set."
            : `${names.length} ${names.length === 1 ? "secret is" : "secrets are"} set. Their values are stored encrypted on the app and cannot be shown.`}
        </Text>
        {showNames && (
          <div className="flex flex-wrap gap-2">
            {names.map((name) => (
              <Badge key={name} variant="outline">
                <span className={mono}>{name}</span>
              </Badge>
            ))}
          </div>
        )}
      </SectionBody>
    </Section>
  );
}

function DomainsTab({
  install,
  access,
  isAdmin,
}: {
  install: InstallDetail;
  access: InstallAccessView | null;
  isAdmin: boolean;
}) {
  return (
    <>
      {isAdmin && install.build.kind !== "self-deploying" && (
        <Section id="workers-dev" title="workers.dev URL" className={FLUSH_RING_CLASS}>
          <WorkersDevSwitch install={install} />
        </Section>
      )}
      {isAdmin ? (
        <CustomDomainsSection install={install} />
      ) : (
        <Section
          id="domains"
          title={install.wildcard === null ? "Custom domains" : "Wildcard domain"}
          titleAction={<DocsLink topic="customDomains" />}
          className={FLUSH_RING_CLASS}
        >
          <SectionBody>
            {install.domains.length === 0 ? (
              <Text variant="secondary">The app is served on its workers.dev URL only.</Text>
            ) : (
              <DomainNameList domains={install.domains} />
            )}
          </SectionBody>
        </Section>
      )}
      <ExternalDomainsSection install={install} isAdmin={isAdmin} />
      {/* After the addresses: it covers every one of them. */}
      {access !== null && <AppAccessSection install={install} access={access} isAdmin={isAdmin} />}
      <Section id="email" title="Email" className={FLUSH_RING_CLASS}>
        <SectionBody className="gap-3">
          {install.emailRoutes.length === 0 ? (
            <Text variant="secondary">This app does not receive email through Email Routing.</Text>
          ) : (
            <>
              <ul className="grid list-disc gap-1 pl-5">
                {install.emailRoutes.map((r) => (
                  <li key={r.id}>
                    <Text as="span">{r.label}.</Text>
                  </li>
                ))}
              </ul>
              <Text variant="secondary" size="sm">
                To receive email for another domain, change{" "}
                <Link href={appLink(install.id, "email-zone")}>Email in the app's settings</Link>.
              </Text>
            </>
          )}
        </SectionBody>
      </Section>
    </>
  );
}

function ResourcesTab({ install }: { install: InstallDetail }) {
  const gone = install.status === "uninstalled";
  // The binding each resource is bound to the app as is technical detail.
  const [showNames] = useShowTechnicalNames();
  const kept = install.retained.length > 0;
  const namesSwitch = <TechnicalNamesSwitch />;
  return (
    <>
      {kept && (
        <Section
          id="kept-resources"
          title="Kept in the account"
          className={FLUSH_RING_CLASS}
          description={
            <>
              These were kept when the app was uninstalled. Appflare no longer uses them. When you
              no longer need the data, an admin can delete them from the{" "}
              <Link href={appLink(install.id, "danger-zone")}>danger zone</Link>, or you can delete
              them in the Cloudflare dashboard.
            </>
          }
          action={namesSwitch}
        >
          <ResourceTable rows={install.retained} showBindings={showNames} />
        </Section>
      )}
      {!gone && (
        <Section
          id="resources"
          title="Resources"
          description={
            install.resources.some((r) => r.missing)
              ? "What the install created in this account. A Workflow marked “Not set up” is missing in Cloudflare, or was not updated with the app, so the parts of the app that use it may not work. Appflare tries again on its next scheduled check."
              : "What the install created in this account."
          }
          className={FLUSH_RING_CLASS}
          action={!kept && install.resources.length > 0 ? namesSwitch : null}
          empty={
            install.resources.length === 0 ? (
              <Text variant="secondary">No resources have been created yet.</Text>
            ) : null
          }
        >
          <ResourceTable rows={install.resources} showBindings={showNames} />
        </Section>
      )}
      {gone && !kept && (
        <Section id="resources" title="Resources" className={FLUSH_RING_CLASS}>
          <SectionBody>
            <Text variant="secondary">
              The Worker and every resource Appflare created for it are deleted.
            </Text>
          </SectionBody>
        </Section>
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
      <Section id="job-history" title="Job history" className={FLUSH_RING_CLASS}>
        <SectionTable label="Job history" stickyFirstColumn>
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
        </SectionTable>
      </Section>
    </>
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
    <Section id="danger-zone" title="Danger zone" className={FLUSH_RING_CLASS}>
      <SectionRows>
        {install.uninstall === "start" && (
          <SectionRow
            title="Uninstall"
            description={
              selfDeploying
                ? "Runs the app's own installer to delete everything it created. Nothing can be kept."
                : "Deletes the Worker and everything bound to it. You choose which data resources to keep."
            }
            action={<UninstallDialog install={install} mode="start" />}
          />
        )}
        {install.uninstall === "retry" && (
          <SectionRow
            title="Finish uninstalling"
            description="Deletes what the last attempt left. You can keep a resource Cloudflare refuses to delete."
            action={<UninstallDialog install={install} mode="retry" />}
          />
        )}
        {kept && (
          <SectionRow
            title="Kept data"
            description={
              install.forgotten
                ? "Delete retained data deletes the resources this app kept, with everything in them. The app was forgotten, so Removed apps no longer lists it."
                : "Delete retained data deletes the resources this app kept, with everything in them. Forget only stops listing the app under Removed apps; the resources stay in the account."
            }
            action={
              <>
                <DeleteRetainedDialog app={install} disabled={busy} />
                {!install.forgotten && <ForgetDialog app={install} disabled={busy} />}
              </>
            }
          />
        )}
      </SectionRows>
    </Section>
  );
}

function ResourceTable({ rows, showBindings }: { rows: ResourceView[]; showBindings: boolean }) {
  const managedColumn = rows.some((r) => r.managedByApp);
  return (
    <SectionTable label="Resources" minWidth={showBindings ? "lg" : "md"}>
      <Table.Header>
        <Table.Row>
          <Table.Head>Kind</Table.Head>
          {showBindings && <Table.Head>Binding</Table.Head>}
          <Table.Head>Name</Table.Head>
          <Table.Head>ID</Table.Head>
          {managedColumn && <Table.Head>Managed by</Table.Head>}
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {rows.map((r) => (
          <Table.Row key={r.id}>
            <Table.Cell>{resourceKindLabel(r.kind)}</Table.Cell>
            {showBindings && (
              <Table.Cell>
                <span className={mono}>{r.binding ?? ""}</span>
              </Table.Cell>
            )}
            <Table.Cell>
              <span className={mono}>{r.name}</span>
            </Table.Cell>
            <Table.Cell>
              {r.missing && <Badge variant="warning">Not set up</Badge>}
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
                {r.managedByApp ? <Badge variant="outline">The app's installer</Badge> : "Appflare"}
              </Table.Cell>
            )}
          </Table.Row>
        ))}
      </Table.Body>
    </SectionTable>
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
            {install.retained.length > 0 ? (
              <>
                The Worker is deleted. The resources listed under{" "}
                <Link href={appLink(install.id, "kept-resources")}>Kept in the account</Link> are
                still there.
              </>
            ) : (
              "The Worker and every resource Appflare created for it are deleted."
            )}
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
      description={
        <>
          Resources already deleted stay deleted. An admin can finish the uninstall from the{" "}
          <Link href={appLink(install.id, "danger-zone")}>danger zone</Link>, and keep anything
          Cloudflare refuses to delete.
        </>
      }
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
  const [showNames] = useShowTechnicalNames();
  return (
    <Section
      id="details"
      title="Details"
      className={FLUSH_RING_CLASS}
      badge={
        <span className="flex flex-wrap items-center gap-2">
          <OriginBadge origin={install.origin} />
          {install.updateAvailable && <Badge variant="info">Update available</Badge>}
          {install.reinstallNeeded && <Badge variant="warning">Reinstall to update</Badge>}
          <StatusBadge status={install.status} of="install" />
        </span>
      }
      // The Worker version and the settings' names show on request.
      action={<TechnicalNamesSwitch />}
    >
      <SectionBody>
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
                None; the app's name is shown
              </Text>
            )}
          </DescriptionItem>
          <DescriptionItem label="Version">
            <span className={mono}>{install.version}</span>
            {(install.updateAvailable || install.reinstallNeeded) &&
              install.latestVersion !== null && (
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
            <DescriptionItem id="health" label="Health">
              <InstallHealth
                installId={install.id}
                status={install.healthStatus}
                access={install.healthAccess}
                checkedAt={install.healthCheckedAt}
                canCheck={isAdmin && install.status === "installed" && install.activeJobId === null}
              />
            </DescriptionItem>
          )}
          {showNames && (
            <DescriptionItem label="Worker version">
              {install.currentVersionId === null ? (
                "None yet"
              ) : (
                <InlineCopyText
                  labels={{
                    copyAction: "Copy the Worker version",
                    copied: "Worker version copied",
                  }}
                >
                  {install.currentVersionId}
                </InlineCopyText>
              )}
            </DescriptionItem>
          )}
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
          {/* Settings are listed by the names the app reads them as: technical detail. */}
          {showNames &&
            vars.map(([name, value]) => (
              <DescriptionItem key={name} label={name}>
                <span className={mono}>{value}</span>
              </DescriptionItem>
            ))}
          <DescriptionItem label="Last change">
            <Timestamp iso={install.updatedAt} />
          </DescriptionItem>
        </DescriptionList>
      </SectionBody>
    </Section>
  );
}
