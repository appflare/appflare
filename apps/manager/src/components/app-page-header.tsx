import type { CatalogAuthor } from "@appflare/schema";
import { Badge, Breadcrumbs, Button, LinkButton, Text } from "@cloudflare/kumo";
import {
  BookOpenIcon,
  GithubLogoIcon,
  GlobeIcon,
  HammerIcon,
  type Icon,
  PackageIcon,
  XLogoIcon,
} from "@phosphor-icons/react";
import { Fragment } from "react";
import type { HeaderAction, Provenance } from "../catalog/app-page";
import { type AuthorLink, authorLinks } from "../catalog/authors";
import { avatarSrc } from "../catalog/avatar";
import { AppIcon, AuthorAvatar } from "./catalog-media";
import { Tooltip } from "./tooltip";

/**
 * The top of an app's catalog page, app-store style: a large icon, the name,
 * a one-line tagline, who made it, where the build comes from (the only place
 * the page says so), and one action at the right: "Install" or "Manage".
 * The version is in the stat strip below, not here.
 */
export function AppPageHeader({
  name,
  iconSrc,
  tagline,
  authors,
  withAvatars,
  provenance,
  action,
  onInstall,
  onManageSeveral,
}: {
  name: string;
  iconSrc: string | null;
  tagline: string;
  authors: readonly CatalogAuthor[];
  /** Author avatars come through the official catalog's proxy only; others get monograms. */
  withAvatars: boolean;
  provenance: Provenance;
  action: HeaderAction;
  /** Opens the install form. */
  onInstall: () => void;
  /** Shows the list of installs, for "Manage" with several. */
  onManageSeveral: () => void;
}) {
  return (
    <header className="grid gap-5">
      <Breadcrumbs size="sm">
        <Breadcrumbs.Link href="/catalog">Catalog</Breadcrumbs.Link>
        <Breadcrumbs.Separator />
        <Breadcrumbs.Current>{name}</Breadcrumbs.Current>
      </Breadcrumbs>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-4 gap-y-3 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:gap-x-6">
        <div className="row-span-2 sm:row-span-1">
          <AppIcon src={iconSrc} name={name} size={112} />
        </div>
        <div className="grid min-w-0 content-start gap-1.5">
          <Text variant="heading" size="lg" as="h1">
            {name}
          </Text>
          <Text as="p" variant="secondary">
            {tagline}
          </Text>
          <AuthorLine authors={authors} withAvatars={withAvatars} />
          <div className="pt-1">
            <ProvenanceBadge provenance={provenance} />
          </div>
        </div>
        {/* At most 12rem wide, so a member's reason cannot widen the header. */}
        <div className="col-start-2 grid min-w-0 max-w-48 justify-items-start gap-1.5 sm:col-start-3 sm:justify-items-center">
          <HeaderButton
            action={action}
            name={name}
            onInstall={onInstall}
            onManageSeveral={onManageSeveral}
          />
          {/* A member's reason stays visible here: touch screens have no hover for the tooltip. */}
          {action.kind === "install" && action.reason !== null && (
            <Text as="span" variant="secondary" size="xs">
              <span className="block sm:text-center">{action.reason}</span>
            </Text>
          )}
        </div>
      </div>
    </header>
  );
}

/**
 * Kumo's standard button, sized to its label (a minimum width would leave the
 * label off centre, since Kumo's button does not centre its content).
 */
function HeaderButton({
  action,
  name,
  onInstall,
  onManageSeveral,
}: {
  action: HeaderAction;
  name: string;
  onInstall: () => void;
  onManageSeveral: () => void;
}) {
  if (action.kind === "install") {
    // Kumo's `title` on a disabled button is a tooltip on a wrapper, which gets the pointer
    // events the button does not; the reason is also in the name, since it cannot take focus.
    return (
      <Button
        variant="primary"
        disabled={action.disabled}
        onClick={onInstall}
        aria-label={
          action.reason === null ? `Install ${name}` : `Install ${name}. ${action.reason}.`
        }
        {...(action.reason === null ? {} : { title: action.reason })}
      >
        Install
      </Button>
    );
  }
  if (action.href !== null) {
    return (
      <LinkButton href={action.href} variant="primary" aria-label={`Manage ${name}`}>
        Manage
      </LinkButton>
    );
  }
  return (
    <Button
      variant="primary"
      onClick={onManageSeveral}
      aria-label={`Manage ${name}: ${action.count} installs`}
    >
      Manage
    </Button>
  );
}

const PROVENANCE_ICONS: Record<Provenance["kind"], Icon> = {
  catalog: PackageIcon,
  yours: HammerIcon,
  custom: BookOpenIcon,
};

/** Where the build comes from: a small neutral badge, its meaning in the tooltip. */
function ProvenanceBadge({ provenance }: { provenance: Provenance }) {
  const ProvenanceIcon = PROVENANCE_ICONS[provenance.kind];
  return (
    <Tooltip content={provenance.tooltip}>
      <Badge variant="neutral" icon={<ProvenanceIcon aria-hidden />}>
        {provenance.label}
      </Badge>
    </Tooltip>
  );
}

const AUTHOR_LINK_ICONS: Record<AuthorLink["kind"], Icon> = {
  github: GithubLogoIcon,
  x: XLogoIcon,
  website: GlobeIcon,
};

/**
 * "By Alice and Bob": each author with their avatar and their own links
 * (GitHub, X, website) as small icon buttons, named in their tooltips.
 */
function AuthorLine({
  authors,
  withAvatars,
}: {
  authors: readonly CatalogAuthor[];
  withAvatars: boolean;
}) {
  if (authors.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1">
      <Text as="span" variant="secondary" size="sm">
        By
      </Text>
      {authors.map((author, i) => {
        const separator = i === 0 ? "" : i === authors.length - 1 ? "and" : ",";
        return (
          <Fragment key={author.name}>
            {separator !== "" && (
              <Text as="span" variant="secondary" size="sm">
                {separator}
              </Text>
            )}
            <span className="inline-flex items-center gap-1.5">
              <AuthorAvatar
                src={withAvatars ? avatarSrc(author.github) : null}
                name={author.name}
                size={20}
              />
              <Text as="span" size="sm">
                {author.name}
              </Text>
              <span className="inline-flex items-center">
                {authorLinks(author).map((link) => (
                  <LinkButton
                    key={link.href}
                    href={link.href}
                    external
                    variant="ghost"
                    shape="square"
                    size="xs"
                    icon={AUTHOR_LINK_ICONS[link.kind]}
                    aria-label={`${author.name} on ${link.label}`}
                    title={`${author.name} on ${link.label}`}
                  />
                ))}
              </span>
            </span>
          </Fragment>
        );
      })}
    </div>
  );
}
