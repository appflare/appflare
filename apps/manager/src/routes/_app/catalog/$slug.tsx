import { Badge, Banner, Empty, LayerCard, Link, LinkButton, Text } from "@cloudflare/kumo";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  InfoIcon,
  StorefrontIcon,
  WarningCircleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { type CatalogDetail, getCatalogEntry } from "../../../catalog/catalog.functions";
import { formatDateTime, requirementLabel, resourceKindLabel } from "../../../components/format";
import { InstallForm } from "../../../components/install-form";
import { PageHeader } from "../../../components/page-header";
import { PlanBadge, StatusBadge } from "../../../components/status-badge";

/** `/catalog/$slug`: app detail, prerequisites, and the install form. */
export const Route = createFileRoute("/_app/catalog/$slug")({
  loader: ({ params }) => getCatalogEntry({ data: { slug: params.slug } }),
  component: CatalogEntryPage,
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

function CatalogEntryPage() {
  const detail = Route.useLoaderData();
  const { viewer } = Route.useRouteContext();
  const { slug } = Route.useParams();
  const back = (
    <LinkButton href="/catalog" variant="ghost" icon={<ArrowLeftIcon />}>
      Catalog
    </LinkButton>
  );

  if (detail.app === null) {
    return (
      <>
        <PageHeader title="Catalog" actions={back} />
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
  return (
    <>
      <PageHeader title={app.name} description={app.summary} actions={back} />
      <AboutCard detail={detail} />
      <Prerequisites detail={detail} />
      {detail.error !== null && (
        <Banner
          variant="error"
          icon={<WarningCircleIcon weight="fill" />}
          title="The install form is unavailable"
          description={detail.error}
        />
      )}
      {detail.installed !== null && (
        <Banner
          variant="secondary"
          icon={<InfoIcon weight="fill" />}
          title={`${app.name} is installed as "${detail.installed.workerName}".`}
          description="Appflare installs one instance per app."
          action={
            <LinkButton
              href={`/apps/${detail.installed.installId}`}
              variant="secondary"
              icon={<ArrowRightIcon />}
            >
              Open install
            </LinkButton>
          }
        />
      )}
      {catalog !== null && (
        <InstallForm
          catalog={catalog}
          canInstall={viewer.role === "admin"}
          blockedReason={
            detail.installed !== null ? `${app.name} is already installed in this account.` : null
          }
        />
      )}
    </>
  );
}

function AboutCard({ detail }: { detail: CatalogDetail }) {
  const { app, catalog } = detail;
  if (app === null) return null;
  return (
    <LayerCard>
      <LayerCard.Secondary className="flex items-center justify-between gap-3">
        <span>About</span>
        <div className="flex items-center gap-2">
          {detail.installed !== null && (
            <StatusBadge status={detail.installed.status} of="install" />
          )}
          <PlanBadge plan={app.plan} />
        </div>
      </LayerCard.Secondary>
      <LayerCard.Primary className="px-5 py-4">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2">
          <Row label="Version">
            <span className="font-mono text-[0.9em]">{app.version}</span>
          </Row>
          {catalog !== null && (
            <>
              <Row label="Source">
                <Link
                  href={`https://github.com/${catalog.repo}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {catalog.repo}
                  <Link.ExternalIcon />
                </Link>
              </Row>
              <Row label="Homepage">
                <Link href={catalog.homepage} target="_blank" rel="noopener noreferrer">
                  {catalog.homepage}
                  <Link.ExternalIcon />
                </Link>
              </Row>
              <Row label="License">{catalog.license}</Row>
            </>
          )}
          <Row label="Maintainers">{app.maintainers.join(", ")}</Row>
          <Row label="Last verified">
            {app.lastVerified !== null ? formatDateTime(app.lastVerified) : "Not verified yet"}
          </Row>
        </dl>
      </LayerCard.Primary>
    </LayerCard>
  );
}

/** Plan, account requirements, and what the install creates. */
function Prerequisites({ detail }: { detail: CatalogDetail }) {
  const { app } = detail;
  if (app === null) return null;
  const creates = [
    ...detail.creates.map((c) => `${resourceKindLabel(c.kind)} for ${c.binding}`),
    ...detail.durableObjects.map((d) => `Durable Object class ${d}`),
  ];
  return (
    <div className="grid gap-3">
      {(app.plan === "paid" || app.requires.length > 0) && (
        <Banner
          variant="alert"
          icon={<WarningIcon weight="fill" />}
          title="Before you install"
          description={
            <span className="grid gap-1">
              {app.plan === "paid" && (
                <span>This app needs the Workers Paid plan on this account.</span>
              )}
              {app.requires.length > 0 && (
                <span>
                  It also needs: {app.requires.map(requirementLabel).join(", ")}. Appflare does not
                  check these; the install fails if one is missing.
                </span>
              )}
            </span>
          }
        />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Text variant="secondary" size="sm">
          The install creates a Worker
          {creates.length > 0 ? " and:" : ", nothing else."}
        </Text>
        {creates.map((c) => (
          <Badge key={c} variant="outline">
            {c}
          </Badge>
        ))}
      </div>
    </div>
  );
}
