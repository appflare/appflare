import { LinkProvider, Toasty, TooltipProvider } from "@cloudflare/kumo";
import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { COLOR_MODE_SCRIPT } from "../components/color-mode";
import { FAVICON_LINKS, FAVICON_META } from "../components/favicons";
import { RouterAnchor } from "../components/router-anchor";
import appCss from "../styles.css?url";

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /**
     * The page's name in the browser tab, shown as "<title> · Appflare". The
     * deepest matched route that sets one wins; without any the tab reads
     * "Appflare". A page whose name depends on its data can set its own
     * `head()` title instead, which takes precedence over this one.
     */
    title?: string;
    /**
     * `wide`: the signed-in shell centres the page in a 72rem column instead
     * of the usual 64rem, for pages of tiles such as the catalog.
     */
    width?: "wide";
  }
}

export const Route = createRootRoute({
  head: ({ matches }) => {
    const page = matches.findLast((match) => match.staticData.title !== undefined)?.staticData
      .title;
    return {
      meta: [
        { charSet: "utf-8" },
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        { name: "robots", content: "noindex" },
        { title: page === undefined ? "Appflare" : `${page} · Appflare` },
        ...FAVICON_META,
      ],
      links: [{ rel: "stylesheet", href: appCss }, ...FAVICON_LINKS],
      // Light unless the account menu's Appearance says otherwise; set before the first
      // paint. The script also writes the `theme-color` meta, which React must not own:
      // one it rendered would be duplicated on hydration once the script changed it.
      scripts: [{ children: COLOR_MODE_SCRIPT }],
    };
  },
  shellComponent: RootDocument,
  component: RootComponent,
});

function RootComponent() {
  return (
    <LinkProvider component={RouterAnchor}>
      {/* Kumo toasts, such as the one confirming that a job started. */}
      <Toasty>
        {/* One provider, so moving from one tooltip to the next skips the wait. */}
        <TooltipProvider>
          <Outlet />
        </TooltipProvider>
      </Toasty>
    </LinkProvider>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    // The head script sets `data-mode` on this element before React hydrates it.
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      {/* The canvas behind the pages, so their cards stand out as they do on the sign-in pages. */}
      <body className="bg-kumo-canvas text-kumo-default antialiased">
        {/* Kumo portals popups to <body>; the app root gets its own stacking context. */}
        <div className="isolate min-h-dvh">{children}</div>
        <Scripts />
      </body>
    </html>
  );
}
