import { type CatalogAuthor, type IndexBuild, SELF_DEPLOYING_TOOLS } from "@appflare/schema";
import { Badge, Banner, Checkbox, Empty, LayerCard, Link, Table, Text } from "@cloudflare/kumo";
import {
  CheckCircleIcon,
  StorefrontIcon,
  WarningCircleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { createFileRoute } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { paidPlanBadge, requirementBadge } from "../../../capabilities/capabilities";
import { CapabilityBadge } from "../../../capabilities/capability-badge";
import { authorLinks, maintainerProfile } from "../../../catalog/authors";
import { type CatalogDetail, getCatalogEntry } from "../../../catalog/catalog.functions";
import { requirementLabel, requirementSentence } from "../../../catalog/requirements";
import { AppTokenPermissions } from "../../../components/app-token-permissions";
import { InstallCheckBadge, PlanBadge, TierBadge } from "../../../components/catalog-badges";
import { AppCover, AppIcon, PopularityLine, Screenshots } from "../../../components/catalog-media";
import { CronTriggersField } from "../../../components/cron-triggers-field";
import { DescriptionItem, DescriptionList } from "../../../components/description-list";
import { resourceKindLabel } from "../../../components/format";
import { InstallForm } from "../../../components/install-form";
import { PageHeader } from "../../../components/page-header";
import { Section } from "../../../components/section";
import { StatusBadge } from "../../../components/status-badge";
import {
  describeInstance,
  estimatedMinutes,
  estimateIndexBuild,
  formatUsd,
} from "../../../sandbox/cost";

/**
 * `/catalog/$slug`: app detail, prerequisites, the Cloudflare token the app
 * needs for itself (if any), the installs of this app, and the install form (an
 * app may be installed several times under different Worker names, unless its
 * Worker name is fixed). An app with cron triggers says how many it uses
 * against the free plan's 5 per account. When the app lists account requirements, the admin
 * confirms them in the prerequisites callout before the Install button enables.
 */
const CATALOG_CRUMB = { label: "Catalog", href: "/catalog" };

export const Route = createFileRoute("/_app/catalog/$slug")({
  loader: ({ params }) => getCatalogEntry({ data: { slug: params.slug } }),
  // The deepest route's title wins over the root's "<page> · Appflare".
  head: ({ loaderData }) => ({
    meta: [{ title: `${loaderData?.app?.name ?? "Catalog"} · Appflare` }],
  }),
  component: CatalogEntryPage,
});

function CatalogEntryPage() {
  const detail = Route.useLoaderData();
  const { viewer } = Route.useRouteContext();
  const { slug } = Route.useParams();
  const [requirementsConfirmed, setRequirementsConfirmed] = useState(false);
  if (detail.app === null) {
    return (
      <>
        <PageHeader title="App not found" parents={[CATALOG_CRUMB]} />
        {detail.error !== null ? (
          <Empty
            icon={<WarningCircleIcon size={48} className="text-kumo-inactive" />}
            title="The catalog is unavailable"
            description={detail.error}
          />
        ) : (
          <Empty
            icon={<StorefrontIcon size={48} className="text-kumo-inactive" />}
            title={`No app "${slug}" in the catalog`}
            description="It may have been removed from the catalog, or the link is wrong."
          />
        )}
      </>
    );
  }

  const { app, catalog } = detail;
  const canInstall = viewer.role === "admin";
  const sandboxBuild = app.tier === "sandbox" ? (app.build ?? null) : null;
  const installer = app.tier === "self-deploying" ? (app.build ?? null) : null;
  const blockedReason =
    detail.fixedWorkerName && detail.instances[0] !== undefined
      ? `${app.name} is already installed as "${detail.instances[0].workerName}". It only works under one Worker name, so it installs once per account.`
      : sandboxBuild !== null && !detail.sandboxConnected
        ? `${app.name} is built in your account by the sandbox Worker, and Appflare is not connected to one. Set up sandbox builds in Settings first.`
        : installer !== null && !detail.sandboxConnected
          ? `${app.name} is deployed by its own installer in your sandbox Worker, and Appflare is not connected to one. Set up sandbox builds in Settings first.`
          : null;
  const installable = catalog !== null && detail.suggestedWorkerName !== null;
  return (
    <>
      <PageHeader
        title={app.name}
        description={app.summary}
        parents={[CATALOG_CRUMB]}
        icon={<AppIcon src={detail.images.icon} size={40} />}
      />
      <AboutCard detail={detail} />
      {detail.images.screenshots.length > 0 && (
        <LayerCard>
          <LayerCard.Secondary>Screenshots</LayerCard.Secondary>
          <LayerCard.Primary className="px-5 py-4">
            <Screenshots items={detail.images.screenshots} />
          </LayerCard.Primary>
        </LayerCard>
      )}
      <Prerequisites
        detail={detail}
        confirmation={
          installable
            ? {
                checked: requirementsConfirmed,
                onChange: setRequirementsConfirmed,
                disabledReason: !canInstall
                  ? "Only admins can install apps."
                  : blockedReason !== null
                    ? "The install form below says why this app cannot be installed now."
                    : null,
              }
            : null
        }
      />
      {catalog !== null && (
        <AppTokenPermissions
          appName={app.name}
          permissions={catalog.tokenPermissions}
          custody={installer !== null ? "sandbox" : "app"}
        />
      )}
      {detail.error !== null && (
        <Banner
          variant="error"
          icon={<WarningCircleIcon weight="fill" />}
          title="The install form is unavailable"
          description={detail.error}
        />
      )}
      <Instances detail={detail} />
      {catalog !== null && detail.suggestedWorkerName !== null && (
        <InstallForm
          // A new suggestion (after another install) resets the form.
          key={detail.suggestedWorkerName}
          catalog={catalog}
          varFields={detail.varFields}
          subdomain={detail.subdomain}
          canInstall={canInstall}
          defaultWorkerName={detail.suggestedWorkerName}
          fixedWorkerName={detail.fixedWorkerName}
          blockedReason={blockedReason}
          requirementsConfirmed={requirementsConfirmed}
          sandboxBuild={sandboxBuild}
          installer={installer}
          cronTriggers={detail.cronTriggers}
          accountPlan={detail.accountPlan}
          planDetected={detail.capabilities.plan.source === "detected"}
        />
      )}
    </>
  );
}

function AboutCard({ detail }: { detail: CatalogDetail }) {
  const { app, catalog } = detail;
  if (app === null) return null;
  const cover = detail.images.cover;
  return (
    <LayerCard>
      <LayerCard.Secondary className="flex flex-wrap items-center justify-between gap-3">
        <span>About</span>
        <div className="flex flex-wrap items-center gap-2">
          <TierBadge tier={app.tier} />
          <PlanBadge plan={app.plan} />
        </div>
      </LayerCard.Secondary>
      <LayerCard.Primary
        className={
          cover === null
            ? "px-5 py-4"
            : "grid items-start gap-5 px-5 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]"
        }
      >
        <DescriptionList>
          <DescriptionItem label="Version">
            <span className="font-mono text-[0.9em]">{app.version}</span>
          </DescriptionItem>
          {app.tier === "sandbox" && app.build !== undefined && <BuildRow build={app.build} />}
          {app.tier === "self-deploying" && app.build !== undefined && (
            <InstallerRow
              build={app.build}
              tool={
                catalog?.install.selfDeploying === undefined
                  ? null
                  : SELF_DEPLOYING_TOOLS[catalog.install.selfDeploying.tool].label
              }
            />
          )}
          {catalog !== null && (
            <>
              <DescriptionItem label="Source">
                <Link
                  href={`https://github.com/${catalog.repo}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {catalog.repo}
                  <Link.ExternalIcon />
                </Link>
              </DescriptionItem>
              <DescriptionItem label="Homepage">
                <Link href={catalog.homepage} target="_blank" rel="noopener noreferrer">
                  {catalog.homepage}
                  <Link.ExternalIcon />
                </Link>
              </DescriptionItem>
              <DescriptionItem label="License">{catalog.license}</DescriptionItem>
            </>
          )}
          {detail.popularity !== null &&
            (detail.popularity.stars !== null || detail.popularity.installsKnown) && (
              <DescriptionItem label="Popularity">
                <PopularityLine popularity={detail.popularity} />
              </DescriptionItem>
            )}
          {detail.authors.length > 0 && (
            <DescriptionItem label={detail.authors.length === 1 ? "Author" : "Authors"}>
              <Authors authors={detail.authors} />
            </DescriptionItem>
          )}
          <DescriptionItem label="Packaged by">
            <Maintainers maintainers={app.maintainers} />
          </DescriptionItem>
          <DescriptionItem label="Last checked">
            <InstallCheckBadge lastVerified={app.lastVerified} />
          </DescriptionItem>
        </DescriptionList>
        {cover !== null && (
          // The cover is the app's 1200x630 card; beside the details it stays card-sized.
          <AppCover src={cover} alt={`${app.name}: ${app.summary}`} />
        )}
      </LayerCard.Primary>
    </LayerCard>
  );
}

/** Each author on its own line: the name, then their website, GitHub, and X where given. */
function Authors({ authors }: { authors: CatalogAuthor[] }) {
  return (
    <span className="grid gap-0.5">
      {authors.map((author) => (
        <span key={author.name} className="flex flex-wrap items-baseline gap-x-3">
          <span>{author.name}</span>
          {authorLinks(author).map((link) => (
            <ExternalLink key={link.href} href={link.href}>
              {link.label}
            </ExternalLink>
          ))}
        </span>
      ))}
    </span>
  );
}

/** The catalog maintainers, each linked to GitHub where the handle allows. */
function Maintainers({ maintainers }: { maintainers: string[] }) {
  return (
    <span className="flex flex-wrap gap-x-3">
      {maintainers.map((handle) => {
        const profile = maintainerProfile(handle);
        return profile.href === null ? (
          <span key={handle}>{profile.label}</span>
        ) : (
          <ExternalLink key={handle} href={profile.href}>
            {profile.label}
          </ExternalLink>
        );
      })}
    </span>
  );
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <Link.ExternalIcon />
    </Link>
  );
}

/** A sandbox tier app's build: the pinned commit, the container, and what a build costs. */
function BuildRow({ build }: { build: IndexBuild }) {
  const estimate = estimateIndexBuild(build);
  return (
    <DescriptionItem label="Build">
      <span className="grid gap-0.5">
        <span>
          From <span className="font-mono text-[0.9em]">{build.pin.slice(0, 12)}</span> in your
          sandbox Worker, on Workers Paid
        </span>
        <Text as="span" variant="secondary" size="sm">
          {describeInstance(estimate)} for {estimatedMinutes(estimate.minutes)}: about{" "}
          {formatUsd(estimate.usd)} a build of that length beyond the included usage
        </Text>
      </span>
    </DescriptionItem>
  );
}

/** A self-deploying app's installer: which tool, the pinned commit, and what a run costs. */
function InstallerRow({ build, tool }: { build: IndexBuild; tool: string | null }) {
  const estimate = estimateIndexBuild(build);
  return (
    <DescriptionItem label="Installer">
      <span className="grid gap-0.5">
        <span>
          Its own{tool === null ? "" : ` (${tool})`}, run from{" "}
          <span className="font-mono text-[0.9em]">{build.pin.slice(0, 12)}</span> in your sandbox
          Worker, on Workers Paid
        </span>
        <Text as="span" variant="secondary" size="sm">
          {describeInstance(estimate)} for {estimatedMinutes(estimate.minutes)}: about{" "}
          {formatUsd(estimate.usd)} a run of that length beyond the included usage. No rollback.
        </Text>
      </span>
    </DescriptionItem>
  );
}

/** Installs of this app that are not uninstalled, with links to each. */
function Instances({ detail }: { detail: CatalogDetail }) {
  if (detail.instances.length === 0) return null;
  return (
    <Section title="Installed in this account">
      <LayerCard className="p-0">
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.Head>Name</Table.Head>
              <Table.Head>Worker</Table.Head>
              <Table.Head>Status</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {detail.instances.map((instance) => (
              <Table.Row key={instance.installId}>
                <Table.Cell>
                  <Link href={`/apps/${instance.installId}`}>{instance.instanceName}</Link>
                </Table.Cell>
                <Table.Cell>
                  <span className="font-mono text-[0.9em]">{instance.workerName}</span>
                </Table.Cell>
                <Table.Cell>
                  <StatusBadge status={instance.status} of="install" />
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </LayerCard>
    </Section>
  );
}

interface RequirementsConfirmation {
  checked: boolean;
  onChange(checked: boolean): void;
  /** Why the box cannot be ticked now; null when it can. */
  disabledReason: string | null;
}

/**
 * Plan, account requirements, and what the install creates. Each requirement
 * gets one sentence; `confirmation` (shown only when the install form is)
 * holds the checkbox that enables the Install button.
 */
function Prerequisites({
  detail,
  confirmation,
}: {
  detail: CatalogDetail;
  confirmation: RequirementsConfirmation | null;
}) {
  const { app } = detail;
  if (app === null) return null;
  const creates = [
    ...detail.creates.map((c) => `${resourceKindLabel(c.kind)} for ${c.binding}`),
    ...detail.durableObjects.map((d) => `Durable Object class ${d}`),
  ];
  const paid = app.plan === "paid";
  const planBadge = paid ? paidPlanBadge(detail.capabilities) : null;
  const requirementBadges = app.requires.map((r) => requirementBadge(r, detail.capabilities));
  // Green only when Appflare detected every requirement as met; anything unknown stays a warning.
  const allMet =
    (!paid || planBadge?.met === true) && requirementBadges.every((b) => b?.met === true);
  return (
    <div className="grid gap-3">
      {(paid || app.requires.length > 0) && (
        <Banner
          variant={allMet ? "default" : "alert"}
          icon={allMet ? <CheckCircleIcon weight="fill" /> : <WarningIcon weight="fill" />}
          title={allMet ? "This account meets the requirements" : "Before you install"}
          description={
            <div className="grid gap-2">
              {paid && (
                <span className="inline-flex flex-wrap items-center gap-2">
                  This app needs the Workers Paid plan on this account.
                  <CapabilityBadge badge={planBadge} />
                </span>
              )}
              {app.requires.length > 0 && (
                <>
                  <span>{paid ? "It also needs:" : "This app needs:"}</span>
                  <ul className="grid list-disc gap-1 pl-5">
                    {app.requires.map((r, i) => (
                      <li key={r}>
                        <span className="font-semibold">{requirementLabel(r)}.</span>{" "}
                        {requirementSentence(r, {
                          tier: app.tier,
                          provisionsEmailRouting:
                            detail.catalog?.install.emailRouting !== undefined,
                        })}{" "}
                        <CapabilityBadge badge={requirementBadges[i] ?? null} />
                      </li>
                    ))}
                  </ul>
                  {confirmation !== null && (
                    <span className="grid gap-1">
                      <Checkbox
                        label="This account meets these requirements"
                        checked={confirmation.checked}
                        disabled={confirmation.disabledReason !== null}
                        onCheckedChange={(checked: boolean) => confirmation.onChange(checked)}
                      />
                      {confirmation.disabledReason !== null && (
                        <Text as="span" variant="secondary" size="sm">
                          {confirmation.disabledReason}
                        </Text>
                      )}
                    </span>
                  )}
                </>
              )}
            </div>
          }
        />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Text variant="secondary" size="sm">
          {detail.app?.tier === "self-deploying"
            ? "The app's own installer creates its Workers and resources. Appflare records them after each run and never deletes them itself; uninstalling runs the installer's destroy command."
            : !detail.createsKnown
              ? "The install builds the app first. It creates a Worker and the resources the app's wrangler config declares at the pinned commit."
              : `The install creates a Worker${creates.length > 0 ? " and:" : ", nothing else."}`}
        </Text>
        {creates.map((c) => (
          <Badge key={c} variant="outline">
            {c}
          </Badge>
        ))}
      </div>
      <CronTriggersField count={detail.cronTriggers} />
    </div>
  );
}
