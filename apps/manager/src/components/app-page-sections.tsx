import { Banner, Button, Checkbox, LayerCard, Link, Popover, Text } from "@cloudflare/kumo";
import {
  CheckCircleIcon,
  GithubLogoIcon,
  GlobeIcon,
  type Icon,
  QuestionIcon,
  ScalesIcon,
  UserCircleIcon,
  WarningCircleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { AccountNeed, NeedTone } from "../catalog/account-needs";
import type { AppLink, SettingItem } from "../catalog/app-page";
import { maintainerProfile } from "../catalog/authors";
import type { InstalledRef } from "../catalog/catalog.functions";
import { DocsLink } from "./docs-link";
import { PageSection } from "./page-section";
import { StatusBadge } from "./status-badge";
import { Tooltip } from "./tooltip";

/**
 * The parts of an app's catalog page below the header and screenshots, all
 * in one pattern: a hairline, a heading, then plain rows. Technical detail
 * (variable names, binding names) sits in tooltips and popovers.
 */

/** One part of the page, under a hairline. */
export function AppSection({
  id,
  title,
  titleAction,
  actions,
  children,
}: {
  id?: string;
  title: string;
  titleAction?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="border-kumo-hairline border-t pt-6">
      <PageSection id={id} title={title} titleAction={titleAction} actions={actions}>
        {children}
      </PageSection>
    </div>
  );
}

/** The app's description, paragraph by paragraph. */
export function Description({ paragraphs }: { paragraphs: readonly string[] }) {
  return (
    <div className="grid max-w-3xl gap-3">
      {paragraphs.map((p) => (
        <Text as="p" key={p}>
          {p}
        </Text>
      ))}
    </div>
  );
}

const NEED_ICONS: Record<NeedTone, { icon: Icon; className: string }> = {
  ready: { icon: CheckCircleIcon, className: "text-kumo-success" },
  missing: { icon: WarningCircleIcon, className: "text-kumo-warning" },
  unknown: { icon: QuestionIcon, className: "text-kumo-subtle" },
  yours: { icon: UserCircleIcon, className: "text-kumo-info" },
};

/**
 * "R2 storage · Needs action": the need's name and its state, in the words
 * of its row on Your account. A need that is not met says why this app
 * counts it (or `explanation`, when given, says what the need means for
 * this app), then its actions: the Cloudflare dashboard page that fixes it,
 * in a new tab ("Turn on in Cloudflare", "Upgrade"), and a quieter link to
 * its row on Your account ("See in Your account", "Choose plan").
 */
export function NeedRow({
  need,
  explanation = null,
}: {
  need: AccountNeed;
  explanation?: string | null;
}) {
  const { icon: NeedIcon, className } = NEED_ICONS[need.tone];
  const line = explanation ?? need.reason;
  return (
    <li className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] content-start items-center gap-x-2 gap-y-0.5">
      <NeedIcon aria-hidden weight="fill" size={18} className={`shrink-0 ${className}`} />
      <span className="min-w-0">
        <span className="font-medium text-kumo-default">{need.name}</span>
        <span className="text-kumo-subtle"> · {need.state}</span>
      </span>
      {line !== null && (
        <span className="col-start-2 text-sm">
          <Text as="span" variant="secondary" size="sm">
            {line}
          </Text>
        </span>
      )}
      {(need.fix !== null || need.more !== null) && (
        // On a phone the two links stack, in the banner and on the page alike;
        // side by side, the banner's narrower column would break them unevenly.
        <span className="col-start-2 flex flex-col items-start gap-y-1 pt-0.5 text-sm sm:flex-row sm:flex-wrap sm:gap-x-4">
          {need.fix !== null && (
            <Link href={need.fix.href} target="_blank" rel="noopener noreferrer">
              {need.fix.label}
              <Link.ExternalIcon />
            </Link>
          )}
          {need.more !== null &&
            (need.fix === null ? (
              // The only way forward, so a plain link rather than a quiet one.
              <Link href={need.more.href}>{need.more.label}</Link>
            ) : (
              <span className="text-kumo-subtle">
                <Link href={need.more.href} variant="current">
                  {need.more.label}
                </Link>
              </span>
            ))}
        </span>
      )}
    </li>
  );
}

/**
 * "Before you install", above the install form while the account is not
 * known to have everything the app needs: the same rows as "What it needs
 * on your account" for what is left, and the box the admin ticks to say the
 * account has them.
 */
export function BeforeYouInstall({
  rows,
  confirmed,
  onConfirmedChange,
  disabledReason,
}: {
  /** Each need left to confirm, with what it means for this app when there is more to say. */
  rows: ReadonlyArray<{ need: AccountNeed; explanation: string | null }>;
  confirmed: boolean;
  onConfirmedChange: (confirmed: boolean) => void;
  /** Why the box cannot be ticked: the viewer cannot install, or the install is blocked. */
  disabledReason: string | null;
}) {
  return (
    <Banner
      variant="alert"
      icon={<WarningIcon weight="fill" />}
      title="Before you install"
      description={
        <div className="grid gap-2">
          <span>
            Check that your account has what the app needs.{" "}
            <DocsLink topic="requirements" variant="inline" />
          </span>
          <ul className="m-0 grid list-none gap-3 p-0">
            {rows.map(({ need, explanation }) => (
              <NeedRow key={need.key} need={need} explanation={explanation} />
            ))}
          </ul>
          <span className="grid gap-1">
            <Checkbox
              label="My account has these"
              checked={confirmed}
              disabled={disabledReason !== null}
              onCheckedChange={(checked: boolean) => onConfirmedChange(checked)}
            />
            {disabledReason !== null && (
              <Text as="span" variant="secondary" size="sm">
                {disabledReason}
              </Text>
            )}
          </span>
        </div>
      }
    />
  );
}

/** Everything the app needs from the account, then what the install adds, as one quiet line. */
export function NeedsList({
  needs,
  adds,
  note,
}: {
  needs: readonly AccountNeed[];
  /** What the install creates, when known before it runs. */
  adds: { sentence: string; detail: string | null } | null;
  /** Why the list may be incomplete (a build or the app's installer decides the rest). */
  note: string | null;
}) {
  return (
    <div className="grid gap-3">
      {needs.length === 0 ? (
        <Text as="p" variant="secondary">
          Nothing beyond what every Cloudflare account has.
        </Text>
      ) : (
        <ul className="m-0 grid list-none gap-x-6 gap-y-3 p-0 sm:grid-cols-2">
          {needs.map((need) => (
            <NeedRow key={need.key} need={need} />
          ))}
        </ul>
      )}
      {(adds !== null || note !== null) && (
        <Text as="p" variant="secondary" size="sm">
          {adds !== null &&
            (adds.detail === null ? (
              adds.sentence
            ) : (
              <Tooltip content={adds.detail} className="text-left">
                {adds.sentence}
              </Tooltip>
            ))}
          {adds !== null && note !== null && " "}
          {note}
        </Text>
      )}
    </div>
  );
}

/**
 * A small "?" after a setting's label that opens its help text, with the
 * technical name under it, on click or hover. A 20px button in a 24px line,
 * so it shifts nothing.
 */
function SettingHelp({ item }: { item: SettingItem & { description: string } }) {
  return (
    <Popover>
      <Popover.Trigger
        openOnHover
        delay={150}
        render={
          <Button
            shape="square"
            size="xs"
            variant="ghost"
            className="size-5 self-center text-kumo-subtle"
            icon={<QuestionIcon aria-hidden size={16} />}
            aria-label={`About ${item.label}`}
          />
        }
      />
      <Popover.Content>
        <span className="grid max-w-72 gap-1.5">
          <Popover.Description>{item.description}</Popover.Description>
          <Text as="span" variant="mono-secondary">
            {item.name}
          </Text>
        </span>
      </Popover.Content>
    </Popover>
  );
}

function hasDescription(item: SettingItem): item is SettingItem & { description: string } {
  return item.description !== null && item.description.trim() !== "";
}

/**
 * The secrets and settings the install form will ask for, by label; the name
 * on hover, and a "?" with the help text for a setting that has some.
 */
export function SettingsList({ items }: { items: readonly SettingItem[] }) {
  return (
    <ul className="m-0 grid list-none gap-x-6 gap-y-2 p-0 sm:grid-cols-2">
      {items.map((item) => (
        <li key={item.name} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <Tooltip
            content={<span className="font-mono">{item.name}</span>}
            className="min-w-0 text-left font-medium text-kumo-default"
          >
            {item.label}
          </Tooltip>
          {hasDescription(item) && <SettingHelp item={item} />}
          <Text as="span" variant="secondary" size="sm">
            {item.hint}
          </Text>
        </li>
      ))}
    </ul>
  );
}

const LINK_ICONS: Record<AppLink["kind"], Icon> = {
  repository: GithubLogoIcon,
  website: GlobeIcon,
  license: ScalesIcon,
};

/** Source code, website, license, and who packages the app for the catalog. */
export function LinksList({
  links,
  maintainers,
}: {
  links: readonly AppLink[];
  maintainers: readonly string[];
}) {
  return (
    <div className="grid gap-3">
      <ul className="m-0 grid list-none gap-x-6 gap-y-2 p-0 sm:grid-cols-2">
        {links.map((link) => {
          const LinkIcon = LINK_ICONS[link.kind];
          return (
            <li key={link.href} className="flex min-w-0 items-center gap-2">
              <LinkIcon aria-hidden size={18} className="shrink-0 text-kumo-subtle" />
              <Link href={link.href} target="_blank" rel="noopener noreferrer">
                {link.label}
                <Link.ExternalIcon />
              </Link>
              <Text as="span" variant="secondary" size="sm">
                <span className="truncate">{link.detail}</span>
              </Text>
            </li>
          );
        })}
      </ul>
      {maintainers.length > 0 && (
        <Text as="p" variant="secondary" size="sm">
          Packaged for the catalog by{" "}
          {maintainers.map((handle, i) => {
            const profile = maintainerProfile(handle);
            const separator = i === 0 ? "" : i === maintainers.length - 1 ? " and " : ", ";
            return (
              <span key={handle}>
                {separator}
                {profile.href === null ? (
                  profile.label
                ) : (
                  <Link href={profile.href} target="_blank" rel="noopener noreferrer">
                    {profile.label}
                  </Link>
                )}
              </span>
            );
          })}
          .
        </Text>
      )}
    </div>
  );
}

/** The installs of this app on the account, each linked to its page; the Worker name on hover. */
export function InstallsList({ instances }: { instances: readonly InstalledRef[] }) {
  return (
    <LayerCard render={<ul />} className="m-0 grid list-none divide-y divide-kumo-hairline p-0">
      {instances.map((instance) => (
        <li
          key={instance.installId}
          className="flex min-w-0 flex-wrap items-center justify-between gap-2 px-4 py-3"
        >
          {/* The link itself is the tooltip's trigger: a link inside the default button trigger would nest two controls. */}
          <Tooltip
            content={`Worker: ${instance.workerName}`}
            render={<Link href={`/apps/${instance.installId}`} />}
          >
            {instance.instanceName}
          </Tooltip>
          <StatusBadge status={instance.status} of="install" />
        </li>
      ))}
    </LayerCard>
  );
}
