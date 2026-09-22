import { LinkProvider } from "@cloudflare/kumo";
import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { RouterAnchor } from "../components/router-anchor";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "robots", content: "noindex" },
      { title: "Appflare" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  shellComponent: RootDocument,
  component: RootComponent,
});

function RootComponent() {
  return (
    <LinkProvider component={RouterAnchor}>
      <Outlet />
    </LinkProvider>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="bg-kumo-base text-kumo-default antialiased">
        {/* Kumo portals popups to <body>; the app root gets its own stacking context. */}
        <div className="isolate min-h-dvh">{children}</div>
        <Scripts />
      </body>
    </html>
  );
}
