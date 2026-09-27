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
 * the page says so), and one action at the right: "Get" or "Manage", with the
 * version quietly under it.
 */
export function AppPageHeader({
  name,
  iconSrc,
  tagline,
  authors,
  withAvatars,
  provenance,
  action,
  version,
  onGet,
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
  version: string;
  /** Opens the install form. */
  onGet: () => void;
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
        <div className="col-start-2 grid justify-items-start gap-1 sm:col-start-3 sm:justify-items-center">
          <HeaderButton
            action={action}
            name={name}
            onGet={onGet}
            onManageSeveral={onManageSeveral}
          />
          {/* A member's reason stays visible here: touch screens have no hover for the tooltip. */}
          <Text as="span" variant="secondary" size="xs">
            {action.kind === "get" && action.reason !== null ? action.reason : `Version ${version}`}
          </Text>
        </div>
      </div>
    </header>
  );
}

function HeaderButton({
  action,
  name,
  onGet,
  onManageSeveral,
}: {
  action: HeaderAction;
  name: string;
  onGet: () => void;
  onManageSeveral: () => void;
}) {
  if (action.kind === "get") {
    // Kumo's `title` on a disabled button is a tooltip on a wrapper, which gets the pointer
    // events the button does not; the reason is also in the name, since it cannot take focus.
    return (
      <Button
        variant="primary"
        className="min-w-28"
        disabled={action.disabled}
        onClick={onGet}
        aria-label={action.reason === null ? `Get ${name}` : `Get ${name}. ${action.reason}.`}
        {...(action.reason === null ? {} : { title: action.reason })}
      >
        Get
      </Button>
    );
  }
  if (action.href !== null) {
    return (
      <LinkButton
        href={action.href}
        variant="primary"
        className="min-w-28"
        aria-label={`Manage ${name}`}
      >
        Manage
      </LinkButton>
    );
  }
  return (
    <Button
      variant="primary"
      className="min-w-28"
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
