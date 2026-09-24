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
import { AppCredentialsCard } from "../../../components/app-credentials-card";
import { AppTokenPermissions } from "../../../components/app-token-permissions";
import { CustomDomainsSection } from "../../../components/custom-domains-section";
import { formatDateTime, jobKindLabel, resourceKindLabel } from "../../../components/format";
import { InstallHealth } from "../../../components/install-health";
import { Markdown } from "../../../components/markdown";
import { PageHeader } from "../../../components/page-header";
import { DeleteRetainedDialog, ForgetDialog } from "../../../components/removed-app-actions";
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
 * `/apps/$installId`: status and health, custom domains, email routes, resources, secret names, jobs,
 * the Cloudflare token the app needs for itself (if any), the app's post-install notes,
 * update and rollback, and, in a danger zone at the bottom (admins), uninstall
 * or finishing an uninstall. After an uninstall it shows the `uninstalled`
 * state, the resources that were kept, and the job history; the danger zone
 * then offers deleting what was kept, or forgetting the app.
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
          install.workerUrl !== null ? (
            <LinkButton
              href={install.workerUrl}
              external
              variant="primary"
              icon={<ArrowSquareOutIcon />}
            >
              Open app
            </LinkButton>
          ) : undefined
        }
      />
      <UpdateBanner install={install} isAdmin={isAdmin} />
      <UninstallState install={install} />
      <Overview install={install} isAdmin={isAdmin} />
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
      {!gone && isAdmin && <CustomDomainsSection install={install} />}
      {!gone && install.emailRoutes.length > 0 && (
        <Section title="Email">
          <LayerCard>
            <LayerCard.Primary className="px-5 py-4">
              <ul className="grid list-disc gap-1 pl-5">
                {install.emailRoutes.map((r) => (
                  <li key={r.id}>
                    <Text as="span">{r.label}.</Text>
                  </li>
                ))}
              </ul>
            </LayerCard.Primary>
          </LayerCard>
        </Section>
      )}
      {install.retained.length > 0 && (
        <Section title="Kept in the account">
          <Text variant="secondary">
            These were kept when the app was uninstalled. Appflare no longer uses them. When you no
            longer need the data, an admin can delete them with Delete retained data below, or you
            can delete them in the Cloudflare dashboard.
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
                    <Link href={`/jobs/${job.id}`}>{jobKindLabel(job)}</Link>
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
      {isAdmin && <DangerZone install={install} />}
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
 * The irreversible actions of the page (admins), at the bottom: uninstall
 * (for a self-deploying app the same dialog runs its installer's destroy
 * command), or finishing an uninstall that stopped part way; once
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
  return (
    <LayerCard className="p-0">
      <Table>
        <Table.Header>
          <Table.Row>
            <Table.Head>Kind</Table.Head>
            <Table.Head>Binding</Table.Head>
            <Table.Head>Name</Table.Head>
            <Table.Head>ID</Table.Head>
            {rows.some((r) => r.managedByApp) && <Table.Head>Managed by</Table.Head>}
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
              {rows.some((row) => row.managedByApp) && (
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
      description="Resources already deleted stay deleted. An admin can finish the uninstall from the danger zone at the bottom of this page, and keep anything Cloudflare refuses to delete."
    />
  );
}

function Overview({ install, isAdmin }: { install: InstallDetail; isAdmin: boolean }) {
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
              <span className="grid gap-1">
                <Link href={install.workerUrl} target="_blank" rel="noopener noreferrer">
                  {install.workerUrl}
                  <Link.ExternalIcon />
                </Link>
                {install.domains.map((d) => (
                  <Link key={d.id} href={d.url} target="_blank" rel="noopener noreferrer">
                    {d.url}
                    <Link.ExternalIcon />
                  </Link>
                ))}
              </span>
            ) : install.status === "uninstalled" ? (
              "None; the Worker is deleted"
            ) : (
              "Not serving yet"
            )}
          </Row>
          {(install.status === "installed" || install.status === "updating") && (
            <Row label="Health">
              <InstallHealth
                installId={install.id}
                status={install.healthStatus}
                checkedAt={install.healthCheckedAt}
                canCheck={isAdmin && install.status === "installed" && install.activeJobId === null}
              />
            </Row>
          )}
          <Row label="Worker version">
            <span className={mono}>{install.currentVersionId ?? "None yet"}</span>
          </Row>
          {install.build.kind === "self-deploying" ? (
            <Row label="Deployed">
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
                    {formatDateTime(install.build.builtAt)}
                    {install.build.image === null ? "" : ` with ${install.build.image}`}
                  </Text>
                )}
              </span>
            </Row>
          ) : install.build.kind === "sandbox" ? (
            <Row label="Built">
              <span className="grid gap-1">
                <span>
                  Built in your account from{" "}
                  <span className={mono}>
                    {install.pinSha?.slice(0, 12) ?? "an unknown commit"}
                  </span>{" "}
                  with image <span className={mono}>{install.build.image ?? "unknown"}</span>,
                  unsigned
                </span>
                {install.build.builtAt !== null && (
                  <Text as="span" variant="secondary" size="sm">
                    {formatDateTime(install.build.builtAt)}
                  </Text>
                )}
              </span>
            </Row>
          ) : (
            install.pinSha !== null && (
              <Row label="Built from">
                <span className={mono}>{install.pinSha.slice(0, 12)}</span>
                <Text as="span" variant="secondary">
                  {" "}
                  (signed release)
                </Text>
              </Row>
            )
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
