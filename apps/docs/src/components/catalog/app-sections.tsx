import type { ReactNode } from "react";
import {
  type AccountNeeds,
  type AppLink,
  type AppStat,
  authorLinks,
  maintainerProfile,
} from "../../catalog/app-page.ts";
import type { SiteApp } from "../../catalog/site-catalog.ts";

/**
 * The sections of an app's page, as Appflare's own app page lays them out:
 * the stat strip and the titled sections below the screenshots (those are
 * in `screenshot-gallery.tsx`).
 */

/** How a link reads on these pages: underlined, in the link colour. */
const LINK =
  "font-medium text-fd-primary underline decoration-fd-primary/40 underline-offset-4 hover:decoration-fd-primary";

/** A titled section of the app page. */
export function AppSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-3">
      <h2 className="font-semibold text-xl">{title}</h2>
      {children}
    </section>
  );
}

/** The figures under the app's name, each with its sentence on hover. */
export function StatStrip({ stats }: { stats: readonly AppStat[] }) {
  return (
    <dl className="m-0 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-fd-border bg-fd-border sm:grid-cols-3 lg:flex">
      {stats.map((stat) => (
        <div
          key={stat.id}
          title={stat.tooltip}
          className="relative grid min-w-0 flex-1 content-start gap-0.5 bg-fd-card px-4 py-3"
        >
          <dt className="text-fd-muted-foreground text-xs">{stat.label}</dt>
          <dd
            className={`m-0 truncate font-semibold ${stat.tone === "warning" ? "text-amber-600 dark:text-amber-400" : ""}`}
          >
            {stat.value}
            {stat.caption !== null && (
              <span className="ml-1.5 font-normal text-fd-muted-foreground text-xs">
                {stat.caption}
              </span>
            )}
          </dd>
          <span className="sr-only">{stat.tooltip}</span>
        </div>
      ))}
    </dl>
  );
}

/** What the app counts on in a Cloudflare account. */
export function NeedsList({ needs }: { needs: AccountNeeds }) {
  if (needs.items.length === 0) {
    return (
      <p className="text-fd-muted-foreground">
        Nothing beyond a Cloudflare account on the free Workers plan.
      </p>
    );
  }
  return (
    <div className="grid gap-2">
      <ul className="m-0 grid list-none divide-y divide-fd-border overflow-hidden rounded-xl border border-fd-border p-0">
        {needs.items.map((item) => (
          <li
            key={item.key}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 bg-fd-card px-4 py-2.5"
          >
            <span className="font-medium">{item.name}</span>
            {item.words !== null && (
              <span className="text-fd-muted-foreground text-sm">{item.words}</span>
            )}
          </li>
        ))}
      </ul>
      {needs.note !== null && <p className="text-fd-muted-foreground text-sm">{needs.note}</p>}
    </div>
  );
}

/** The source code and website, then who packages the app for the catalog. */
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
        {links.map((link) => (
          <li key={link.href} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <a href={link.href} rel="noopener noreferrer" className={LINK}>
              {link.label}
            </a>
            <span className="truncate text-fd-muted-foreground text-sm">{link.detail}</span>
          </li>
        ))}
      </ul>
      {maintainers.length > 0 && (
        <p className="text-fd-muted-foreground text-sm">
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
                  <a href={profile.href} rel="noopener noreferrer" className={LINK}>
                    {profile.label}
                  </a>
                )}
              </span>
            );
          })}
          .
        </p>
      )}
    </div>
  );
}

/** Who wrote the app, each with their links. */
export function AuthorsList({ authors }: { authors: SiteApp["authors"] }) {
  return (
    <ul className="m-0 grid list-none gap-2 p-0">
      {authors.map((author) => (
        <li key={author.name} className="flex flex-wrap items-baseline gap-x-3">
          <span className="font-medium">{author.name}</span>
          {authorLinks(author).map((link) => (
            <a
              key={link.href}
              href={link.href}
              rel="noopener noreferrer"
              className={`${LINK} text-sm`}
            >
              {link.label}
            </a>
          ))}
        </li>
      ))}
    </ul>
  );
}
