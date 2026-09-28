import type { ReactNode } from "react";
import { CatalogLayout } from "../catalog/catalog-layout.tsx";

/**
 * The frame of the install pages and `/my/`: the site's top bar, what the
 * page is about, then one card holding the current step. The header and the
 * card's frame are prerendered; the step inside arrives once the page runs.
 */
export function InstallShell({ header, children }: { header: ReactNode; children: ReactNode }) {
  return (
    <CatalogLayout>
      <div className="mx-auto grid w-full max-w-xl gap-6">
        {header}
        <section
          aria-live="polite"
          className="grid min-h-40 content-start gap-4 rounded-2xl border border-fd-border bg-fd-card p-5 shadow-sm sm:p-6"
        >
          {children}
        </section>
        <p className="text-center text-fd-muted-foreground text-sm">
          Nothing is installed until you confirm it in your Appflare.{" "}
          <a href="/guides/install-links/" className="underline underline-offset-2">
            About install links
          </a>
        </p>
      </div>
    </CatalogLayout>
  );
}

/** The mark of a page about a GitHub repository, in the place of an app's icon. */
export function RepositoryIcon() {
  return (
    <span
      aria-hidden="true"
      className="flex size-16 shrink-0 items-center justify-center rounded-xl bg-fd-secondary text-fd-foreground"
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" width="36" height="36" fill="currentColor">
        <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.69 5.39-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
      </svg>
    </span>
  );
}

/** The heading of an install page: the app's icon, "Install <name>" and a line or two. */
export function InstallHeader({
  icon,
  title,
  lines,
}: {
  icon: ReactNode;
  title: string;
  lines: ReactNode;
}) {
  return (
    <header className="flex items-center gap-4">
      {icon}
      <div className="grid min-w-0 gap-1">
        <h1 className="break-words font-bold text-2xl tracking-tight sm:text-3xl">{title}</h1>
        <div className="text-fd-muted-foreground">{lines}</div>
      </div>
    </header>
  );
}
