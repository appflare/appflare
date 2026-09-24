import { RootProvider } from "@fumadocs/base-ui/provider/tanstack";
import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { DocsLink } from "../components/link.tsx";
import StaticSearchDialog from "../components/search.tsx";
import { siteName } from "../lib/shared.ts";
import appCss from "../styles/app.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: siteName },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
    ],
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
        <RootProvider search={{ SearchDialog: StaticSearchDialog }} components={{ Link: DocsLink }}>
          <Outlet />
        </RootProvider>
        <Scripts />
      </body>
    </html>
  );
}
