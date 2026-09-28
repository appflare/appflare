import { hasFixedWorkerName } from "@appflare/schema";
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  Empty,
  Link,
  LinkButton,
  Table,
  Text,
} from "@cloudflare/kumo";
import {
  ArrowCircleUpIcon,
  ArrowRightIcon,
  CheckCircleIcon,
  GitBranchIcon,
  TrashIcon,
  WarningCircleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { requirementBadge } from "../../../capabilities/capabilities";
import { CapabilityBadge } from "../../../capabilities/capability-badge";
import { ANALYTICS_ENGINE_CAPABILITY_LINK } from "../../../capabilities/capability-rows";
import { cronTriggerCount } from "../../../catalog/cron-triggers";
import { analyticsEngineRefusal } from "../../../catalog/requirement-checks";
import { requirementSentence } from "../../../catalog/requirements";
import { AppflareLoader } from "../../../components/appflare-loader";
import { PrimitiveBadges } from "../../../components/catalog-badges";
import { DescriptionItem, DescriptionList } from "../../../components/description-list";
import { DocsLink } from "../../../components/docs-link";
import { TechnicalNamesSwitch, useShowTechnicalNames } from "../../../components/field-label";
import { resourceKindLabel } from "../../../components/format";
import { InstallForm } from "../../../components/install-form";
import { useJobStarted } from "../../../components/job-started";
import { ErrorMessageBanner, MessageText } from "../../../components/message-text";
import { OriginBadge } from "../../../components/origin-badge";
import { PageHeader } from "../../../components/page-header";
import {
  initialSecretValues,
  SecretFields,
  secretsComplete,
  withSecretValue,
} from "../../../components/secret-fields";
import { Section, SectionBody, SectionRows, SectionTable } from "../../../components/section";
import { Timestamp } from "../../../components/timestamp";
import {
  discardSourceBuild,
  getSourceBuild,
  type SourceBuildReview,
  type SourceBuildView,
  updateFromSourceBuild,
} from "../../../installs/source-builds.functions";

/**
 * `/catalog/source/$buildId`: the review of a build from a repository (or
 * of a catalog app from source) before anything is deployed. While it builds,
 * a link to its log (the page refreshes itself); once built, where it came
 * from and what the sandbox Worker worked out, every reason Appflare would
 * refuse it (in the install job's own words), the resources it creates, the
 * services it uses and what the account must offer, and then the install
 * form (or, for an install being rebuilt, the update). "Not from the catalog,
 * not checked" throughout. An admin can throw the build away.
 */
export const Route = createFileRoute("/_app/catalog/source/$buildId")({
  staticData: { title: "Review a build" },
  loader: ({ params }) => getSourceBuild({ data: { buildId: params.buildId } }),
  component: ReviewPage,
});

const CATALOG_CRUMB = { label: "Catalog", href: "/catalog" };
const mono = "font-mono text-[0.9em]";

/** While the build runs, reload the page every few seconds. */
const POLL_MS = 5_000;

function titleOf(build: SourceBuildView): string {
  const name = build.review?.catalog.name ?? build.app?.name ?? build.repo;
  if (build.purpose === "update" && build.install !== null) {
    return `Review the update of ${build.install.label}`;
  }
  return `Review ${name}`;
}

function ReviewPage() {
  const build = Route.useLoaderData();
  const { viewer } = Route.useRouteContext();
  const router = useRouter();
  const isAdmin = viewer.role === "admin";
  const building = build?.status === "building";
  useEffect(() => {
    if (!building) return;
    const timer = setInterval(() => void router.invalidate(), POLL_MS);
    return () => clearInterval(timer);
  }, [building, router]);

  if (build === null) {
    return (
      <>
        <PageHeader title="Build not found" parents={[CATALOG_CRUMB]} />
        <Empty
          icon={<GitBranchIcon size={48} className="text-kumo-inactive" />}
          title="No such build"
          description="The link may be wrong."
        />
      </>
    );
  }
  const parents =
    build.purpose === "update" && build.install !== null
      ? [{ label: build.install.label, href: `/apps/${build.install.id}` }]
      : [CATALOG_CRUMB];
  return (
    <>
      <PageHeader
        title={titleOf(build)}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <OriginBadge origin={build.origin} />
            <span>
              {build.repo}
              {build.ref !== null ? ` at ${build.ref}` : ""}
            </span>
          </span>
        }
        parents={parents}
        actions={
          <LinkButton href={`/jobs/${build.id}`} variant="secondary" icon={<ArrowRightIcon />}>
            Build log
          </LinkButton>
        }
      />
      <BuildState build={build} isAdmin={isAdmin} />
      {build.review !== null && <Review build={build} review={build.review} isAdmin={isAdmin} />}
    </>
  );
}

function DiscardButton({ buildId }: { buildId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function discard() {
    setPending(true);
    setError(null);
    try {
      await discardSourceBuild({ data: { buildId } });
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not throw the build away.");
    }
    setPending(false);
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        variant="secondary-destructive"
        icon={<TrashIcon />}
        loading={pending}
        onClick={() => void discard()}
      >
        Throw away
      </Button>
      {error !== null && (
        <Text as="span" variant="error" size="sm">
          {error}
        </Text>
      )}
    </span>
  );
}

/** Where the build stands when it is not waiting for review. */
function BuildState({ build, isAdmin }: { build: SourceBuildView; isAdmin: boolean }) {
  switch (build.status) {
    case "building":
      return (
        <Banner
          variant="secondary"
          icon={<AppflareLoader size="sm" />}
          title="Building in your sandbox Worker"
          description="This page shows the review once the build is done. Its log shows each step as it runs."
          action={
            <LinkButton href={`/jobs/${build.id}`} variant="secondary" icon={<ArrowRightIcon />}>
              View log
            </LinkButton>
          }
        />
      );
    case "failed":
      return (
        <Banner
          variant="error"
          icon={<WarningCircleIcon weight="fill" />}
          title="The build failed"
          description={
            <span className="grid gap-2">
              <span>
                {build.error === null ? (
                  "The build did not finish."
                ) : (
                  <MessageText message={build.error} />
                )}
              </span>
              <span>
                Nothing was deployed. Fix what the log names, or choose another branch or build
                command, and build again. <DocsLink topic="sourceBuildJob" variant="inline" />
              </span>
            </span>
          }
          action={isAdmin ? <DiscardButton buildId={build.id} /> : undefined}
        />
      );
    case "discarded":
      return (
        <Banner
          variant="secondary"
          icon={<TrashIcon />}
          title="This build was thrown away"
          description="Its files are deleted from your sandbox Worker's bucket. Build again to install it."
        />
      );
    case "used":
      return (
        <Banner
          variant="default"
          icon={<CheckCircleIcon weight="fill" />}
          title={
            build.purpose === "update"
              ? "The install was updated from this build"
              : "Installed from this build"
          }
          action={
            build.install !== null ? (
              <LinkButton
                href={`/apps/${build.install.id}`}
                variant="secondary"
                icon={<ArrowRightIcon />}
              >
                View install
              </LinkButton>
            ) : undefined
          }
        />
      );
    default:
      return null;
  }
}

function Review({
  build,
  review,
  isAdmin,
}: {
  build: SourceBuildView;
  review: SourceBuildReview;
  isAdmin: boolean;
}) {
  const [requirementsConfirmed, setRequirementsConfirmed] = useState(false);
  const confirmed = requirementsConfirmed || review.checks.pending.length === 0;
  const waiting = build.status === "built";
  const refused = review.problems.length > 0;
  const analyticsEngineOff = analyticsEngineRefusal(
    review.catalog.name,
    { requires: review.requires, bindings: review.bindings },
    review.capabilities,
  );
  return (
    <>
      <SourceCard build={build} review={review} />
      {refused && (
        <Banner
          variant="error"
          icon={<WarningCircleIcon weight="fill" />}
          title={
            build.purpose === "update"
              ? "This build cannot be deployed"
              : "This build cannot be installed"
          }
          description={
            <ul className="grid list-disc gap-1 pl-5">
              {review.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          }
        />
      )}
      {review.baseline !== null &&
        (review.baseline.added.length > 0 || review.baseline.removed.length > 0) && (
          <Banner
            variant="alert"
            icon={<WarningIcon weight="fill" />}
            title="This commit's bindings differ from the catalog's release"
            description={
              <span className="grid gap-1">
                {review.baseline.added.length > 0 && (
                  <span>New here: {review.baseline.added.join(", ")}.</span>
                )}
                {review.baseline.removed.length > 0 && (
                  <span>Not here any more: {review.baseline.removed.join(", ")}.</span>
                )}
              </span>
            }
          />
        )}
      <WhatItDeclares review={review} />
      <Requirements
        build={build}
        review={review}
        confirmation={
          waiting && build.purpose === "install"
            ? { checked: requirementsConfirmed, onChange: setRequirementsConfirmed }
            : null
        }
      />
      {waiting && build.purpose === "install" && (
        <InstallForm
          catalog={review.catalog}
          // A catalog app built from source: its app key names its catalog.
          {...(build.app === null ? {} : { appKey: build.app.slug })}
          varFields={review.varFields}
          subdomain={review.subdomain}
          canInstall={isAdmin}
          defaultWorkerName={review.suggestedWorkerName}
          fixedWorkerName={hasFixedWorkerName(review.catalog.install)}
          blockedReason={
            refused
              ? "This build cannot be installed; the problems are listed above."
              : analyticsEngineOff
          }
          blockedLink={
            !refused && analyticsEngineOff !== null ? ANALYTICS_ENGINE_CAPABILITY_LINK : null
          }
          requirementsConfirmed={confirmed}
          cronTriggers={cronTriggerCount(review.crons)}
          accountPlan={review.accountPlan}
          planDetected={review.planDetected}
          reviewedBuildId={build.id}
        />
      )}
      {waiting && build.purpose === "update" && (
        <UpdateFromBuild build={build} review={review} canUpdate={isAdmin && !refused} />
      )}
      {waiting && isAdmin && (
        <div className="flex justify-end">
          <DiscardButton buildId={build.id} />
        </div>
      )}
    </>
  );
}

/** Where the build came from and what the sandbox Worker worked out. */
function SourceCard({ build, review }: { build: SourceBuildView; review: SourceBuildReview }) {
  const detected = build.detected;
  return (
    <Section title="Source" badge={<OriginBadge origin={build.origin} />}>
      <SectionBody>
        <Text variant="secondary">
          {build.origin === "repository"
            ? "The catalog never reviewed this repository. Appflare checked that this build came from the commit below and that it installs like any other app, nothing more. Read what it declares before you install it, and install only code you trust."
            : `The catalog checked ${build.app?.name ?? "this app"}'s own release, not this commit. Appflare checked that this build came from the commit below, with the catalog's secrets and settings.`}{" "}
          <DocsLink topic="sourceBuildReview" variant="inline" />
        </Text>
        <DescriptionList>
          <DescriptionItem label="App">
            {review.catalog.name}
            {review.catalog.summary !== "" && (
              <Text as="span" variant="secondary">
                {" "}
                {review.catalog.summary}
              </Text>
            )}
          </DescriptionItem>
          <DescriptionItem label="Repository">
            <Link href={build.repoUrl} target="_blank" rel="noopener noreferrer">
              {build.repo}
              <Link.ExternalIcon />
            </Link>
          </DescriptionItem>
          <DescriptionItem label="Built from">
            <span className={mono}>{build.ref ?? build.requestedRef ?? "the default branch"}</span>
            {build.commit !== null && (
              <Text as="span" variant="secondary">
                {" "}
                at <span className={mono}>{build.commit.slice(0, 12)}</span>
              </Text>
            )}
          </DescriptionItem>
          <DescriptionItem label="Version">
            <span className={mono}>{build.version ?? "unknown"}</span>
          </DescriptionItem>
          <DescriptionItem label="License">{review.catalog.license}</DescriptionItem>
          {detected !== null && (
            <>
              <DescriptionItem label="Build command">
                {detected.buildCommand === null ? (
                  "None"
                ) : (
                  <span className={mono}>{detected.buildCommand}</span>
                )}
                <Text as="span" variant="secondary">
                  {" "}
                  {BUILD_COMMAND_FROM[detected.buildCommandFrom]}
                </Text>
              </DescriptionItem>
              <DescriptionItem label="Dependencies">
                {detected.installDirs === undefined ? (
                  <>Installed with {detected.packageManager}, install scripts disabled</>
                ) : (
                  <span className="grid gap-0.5">
                    <span>Installed in this order, install scripts disabled:</span>
                    {detected.installDirs.map((dir) => (
                      <span key={dir.path}>
                        <span className={mono}>{dir.path}</span>
                        {dir.lockfile === "none" && (
                          <Text as="span" variant="secondary">
                            {" "}
                            (no lockfile upstream)
                          </Text>
                        )}
                      </span>
                    ))}
                  </span>
                )}
              </DescriptionItem>
              <DescriptionItem label="Wrangler config">
                <span className={mono}>{detected.wranglerConfig}</span>
              </DescriptionItem>
            </>
          )}
          <DescriptionItem label="Built">
            <span className="grid gap-0.5">
              <span>
                In your sandbox Worker with <span className={mono}>{build.image ?? "unknown"}</span>
                , unsigned
              </span>
              {build.builtAt !== null && (
                <Text as="span" variant="secondary" size="sm">
                  <Timestamp iso={build.builtAt} />
                </Text>
              )}
            </span>
          </DescriptionItem>
          {build.purpose === "update" && build.install !== null && (
            <DescriptionItem label="Installed now">
              <span className={mono}>{build.install.version}</span>
              {build.install.commit !== null && (
                <Text as="span" variant="secondary">
                  {" "}
                  from <span className={mono}>{build.install.commit.slice(0, 12)}</span>
                  {build.install.commit === build.commit ? " (the same commit)" : ""}
                </Text>
              )}
            </DescriptionItem>
          )}
        </DescriptionList>
      </SectionBody>
    </Section>
  );
}

const BUILD_COMMAND_FROM: Record<string, string> = {
  entered: "(the one you entered)",
  catalog: "(the catalog's for this app)",
  "package.json": "(its package.json build script)",
  none: "",
};

/**
 * Secrets or settings as a list in a sentence: each by its label (its name
 * when it has none), with the name the app reads it as after it while
 * technical names are shown. "none" for an empty list.
 */
function DeclaredNames({
  items,
  showNames,
}: {
  items: ReadonlyArray<{ name: string; label?: string; note: string | null }>;
  showNames: boolean;
}) {
  if (items.length === 0) return <>none</>;
  return (
    <>
      {items.map((item, i) => {
        const label = item.label === undefined || item.label === "" ? item.name : item.label;
        return (
          <span key={item.name}>
            {i > 0 && ", "}
            {label}
            {showNames && label !== item.name && (
              <>
                {" "}
                <span className={mono}>{item.name}</span>
              </>
            )}
            {item.note !== null && ` (${item.note})`}
          </span>
        );
      })}
    </>
  );
}

/** Bindings, resources, crons, secrets and settings. */
function WhatItDeclares({ review }: { review: SourceBuildReview }) {
  // The bindings, and the names the code reads secrets and settings as, are technical detail.
  const [showNames] = useShowTechnicalNames();
  // What the install creates, by kind; the names the code gives them while technical names show.
  // Keyed by the full name, which is unique; shown by kind alone unless technical names show.
  const named = (kind: string, name: string) => ({
    key: `${kind} ${name}`,
    text: showNames ? `${kind} ${name}` : kind,
  });
  const creates = [
    ...review.creates.map((c) => named(resourceKindLabel(c.kind), `for ${c.binding}`)),
    ...review.durableObjects.map((d) => named("Durable Object class", d)),
    ...review.workflows.map((w) => named("Workflow", w)),
  ];
  const { secrets, vars } = review.catalog;
  const hasBindings = review.bindings.length > 0;
  const hasNames = hasBindings || creates.length > 0 || secrets.length > 0 || vars.length > 0;
  return (
    <Section
      title="What it declares"
      description="Read from the built Worker, as the install will use it."
      action={hasNames ? <TechnicalNamesSwitch /> : null}
    >
      <SectionRows>
        <SectionBody>
          <div className="flex flex-wrap items-center gap-2">
            <Text variant="secondary" size="sm">
              {creates.length > 0
                ? "The install creates a Worker and:"
                : "The install creates a Worker, nothing else."}
            </Text>
            {creates.map((c) => (
              <Badge key={c.key} variant="outline">
                {c.text}
              </Badge>
            ))}
          </div>
          {review.crons.length > 0 && (
            <Text variant="secondary" size="sm">
              Cron triggers: <span className={mono}>{review.crons.join(", ")}</span>
            </Text>
          )}
          <Text variant="secondary" size="sm">
            Secrets it asks for:{" "}
            <DeclaredNames
              items={secrets.map((s) => ({
                ...s,
                note: s.optional === true ? "optional" : null,
              }))}
              showNames={showNames}
            />
            . Settings:{" "}
            <DeclaredNames items={vars.map((v) => ({ ...v, note: null }))} showNames={showNames} />.
          </Text>
        </SectionBody>
        {hasBindings && showNames && (
          <SectionTable label="Bindings" minWidth="sm">
            <Table.Header>
              <Table.Row>
                <Table.Head>Binding</Table.Head>
                <Table.Head>Type</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {review.bindings.map((b) => (
                <Table.Row key={`${b.type} ${b.name}`}>
                  <Table.Cell>
                    <span className={mono}>{b.name}</span>
                  </Table.Cell>
                  <Table.Cell>
                    <span className={mono}>{b.type}</span>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </SectionTable>
        )}
      </SectionRows>
    </Section>
  );
}

/** The services it uses, and what the account must offer (confirmed before installing). */
function Requirements({
  build,
  review,
  confirmation,
}: {
  build: SourceBuildView;
  review: SourceBuildReview;
  confirmation: { checked: boolean; onChange(checked: boolean): void } | null;
}) {
  const { checks } = review;
  const metLine =
    checks.met.length === 0
      ? null
      : `Available on this account: ${checks.met.map((c) => c.label).join(", ")}.`;
  return (
    <Section title="Runs on" titleAction={<DocsLink topic="requirements" />}>
      <SectionBody>
        <PrimitiveBadges
          primitives={review.primitives}
          capabilities={review.capabilities}
          tier="sandbox"
        />
        {checks.pending.length > 0 ? (
          <Banner
            variant="alert"
            icon={<WarningIcon weight="fill" />}
            title={build.purpose === "update" ? "Before you update" : "Before you install"}
            description={
              <div className="grid gap-2">
                <span>Check that this account offers what the app needs:</span>
                <ul className="grid list-disc gap-1 pl-5">
                  {checks.pending.map((check) => (
                    <li key={check.key}>
                      <span className="font-semibold">{check.label}.</span>{" "}
                      {check.key === "plan"
                        ? "Built in a container, which needs the Workers Paid plan on this account."
                        : requirementSentence(check.key, { tier: "sandbox" })}{" "}
                      {check.key !== "plan" && (
                        <CapabilityBadge badge={requirementBadge(check.key, review.capabilities)} />
                      )}
                    </li>
                  ))}
                </ul>
                {metLine !== null && (
                  <Text as="span" variant="secondary" size="sm">
                    {metLine}
                  </Text>
                )}
                {confirmation !== null && (
                  <Checkbox
                    label="This account meets these requirements"
                    checked={confirmation.checked}
                    onCheckedChange={(checked: boolean) => confirmation.onChange(checked)}
                  />
                )}
              </div>
            }
          />
        ) : (
          metLine !== null && (
            <Text variant="secondary" size="sm">
              {metLine}
            </Text>
          )
        )}
      </SectionBody>
    </Section>
  );
}

/** Updating an install from its reviewed rebuild: new secrets, the preview question, then the update job. */
function UpdateFromBuild({
  build,
  review,
  canUpdate,
}: {
  build: SourceBuildView;
  review: SourceBuildReview;
  canUpdate: boolean;
}) {
  const jobStarted = useJobStarted();
  const [secrets, setSecrets] = useState(() =>
    initialSecretValues(review.needsSecrets, review.heldSecrets),
  );
  const [noPreview, setNoPreview] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready =
    canUpdate &&
    !pending &&
    secretsComplete(review.needsSecrets, secrets) &&
    (review.skipsPreview === null || noPreview);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready) return;
    setPending(true);
    setError(null);
    try {
      const { jobId } = await updateFromSourceBuild({
        data: {
          buildId: build.id,
          secrets,
          ...(review.skipsPreview === null ? {} : { confirmNoPreview: noPreview }),
        },
      });
      await jobStarted(jobId, "Update started");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the update.");
      setPending(false);
    }
  }

  return (
    <Section title={`Update ${build.install?.label ?? "the install"}`}>
      <SectionBody>
        <form className="grid gap-5" onSubmit={onSubmit}>
          <Text variant="secondary">
            The update takes a snapshot of the current version and of each D1 database, checks the
            new version before it serves traffic where Cloudflare allows it, and keeps the current
            one for a rollback.
          </Text>
          {review.skipsPreview !== null && (
            <div className="grid gap-3">
              <Banner
                variant="alert"
                icon={<WarningIcon weight="fill" />}
                title="No preview check for this update"
                description={`${review.skipsPreview}.`}
              />
              <Checkbox
                checked={noPreview}
                onCheckedChange={(checked: boolean) => setNoPreview(checked)}
                disabled={pending || !canUpdate}
                label="Update without checking the new version first"
              />
            </div>
          )}
          {review.needsSecrets.length > 0 && (
            <div className="grid gap-4">
              <div className="grid gap-1.5">
                <Text bold>New secrets</Text>
                <Text variant="secondary" size="sm">
                  This build needs secrets the app does not have yet. They are stored as encrypted
                  secrets on the app's Worker; Appflare keeps only their names.
                </Text>
              </div>
              <SecretFields
                secrets={review.needsSecrets}
                vars={review.catalog.vars}
                held={review.heldSecrets}
                values={secrets}
                onChange={(name, value) => setSecrets((s) => withSecretValue(s, name, value))}
                after="the update"
              />
            </div>
          )}
          {error !== null && <ErrorMessageBanner message={error} newTab />}
          <div className="flex justify-end">
            <Button
              type="submit"
              variant="primary"
              icon={<ArrowCircleUpIcon />}
              loading={pending}
              disabled={!ready}
            >
              Update
            </Button>
          </div>
        </form>
      </SectionBody>
    </Section>
  );
}
