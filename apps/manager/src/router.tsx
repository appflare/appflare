import { createRouter } from "@tanstack/react-router";
import { AppflareLoader } from "./components/appflare-loader";
import { NotFound } from "./components/not-found";
import { RouteError } from "./components/route-error";
import { NOT_FOUND_MODE } from "./router-not-found";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: "intent",
    // Also the SPA shell's body (SPA mode renders the pending
    // component in place of the matched routes).
    defaultPendingComponent: () => (
      <div className="flex min-h-dvh items-center justify-center">
        <AppflareLoader />
      </div>
    ),
    defaultErrorComponent: RouteError,
    notFoundMode: NOT_FOUND_MODE,
    defaultNotFoundComponent: NotFound,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
