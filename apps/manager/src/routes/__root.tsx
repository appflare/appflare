import { LinkProvider, Toasty } from "@cloudflare/kumo";
import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";
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
  }
}

/** Kumo's `bg-kumo-base` in light mode (white) and dark mode (neutral-925, oklch(17% 0 0)). */
const THEME_COLOR = { light: "#ffffff", dark: "#0f0f0f" };

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
      ],
      links: [
        { rel: "stylesheet", href: appCss },
        // The SVG favicon switches between a dark and a white mark with the
        // browser's colour scheme; the PNG is for browsers without SVG favicons.
        { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
        { rel: "icon", href: "/favicon-32.png", type: "image/png", sizes: "32x32" },
        { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
        { rel: "manifest", href: "/site.webmanifest" },
      ],
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
        <Outlet />
      </Toasty>
    </LinkProvider>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
        {/* One per colour scheme. Written here because head() keeps a single meta per name. */}
        <meta
          name="theme-color"
          media="(prefers-color-scheme: light)"
          content={THEME_COLOR.light}
        />
        <meta name="theme-color" media="(prefers-color-scheme: dark)" content={THEME_COLOR.dark} />
      </head>
      <body className="bg-kumo-base text-kumo-default antialiased">
        {/* Kumo portals popups to <body>; the app root gets its own stacking context. */}
        <div className="isolate min-h-dvh">{children}</div>
        <Scripts />
      </body>
    </html>
  );
}
