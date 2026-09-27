import {
  appTokenPermissions,
  type CatalogAuthor,
  type IndexBuild,
  isLicense,
  licenseFile,
  SELF_DEPLOYING_TOOLS,
} from "@appflare/schema";
import {
  Badge,
  Banner,
  Checkbox,
  cn,
  Empty,
  LayerCard,
  Link,
  LinkButton,
  Table,
  Text,
} from "@cloudflare/kumo";
import {
  CheckCircleIcon,
  GithubLogoIcon,
  GlobeIcon,
  type Icon,
  StorefrontIcon,
  WarningCircleIcon,
  WarningIcon,
  XLogoIcon,
} from "@phosphor-icons/react";
import { createFileRoute } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { requirementBadge } from "../../../capabilities/capabilities";
import { CapabilityBadge } from "../../../capabilities/capability-badge";
import { type AuthorLink, authorLinks, maintainerProfile } from "../../../catalog/authors";
import { avatarSrc } from "../../../catalog/avatar";
import { type CatalogDetail, getCatalogEntry } from "../../../catalog/catalog.functions";
import {
  type AppLicense,
  licenseBadgeCopy,
  licenseFileHref,
  licenseParts,
} from "../../../catalog/license";
import {
  analyticsEngineRefusal,
  type RequirementCheck,
  type RequirementChecks,
  requirementChecks,
} from "../../../catalog/requirement-checks";
import { requirementSentence } from "../../../catalog/requirements";
import { AppTokenPermissions } from "../../../components/app-token-permissions";
import { BuildFromSourceCard } from "../../../components/build-from-source-card";
import {
  InstallCheckBadge,
  LicenseBadge,
  PlanBadge,
  PrimitiveBadges,
  TierBadge,
} from "../../../components/catalog-badges";
import {
  AppIcon,
  AuthorAvatar,
  ImageCarousel,
  PopularityLine,
} from "../../../components/catalog-media";
import { CatalogSourceBadge } from "../../../components/catalog-source-badge";
import { CronTriggersField } from "../../../components/cron-triggers-field";
import { DescriptionItem, DescriptionList } from "../../../components/description-list";
import { DocsLink } from "../../../components/docs-link";
import { resourceKindLabel } from "../../../components/format";
import { InstallForm } from "../../../components/install-form";
import { PageHeader } from "../../../components/page-header";
import { SANDBOX_CHECKLIST_LINK_LABEL } from "../../../components/sandbox-first";
import { Section } from "../../../components/section";
import { StatusBadge } from "../../../components/status-badge";
import { ANALYTICS_ENGINE_CHECKLIST_LINK } from "../../../onboarding/checklist";
import {
  buildCostLine,
  describeInstance,
  estimatedMinutes,
  estimateIndexBuild,
  formatUsd,
} from "../../../sandbox/cost";
import { SANDBOX_CHECKLIST_HREF } from "../../../sandbox/readiness";

/**
 * `/catalog/$slug`: app detail, prerequisites, the Cloudflare token the app
 * needs for itself (if any), the installs of this app, and the install form (an
 * app may be installed several times under different Worker names, unless its
 * Worker name is fixed). An app with cron triggers says how many it uses
 * against the free plan's 5 per account. When the account is not known to
 * offer everything the app asks for, the admin confirms what is left in the
 * prerequisites callout before the Install button enables.
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
  // Sandbox builds off: the install turns them on first when the account
  // has what they need, and says what is missing otherwise.
  const needsSandbox = sandboxBuild !== null || installer !== null;
  const sandboxMissing = needsSandbox ? detail.sandbox.missing : null;
  const analyticsEngineOff = analyticsEngineRefusal(
    app.name,
    { requires: [...app.requires, ...(catalog?.requires ?? [])], services: detail.primitives.ids },
    detail.capabilities,
  );
  const blocked: { reason: string; link: { href: string; label: string } | null } | null =
    detail.fixedWorkerName && detail.instances[0] !== undefined
      ? {
          reason: `${app.name} is already installed as "${detail.instances[0].workerName}". It only works under one Worker name, so it installs once per account.`,
          link: null,
        }
      : sandboxMissing !== null
        ? {
            reason: `${app.name} ${installer !== null ? "is deployed by its own installer in" : "is built in"} your account's sandbox Worker. Sandbox builds are off, and Appflare cannot turn them on: ${sandboxMissing}`,
            link: { href: SANDBOX_CHECKLIST_HREF, label: SANDBOX_CHECKLIST_LINK_LABEL },
          }
        : analyticsEngineOff !== null
          ? { reason: analyticsEngineOff, link: ANALYTICS_ENGINE_CHECKLIST_LINK }
          : null;
  const blockedReason = blocked?.reason ?? null;
  const installable = catalog !== null && detail.suggestedWorkerName !== null;
  const checks = requirementChecks(
    { plan: app.plan, requires: [...new Set([...app.requires, ...(catalog?.requires ?? [])])] },
    detail.capabilities,
  );
  // Nothing left to confirm when the account is known to offer everything.
  const confirmed = requirementsConfirmed || checks.pending.length === 0;
  const images = [
    ...(detail.images.cover === null
      ? []
      : [{ src: detail.images.cover, alt: `${app.name}: ${app.summary}` }]),
    ...detail.images.screenshots,
  ];
  return (
    <>
      <PageHeader
        title={app.name}
        description={app.summary}
        parents={[CATALOG_CRUMB]}
        icon={<AppIcon src={detail.images.icon} name={app.name} size={40} />}
      />
      <AboutCard detail={detail} />
      {images.length > 0 && (
        <LayerCard>
          <LayerCard.Secondary>
            {detail.images.cover !== null ? "Images" : "Screenshots"}
          </LayerCard.Secondary>
          <LayerCard.Primary className="px-5 py-4">
            <ImageCarousel items={images} label={`${app.name} images`} />
          </LayerCard.Primary>
        </LayerCard>
      )}
      <Prerequisites
        detail={detail}
        checks={checks}
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
          permissions={appTokenPermissions(catalog)}
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
          appKey={detail.key ?? app.slug}
          varFields={detail.varFields}
          subdomain={detail.subdomain}
          canInstall={canInstall}
          defaultWorkerName={detail.suggestedWorkerName}
          fixedWorkerName={detail.fixedWorkerName}
          blockedReason={blockedReason}
          blockedLink={blocked?.link ?? null}
          requirementsConfirmed={confirmed}
          sandboxBuild={sandboxBuild}
          sandboxFirst={needsSandbox && detail.sandbox.state === "ready-auto"}
          installer={installer}
          cronTriggers={detail.cronTriggers}
          accountPlan={detail.accountPlan}
          planDetected={detail.capabilities.plan.source === "detected"}
        />
      )}
      {catalog !== null && detail.sourceBuilds && (
        <BuildFromSourceCard
          slug={detail.key ?? app.slug}
          appName={app.name}
          repo={catalog.repo}
          pinnedRef={catalog.source.ref}
          sandbox={detail.sandbox}
        />
      )}
    </>
  );
}

/** One centred fact of the About grid: a small label above its value. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid content-start justify-items-center gap-1.5 text-center">
      <Text as="span" variant="secondary" size="sm">
        {label}
      </Text>
      <div className="flex min-w-0 flex-wrap items-center justify-center gap-2">{children}</div>
    </div>
  );
}

const LINK_ICONS: Record<AuthorLink["kind"], Icon> = {
  github: GithubLogoIcon,
  x: XLogoIcon,
  website: GlobeIcon,
};

/** An external link as an icon button; Kumo's `title` puts the label in a tooltip. */
function IconLink({ href, icon: LinkIcon, label }: { href: string; icon: Icon; label: string }) {
  return (
    <LinkButton
      href={href}
      external
      variant="ghost"
      shape="square"
      icon={<LinkIcon size={18} aria-hidden />}
      aria-label={label}
      title={label}
    />
  );
}

/** The host of a URL without `www.`, for link labels. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * The app at a glance, as a centred grid of facts (version, license, the
 * catalog's install check, popularity, links) with a line on what the
 * license allows, then who wrote and who packages it, then the Cloudflare
 * primitives it uses and whether this account offers each.
 */
function AboutCard({ detail }: { detail: CatalogDetail }) {
  const { app, catalog } = detail;
  if (app === null) return null;
  const repoUrl = catalog === null ? null : `https://github.com/${catalog.repo}`;
  const homepage =
    catalog === null || catalog.homepage.replace(/\/$/, "") === repoUrl ? null : catalog.homepage;
  const hasPopularity =
    detail.popularity !== null &&
    (detail.popularity.stars !== null || detail.popularity.installsKnown);
  // Popularity is published for the official catalog's apps only.
  const showsPopularity = detail.source?.official !== false;
  return (
    <LayerCard>
      <LayerCard.Secondary className="flex flex-wrap items-center justify-between gap-3">
        <span>About</span>
        <div className="flex flex-wrap items-center gap-2">
          <TierBadge tier={app.tier} />
          <PlanBadge plan={app.plan} />
          {detail.appLicense !== null && <LicenseBadge license={detail.appLicense} />}
        </div>
      </LayerCard.Secondary>
      <LayerCard.Primary className="grid gap-5 px-5 py-4">
        <div
          className={cn(
            "mx-auto grid w-full max-w-5xl grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3",
            showsPopularity ? "lg:grid-cols-6" : "lg:grid-cols-5",
          )}
        >
          <Fact label="Version">
            <span className="font-mono text-[0.9em]">{app.version}</span>
          </Fact>
          <Fact label="License">
            {detail.appLicense === null ? (
              <Text as="span" variant="secondary">
                Not known
              </Text>
            ) : (
              <License
                license={detail.appLicense}
                pinned={catalog === null ? null : { repo: catalog.repo, sha: catalog.source.sha }}
              />
            )}
          </Fact>
          {detail.source !== null && (
            <Fact label="Source">
              <CatalogSourceBadge source={detail.source} />
            </Fact>
          )}
          <Fact label="Install check">
            <InstallCheckBadge lastVerified={app.lastVerified} />
          </Fact>
          {showsPopularity && (
            <Fact label="Popularity">
              {hasPopularity ? (
                <PopularityLine popularity={detail.popularity} className="justify-center" />
              ) : (
                <Text as="span" variant="secondary">
                  No numbers yet
                </Text>
              )}
            </Fact>
          )}
          <Fact label="Links">
            {repoUrl === null && homepage === null ? (
              <Text as="span" variant="secondary">
                None
              </Text>
            ) : (
              <span className="flex items-center gap-1">
                {repoUrl !== null && (
                  <IconLink
                    href={repoUrl}
                    icon={GithubLogoIcon}
                    label={`Source code: ${catalog?.repo ?? ""}`}
                  />
                )}
                {homepage !== null && (
                  <IconLink
                    href={homepage}
                    icon={GlobeIcon}
                    label={`Homepage: ${hostOf(homepage)}`}
                  />
                )}
              </span>
            )}
          </Fact>
        </div>
        {detail.appLicense !== null && (
          <div className="mx-auto max-w-3xl text-center">
            <Text as="p" variant="secondary" size="sm">
              {licenseBadgeCopy(detail.appLicense).tooltip}
            </Text>
          </div>
        )}
        <div className="mx-auto grid w-full max-w-5xl gap-5 border-kumo-hairline border-t pt-5 sm:grid-cols-2">
          <Fact label={detail.authors.length === 1 ? "Author" : "Authors"}>
            {detail.authors.length === 0 ? (
              <Text as="span" variant="secondary">
                Not known
              </Text>
            ) : (
              detail.authors.map((author) => (
                <Author
                  key={author.name}
                  author={author}
                  // Avatars come through the official catalog's proxy only; others get monograms.
                  withAvatar={detail.source?.official !== false}
                />
              ))
            )}
          </Fact>
          <Fact label="Packaged by">
            <Maintainers maintainers={app.maintainers} />
          </Fact>
        </div>
        <div className="mx-auto grid w-full max-w-5xl border-kumo-hairline border-t pt-5">
          <Fact label="Runs on">
            <PrimitiveBadges
              primitives={detail.primitives}
              capabilities={detail.capabilities}
              tier={app.tier}
            />
          </Fact>
        </div>
        {(app.tier === "sandbox" || app.tier === "self-deploying") && app.build !== undefined && (
          <div className="mx-auto w-full max-w-5xl border-kumo-hairline border-t pt-5">
            <DescriptionList>
              {app.tier === "sandbox" ? (
                <BuildRow build={app.build} />
              ) : (
                <InstallerRow
                  build={app.build}
                  tool={
                    catalog?.install.selfDeploying === undefined
                      ? null
                      : SELF_DEPLOYING_TOOLS[catalog.install.selfDeploying.tool].label
                  }
                />
              )}
            </DescriptionList>
          </div>
        )}
      </LayerCard.Primary>
    </LayerCard>
  );
}

/**
 * The license as the repository declares it: each SPDX id linked to a
 * plain-language explanation of it, a `SEE LICENSE IN <file>` license as a
 * link to that file at the pinned commit, and plain words for no license.
 */
function License({
  license,
  pinned,
}: {
  license: AppLicense;
  /** Where the license file lives; null while the catalog manifest is not loaded. */
  pinned: { repo: string; sha: string } | null;
}) {
  const { expression } = license;
  const copy = licenseBadgeCopy(license);
  if (copy.kind === "none") {
    return <Text as="span">{copy.label}</Text>;
  }
  const fileHref = pinned === null ? null : licenseFileHref(expression, pinned.repo, pinned.sha);
  if (fileHref !== null) {
    return (
      <Link href={fileHref} target="_blank" rel="noopener noreferrer">
        {licenseFile(expression)}
        <Link.ExternalIcon />
      </Link>
    );
  }
  // Text that is not an SPDX expression is shown as it is, with nothing linked.
  if (copy.label !== expression || !isLicense(expression)) {
    return <Text as="span">{copy.label}</Text>;
  }
  return (
    <span>
      {licenseParts(expression).map((part, i) =>
        part.href === null ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed string never reorder
          <span key={i}>{part.text}</span>
        ) : (
          <Link
            // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed string never reorder
            key={i}
            href={part.href}
            target="_blank"
            rel="noopener noreferrer"
          >
            {part.text}
            <Link.ExternalIcon />
          </Link>
        ),
      )}
    </span>
  );
}

/** An author: avatar (GitHub's, through the manager, or a monogram), name, and their links as icons. */
function Author({ author, withAvatar }: { author: CatalogAuthor; withAvatar: boolean }) {
  return (
    <span className="inline-flex items-center gap-2">
      <AuthorAvatar
        src={withAvatar ? avatarSrc(author.github) : null}
        name={author.name}
        size={28}
      />
      <Text as="span">{author.name}</Text>
      <span className="inline-flex items-center">
        {authorLinks(author).map((link) => (
          <IconLink
            key={link.href}
            href={link.href}
            icon={LINK_ICONS[link.kind]}
            label={`${author.name} on ${link.label}`}
          />
        ))}
      </span>
    </span>
  );
}

/** The catalog maintainers, each linked to GitHub where the handle allows. */
function Maintainers({ maintainers }: { maintainers: string[] }) {
  return (
    <span className="flex flex-wrap justify-center gap-x-3">
      {maintainers.map((handle) => {
        const profile = maintainerProfile(handle);
        return profile.href === null ? (
          <span key={handle}>{profile.label}</span>
        ) : (
          <Link key={handle} href={profile.href} target="_blank" rel="noopener noreferrer">
            {profile.label}
            <Link.ExternalIcon />
          </Link>
        );
      })}
    </span>
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
          {buildCostLine(estimate)}
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

/** The sentence and probe badge for one pending requirement. */
function PendingRequirement({ check, detail }: { check: RequirementCheck; detail: CatalogDetail }) {
  const { app } = detail;
  if (app === null) return null;
  if (check.key === "plan") {
    return (
      <li>
        <span className="font-semibold">Workers Paid.</span> This app needs the Workers Paid plan on
        this account.{" "}
        {check.availability === "unavailable" && (
          <CapabilityBadge badge={{ met: false, label: "Detected: Workers Free" }} />
        )}
      </li>
    );
  }
  return (
    <li>
      <span className="font-semibold">{check.label}.</span>{" "}
      {requirementSentence(check.key, {
        tier: app.tier,
        provisionsEmailRouting: detail.catalog?.install.emailRouting !== undefined,
      })}{" "}
      <CapabilityBadge badge={requirementBadge(check.key, detail.capabilities)} />
    </li>
  );
}

/**
 * Plan, account requirements, and what the install creates. The warning lists
 * only what this account is not known to offer (not available, or not
 * checked), each with one sentence; what the account is known to offer is one
 * quiet line. `confirmation` (shown only when the install form is) holds the
 * checkbox that enables the Install button while anything is left to confirm.
 */
function Prerequisites({
  detail,
  checks,
  confirmation,
}: {
  detail: CatalogDetail;
  checks: RequirementChecks;
  confirmation: RequirementsConfirmation | null;
}) {
  const { app } = detail;
  if (app === null) return null;
  const creates = [
    ...detail.creates.map((c) => `${resourceKindLabel(c.kind)} for ${c.binding}`),
    ...detail.durableObjects.map((d) => `Durable Object class ${d}`),
  ];
  const metLine =
    checks.met.length === 0
      ? null
      : `Available on this account: ${checks.met.map((c) => c.label).join(", ")}.`;
  return (
    <div className="grid gap-3">
      {checks.pending.length > 0 ? (
        <Banner
          variant="alert"
          icon={<WarningIcon weight="fill" />}
          title="Before you install"
          action={<DocsLink topic="requirements" variant="inline" />}
          description={
            <div className="grid gap-2">
              <span>Check that this account offers what the app needs:</span>
              <ul className="grid list-disc gap-1 pl-5">
                {checks.pending.map((check) => (
                  <PendingRequirement key={check.key} check={check} detail={detail} />
                ))}
              </ul>
              {metLine !== null && (
                <Text as="span" variant="secondary" size="sm">
                  {metLine}
                </Text>
              )}
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
            </div>
          }
        />
      ) : (
        metLine !== null && (
          <Banner
            variant="default"
            icon={<CheckCircleIcon weight="fill" />}
            title="This account meets the requirements"
            description={metLine}
          />
        )
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
