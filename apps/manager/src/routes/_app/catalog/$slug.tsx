import { accessNeededOnlyIfProtected, indexAccessNeededOnlyIfProtected } from "@appflare/schema";
import { Banner, Button, Empty } from "@cloudflare/kumo";
import { PlusIcon, StorefrontIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { createFileRoute, useLocation } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ANALYTICS_ENGINE_CAPABILITY_LINK } from "../../../capabilities/capability-rows";
import {
  type AppNeedsOf,
  accountNeeds,
  installAdds,
  needOfCheck,
} from "../../../catalog/account-needs";
import {
  appLinks,
  appStats,
  descriptionParagraphs,
  headerAction,
  provenance,
  settingsToChoose,
} from "../../../catalog/app-page";
import { type CatalogDetail, getCatalogEntry } from "../../../catalog/catalog.functions";
import { primitivesNote } from "../../../catalog/primitives";
import {
  analyticsEngineRefusal,
  type RequirementChecks,
  requirementChecks,
} from "../../../catalog/requirement-checks";
import { requirementSentence } from "../../../catalog/requirements";
import { AppPageHeader } from "../../../components/app-page-header";
import {
  AppSection,
  BeforeYouInstall,
  Description,
  InstallsList,
  LinksList,
  NeedsList,
  SettingsList,
} from "../../../components/app-page-sections";
import { AppStatStrip } from "../../../components/app-stat-strip";
import { BuildFromSourceCard } from "../../../components/build-from-source-card";
import { DocsLink } from "../../../components/docs-link";
import { InstallForm } from "../../../components/install-form";
import { plainMessage } from "../../../components/message-links";
import { MessageLinkButtons, MessageText } from "../../../components/message-text";
import { PageHeader } from "../../../components/page-header";
import { SANDBOX_CAPABILITY_LINK_LABEL } from "../../../components/sandbox-first";
import { ScreenshotGallery } from "../../../components/screenshot-gallery";
import { CATALOG_STALE_MS } from "../../../router-timing";
import { SANDBOX_CAPABILITY_HREF } from "../../../sandbox/readiness";

/**
 * `/catalog/$slug`: an app's page, laid out like an app store's. A header
 * with the icon, name, tagline, authors, where the build comes from, and one
 * action ("Install" opens the install form; "Manage" once it is installed); a
 * strip of small facts; the screenshots; then what the app is, what it needs
 * on the account, the settings the install asks for, links, and its installs
 * here. The install form (an app may be installed several times under
 * different Worker names, unless its Worker name is fixed) opens below when
 * "Install" is pressed, or when the page is opened at `#install`. When the
 * account is not known to offer everything the app asks for, the admin
 * confirms what is left above the form before Install enables.
 */
const CATALOG_CRUMB = { label: "Catalog", href: "/catalog" };

/** The page's fragment (without "#") that opens the install form, for links from elsewhere. */
const INSTALL_HASH = "install";

export const Route = createFileRoute("/_app/catalog/$slug")({
  loader: ({ params }) => getCatalogEntry({ data: { slug: params.slug } }),
  staleTime: CATALOG_STALE_MS,
  // The deepest route's title wins over the root's "<page> · Appflare".
  head: ({ loaderData }) => ({
    meta: [{ title: `${loaderData?.app?.name ?? "Catalog"} · Appflare` }],
  }),
  component: CatalogEntryPage,
});

function CatalogEntryPage() {
  const detail = Route.useLoaderData();
  const { slug } = Route.useParams();
  if (detail.app === null) {
    return (
      <>
        <PageHeader title="App not found" parents={[CATALOG_CRUMB]} />
        {detail.error !== null ? (
          <Empty
            icon={<WarningCircleIcon size={48} className="text-kumo-inactive" />}
            title="The catalog is unavailable"
            description={plainMessage(detail.error)}
            contents={<MessageLinkButtons message={detail.error} />}
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
  // Keyed by app, so the install form's state never carries over to another app's page.
  return <AppPage key={detail.key ?? slug} detail={detail} app={detail.app} />;
}

function AppPage({
  detail,
  app,
}: {
  detail: CatalogDetail;
  app: NonNullable<CatalogDetail["app"]>;
}) {
  const { viewer } = Route.useRouteContext();
  const { catalog } = detail;
  const canInstall = viewer.role === "admin";
  const installable = catalog !== null && detail.suggestedWorkerName !== null;
  const [installOpen, setInstallOpen] = useState(false);
  const installRef = useRef<HTMLElement>(null);
  const installedRef = useRef<HTMLDivElement>(null);
  /** Bumped by each request to open the form; once it is on the page, it is brought into view and focused. */
  const [revealRequest, setRevealRequest] = useState(0);
  const hash = useLocation({ select: (location) => location.hash });

  const openInstall = () => {
    setInstallOpen(true);
    setRevealRequest((n) => n + 1);
  };

  // Opening the page at `#install`, or changing the fragment to it while here.
  useEffect(() => {
    if (installable && hash === INSTALL_HASH) {
      setInstallOpen(true);
      setRevealRequest((n) => n + 1);
    }
  }, [installable, hash]);

  useEffect(() => {
    if (revealRequest > 0) reveal(installRef.current);
  }, [revealRequest]);

  const requires = [...new Set([...app.requires, ...(catalog?.requires ?? [])])];
  const needsOf: AppNeedsOf = {
    plan: app.plan,
    requires,
    tier: app.tier,
    // From the catalog manifest (a revision's, when there is one), else
    // from what the index row says of it.
    accessIfProtected:
      catalog !== null
        ? accessNeededOnlyIfProtected({ ...catalog, requires })
        : indexAccessNeededOnlyIfProtected(app),
  };
  const checks = requirementChecks(needsOf, detail.capabilities);
  const images = detail.images.screenshots;
  const paragraphs = descriptionParagraphs(app.summary);
  const settings = catalog === null ? [] : settingsToChoose(catalog.secrets, detail.varFields);
  const showsPopularity = detail.source?.official !== false;
  const stats = appStats({
    plan: app.plan,
    version: app.version,
    lastVerified: app.lastVerified,
    stars: showsPopularity ? (detail.popularity?.stars ?? null) : null,
    installs: showsPopularity ? detail.popularity : null,
    license: detail.appLicense,
    moduleBytes: detail.moduleBytes,
    categories: detail.categories,
    pin: catalog?.source.sha ?? app.build?.pin ?? null,
  });
  const action = headerAction(detail.instances, installable, canInstall);
  const multipleInstalls = !detail.fixedWorkerName && installable;

  return (
    <div className="grid gap-8">
      <div className="grid gap-6">
        <AppPageHeader
          name={app.name}
          iconSrc={detail.images.icon}
          tagline={app.tagline}
          authors={detail.authors}
          // Avatars come through the official catalog's proxy only; others get monograms.
          withAvatars={detail.source?.official !== false}
          provenance={provenance(detail.source, app.tier)}
          action={action}
          onInstall={openInstall}
          onManageSeveral={() => reveal(installedRef.current)}
        />
        <AppStatStrip stats={stats} />
      </div>

      {detail.error !== null && (
        <Banner
          variant="error"
          icon={<WarningCircleIcon weight="fill" />}
          title="This app cannot be installed right now"
          description={<MessageText message={detail.error} />}
        />
      )}

      <ScreenshotGallery images={images} appName={app.name} />

      {installOpen && installable && (
        <section
          ref={installRef}
          id="install"
          tabIndex={-1}
          aria-label={`Install ${app.name}`}
          className="grid scroll-mt-6 gap-4 outline-none"
        >
          <InstallPanel
            detail={detail}
            app={app}
            checks={checks}
            needsOf={needsOf}
            canInstall={canInstall}
          />
        </section>
      )}

      <AppSection title="About">
        <Description paragraphs={paragraphs} />
      </AppSection>

      <AppSection
        title="What it needs on your account"
        titleAction={<DocsLink topic="requirements" />}
      >
        <NeedsList
          needs={accountNeeds(needsOf, detail.primitives, detail.capabilities)}
          adds={
            app.tier === "artifact" && detail.createsKnown
              ? installAdds(detail.creates, detail.durableObjects, detail.cronTriggers)
              : null
          }
          note={primitivesNote(detail.primitives, app.tier)}
        />
      </AppSection>

      {settings.length > 0 && (
        <AppSection title="Settings you will choose">
          <SettingsList items={settings} />
        </AppSection>
      )}

      {catalog !== null && (
        <AppSection title="Links">
          <LinksList
            links={appLinks(catalog, detail.appLicense)}
            maintainers={app.maintainers}
            licenseNote={detail.appLicense?.note ?? null}
          />
        </AppSection>
      )}

      {detail.instances.length > 0 && (
        <div ref={installedRef} tabIndex={-1} className="scroll-mt-6 outline-none">
          <AppSection
            id="installed"
            title="On your account"
            actions={
              canInstall && multipleInstalls ? (
                <Button variant="secondary" icon={PlusIcon} onClick={openInstall}>
                  Install another
                </Button>
              ) : undefined
            }
          >
            <InstallsList instances={detail.instances} />
          </AppSection>
        </div>
      )}
    </div>
  );
}

/** Scrolls `el` into view and moves focus to it, as the target of "Install" or "Manage". */
function reveal(el: HTMLElement | null) {
  if (el === null) return;
  const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
  el.focus({ preventScroll: true });
}

/**
 * What "Install" opens: what is left to confirm about the account, the install
 * form (which says how to create any token the app needs for itself, next to
 * the field that takes it), and building from source.
 */
function InstallPanel({
  detail,
  app,
  checks,
  needsOf,
  canInstall,
}: {
  detail: CatalogDetail;
  app: NonNullable<CatalogDetail["app"]>;
  checks: RequirementChecks;
  needsOf: AppNeedsOf;
  canInstall: boolean;
}) {
  const { catalog } = detail;
  const [requirementsConfirmed, setRequirementsConfirmed] = useState(false);
  if (catalog === null || detail.suggestedWorkerName === null) return null;
  const sandboxBuild = app.tier === "sandbox" ? (app.build ?? null) : null;
  const installer = app.tier === "self-deploying" ? (app.build ?? null) : null;
  // Sandbox builds off: the install turns them on first when the account
  // has what they need, and says what is missing otherwise.
  const needsSandbox = sandboxBuild !== null || installer !== null;
  const sandboxMissing = needsSandbox ? detail.sandbox.missing : null;
  const analyticsEngineOff = analyticsEngineRefusal(
    app.name,
    { requires: [...app.requires, ...catalog.requires], services: detail.primitives.ids },
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
            link: { href: SANDBOX_CAPABILITY_HREF, label: SANDBOX_CAPABILITY_LINK_LABEL },
          }
        : analyticsEngineOff !== null
          ? { reason: analyticsEngineOff, link: ANALYTICS_ENGINE_CAPABILITY_LINK }
          : null;
  const blockedReason = blocked?.reason ?? null;
  // Nothing left to confirm when the account is known to offer everything.
  const confirmed = requirementsConfirmed || checks.pending.length === 0;
  const disabledReason = !canInstall
    ? "Only admins can install apps."
    : blockedReason !== null
      ? "The install form below says why this app cannot be installed now."
      : null;
  return (
    <>
      {checks.pending.length > 0 && (
        <BeforeYouInstall
          rows={checks.pending.map((check) => ({
            need: needOfCheck(check, needsOf, detail.primitives, detail.capabilities),
            // The plan's row already says why; a requirement says what it means for this app.
            explanation:
              check.key === "plan"
                ? null
                : requirementSentence(check.key, {
                    tier: app.tier,
                    provisionsEmailRouting: catalog.install.emailRouting !== undefined,
                    accessIfProtected: needsOf.accessIfProtected === true,
                  }),
          }))}
          confirmed={requirementsConfirmed}
          onConfirmedChange={setRequirementsConfirmed}
          disabledReason={disabledReason}
        />
      )}
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
        capabilities={detail.capabilities}
      />
      {detail.sourceBuilds && (
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
