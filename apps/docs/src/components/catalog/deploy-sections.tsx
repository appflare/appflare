import { buttonVariants } from "@fumadocs/base-ui/components/ui/button";
import {
  ArrowsClockwiseIcon,
  BrowserIcon,
  CheckIcon,
  HeartbeatIcon,
  HouseLineIcon,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import {
  type DeployGuide,
  type FaqItem,
  NEEDS_ANCHOR,
  type WithAppflareItem,
} from "../../catalog/app-guide.ts";
import type { AskedField } from "../../catalog/install-form.ts";
import { LINK } from "./app-sections.tsx";

/**
 * The sections of an app's page about deploying it: what it does, the
 * numbered steps to deploy it with Appflare, what Appflare adds over a
 * deploy by hand, and the questions people ask first. The words come from
 * `catalog/app-guide.ts`; these only lay them out.
 */

/** The app's features, one line each. */
export function FeatureList({ features }: { features: readonly string[] }) {
  return (
    <ul className="m-0 grid max-w-3xl list-none gap-2 p-0">
      {features.map((feature) => (
        <li key={feature} className="flex items-start gap-2.5 leading-relaxed">
          <CheckIcon
            aria-hidden="true"
            weight="bold"
            className="mt-1 size-4 shrink-0 text-fd-primary"
          />
          <span>{feature}</span>
        </li>
      ))}
    </ul>
  );
}

function Step({
  number,
  title,
  badge,
  children,
}: {
  number: number;
  title: string;
  badge?: string;
  children: ReactNode;
}) {
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 bg-fd-card px-4 py-4 sm:px-5">
      <span
        aria-hidden="true"
        className="flex size-7 items-center justify-center rounded-full border border-fd-primary/30 bg-fd-primary/10 font-semibold text-fd-primary text-sm"
      >
        {number}
      </span>
      <div className="grid min-w-0 max-w-3xl gap-2 pt-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="m-0 font-semibold text-base">
            <span className="sr-only">Step {number}: </span>
            {title}
          </h3>
          {badge !== undefined && (
            <span className="rounded-full border border-fd-border px-2 py-0.5 text-fd-muted-foreground text-xs">
              {badge}
            </span>
          )}
        </div>
        {children}
      </div>
    </li>
  );
}

/** The fields the install form asks for, each with its link when the catalog gives one. */
function AskedFields({ fields }: { fields: readonly AskedField[] }) {
  return (
    <div className="grid gap-1.5">
      <p className="m-0 text-fd-muted-foreground">The install form asks you for:</p>
      <ul className="m-0 grid list-none gap-1 p-0">
        {fields.map((field) => (
          <li key={field.label} className="flex flex-wrap items-baseline gap-x-3">
            <span className="font-medium">{field.label}</span>
            {field.seedOnly && (
              <span className="text-fd-muted-foreground text-sm">asked once, at install</span>
            )}
            {field.link !== null && (
              <a href={field.link.url} rel="noopener noreferrer" className={`${LINK} text-sm`}>
                {field.link.label}
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "Deploy <Name> on Cloudflare": set up Appflare once, install the app, finish its setup. */
export function DeploySteps({ guide, appName }: { guide: DeployGuide; appName: string }) {
  const { setup, install, finish } = guide;
  return (
    <ol className="m-0 grid list-none divide-y divide-fd-border overflow-hidden rounded-xl border border-fd-border p-0">
      <Step number={1} title={setup.title} badge="Once">
        <p className="m-0 text-fd-muted-foreground">
          {setup.text} See{" "}
          <a href={`#${NEEDS_ANCHOR}`} className={LINK}>
            what {appName} needs on your account
          </a>
          .
        </p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1">
          <a
            href={setup.href}
            className={buttonVariants({ variant: "primary", className: "px-4" })}
          >
            {setup.action}
          </a>
          <span className="text-fd-muted-foreground text-sm">
            {setup.installQuestion}{" "}
            <a href={setup.installHref} className={LINK}>
              {setup.installAction}
            </a>
          </span>
        </div>
      </Step>
      <Step number={2} title={install.title}>
        {install.asks === null ? (
          <p className="m-0 text-fd-muted-foreground">
            Find {appName} in Appflare's catalog and fill in its install form.
          </p>
        ) : (
          install.asks.length > 0 && <AskedFields fields={install.asks} />
        )}
        {install.notes.length > 0 && (
          <div className="grid gap-1">
            {install.notes.map((note) => (
              <p key={note} className="m-0 text-fd-muted-foreground">
                {note}
              </p>
            ))}
          </div>
        )}
      </Step>
      {finish !== null && (
        <Step number={3} title={finish.title}>
          <p className="m-0 text-fd-muted-foreground">{finish.text}</p>
        </Step>
      )}
    </ol>
  );
}

const WITH_APPFLARE_ICONS: Record<WithAppflareItem["id"], typeof CheckIcon> = {
  setup: BrowserIcon,
  updates: ArrowsClockwiseIcon,
  health: HeartbeatIcon,
  account: HouseLineIcon,
};

/** What Appflare does that a deploy by hand does not, for the app's tier. */
export function WithAppflareList({ items }: { items: readonly WithAppflareItem[] }) {
  return (
    <ul className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2">
      {items.map((item) => {
        const Icon = WITH_APPFLARE_ICONS[item.id];
        return (
          <li
            key={item.title}
            className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 rounded-xl border border-fd-border bg-fd-card px-4 py-3"
          >
            <Icon aria-hidden="true" className="mt-0.5 size-5 text-fd-primary" />
            <div className="grid content-start gap-0.5">
              <span className="font-medium">{item.title}</span>
              <span className="text-fd-muted-foreground text-sm leading-relaxed">{item.text}</span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** The page's questions, each with its answer shown. */
export function FaqList({ items }: { items: readonly FaqItem[] }) {
  return (
    <div className="grid max-w-3xl gap-5">
      {items.map((item) => (
        <div key={item.question} className="grid gap-1">
          <h3 className="m-0 font-semibold text-base">{item.question}</h3>
          <p className="m-0 text-fd-muted-foreground leading-relaxed">{item.answer}</p>
        </div>
      ))}
    </div>
  );
}
