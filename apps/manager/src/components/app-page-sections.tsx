import { Link, Text } from "@cloudflare/kumo";
import {
  CheckCircleIcon,
  GithubLogoIcon,
  GlobeIcon,
  type Icon,
  QuestionIcon,
  ScalesIcon,
  UserCircleIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { AccountNeed, NeedTone } from "../catalog/account-needs";
import type { AppLink, SettingItem } from "../catalog/app-page";
import { maintainerProfile } from "../catalog/authors";
import type { InstalledRef } from "../catalog/catalog.functions";
import { Section } from "./section";
import { StatusBadge } from "./status-badge";
import { Tooltip } from "./tooltip";

/**
 * The parts of an app's catalog page below the header and screenshots, all
 * in one pattern: a hairline, a heading, then plain rows. Technical detail
 * (what a probe found, variable names, binding names) sits in tooltips.
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
      <Section id={id} title={title} titleAction={titleAction} actions={actions}>
        {children}
      </Section>
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
 * "Email Routing · ready": the need's name, its state, and the probe's
 * finding on hover; `explanation`, when given, is a line under it saying what
 * the need means for this app.
 */
export function NeedRow({
  need,
  explanation = null,
}: {
  need: AccountNeed;
  explanation?: string | null;
}) {
  const { icon: NeedIcon, className } = NEED_ICONS[need.tone];
  return (
    <li className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-0.5">
      <NeedIcon aria-hidden weight="fill" size={18} className={`shrink-0 ${className}`} />
      <Tooltip content={need.detail} className="min-w-0 justify-self-start text-left">
        <span>
          <span className="font-medium text-kumo-default">{need.name}</span>
          <span className="text-kumo-subtle"> · {need.state}</span>
        </span>
      </Tooltip>
      {explanation !== null && (
        <span className="col-start-2">
          <Text as="span" variant="secondary" size="sm">
            {explanation}
          </Text>
        </span>
      )}
    </li>
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
        <ul className="m-0 grid list-none gap-x-6 gap-y-2 p-0 sm:grid-cols-2">
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

/** The secrets and settings the install form will ask for, by label; the name on hover. */
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
    <ul className="m-0 grid list-none divide-y divide-kumo-hairline rounded-lg p-0 ring ring-kumo-hairline">
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
    </ul>
  );
}
