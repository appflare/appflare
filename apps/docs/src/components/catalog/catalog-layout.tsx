import { HomeLayout } from "@fumadocs/base-ui/layouts/home";
import type { ReactNode } from "react";
import { appsLink, baseOptions, docsLink } from "../../lib/layout.shared.tsx";

/** The catalog pages: the site's top bar over a centred column, without the docs sidebar. The layout is the page's `main`. */
export function CatalogLayout({ children }: { children: ReactNode }) {
  return (
    <HomeLayout {...baseOptions()} links={[docsLink, appsLink]}>
      <div className="mx-auto grid w-full min-w-0 max-w-6xl grid-cols-1 gap-10 px-4 pt-8 pb-16 md:px-6 [&>*]:min-w-0">
        {children}
      </div>
    </HomeLayout>
  );
}

/** The heading of a catalog page. */
export function CatalogHeader({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <header className="grid gap-2">
      <h1 className="font-bold text-3xl tracking-tight">{title}</h1>
      <p className="max-w-2xl text-fd-muted-foreground text-lg">{description}</p>
      {children}
    </header>
  );
}
