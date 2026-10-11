// First: takes the OAuth code and state out of the address bar on the
// deploy callback before the router or the analytics see the address.
import "../deploy/arrival.ts";
import type { SharedProps } from "@fumadocs/base-ui/components/dialog/search";
import { RootProvider } from "@fumadocs/base-ui/provider/tanstack";
import { createRootRoute, HeadContent, Outlet, Scripts, useRouter } from "@tanstack/react-router";
import { lazy, useEffect, useState } from "react";
import { startAnalytics } from "../analytics/analytics.ts";
import { DocsLink } from "../components/link.tsx";
import { faviconLinks, faviconMeta } from "../lib/favicons.ts";
import { siteName } from "../lib/shared.ts";
import appCss from "../styles/app.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: siteName },
      ...faviconMeta,
    ],
    links: [{ rel: "stylesheet", href: appCss }, ...faviconLinks],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="flex min-h-screen flex-col">
        {/*
          The site opens in light mode whatever the browser prefers. A reader's
          choice (light, dark, or follow the system) is kept in localStorage and
          applied by an inline script before the first paint, so a reload does not flash.
        */}
        <RootProvider
          search={{ SearchDialog: SearchOnFirstOpen }}
          theme={{ defaultTheme: "light", enableSystem: true }}
          components={{ Link: DocsLink }}
        >
          <Outlet />
        </RootProvider>
        <Analytics />
        <Scripts />
      </body>
    </html>
  );
}

const StaticSearchDialog = lazy(() => import("../components/search.tsx"));

/**
 * The search dialog, whose code (the search engine among it) loads the first
 * time the dialog opens rather than with every page. Fumadocs mounts its
 * dialog closed on every page, and wraps it in Suspense while it loads.
 */
function SearchOnFirstOpen(props: SharedProps) {
  const [opened, setOpened] = useState(props.open);
  if (props.open && !opened) setOpened(true);
  return opened ? <StaticSearchDialog {...props} /> : null;
}

/** Starts the site's analytics once the page runs in a browser (never while prerendering). */
function Analytics() {
  const router = useRouter();
  useEffect(() => {
    startAnalytics(router);
  }, [router]);
  return null;
}
