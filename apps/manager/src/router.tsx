import { Loader } from "@cloudflare/kumo";
import { createRouter } from "@tanstack/react-router";
import { RouteError } from "./components/route-error";
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
        <Loader />
      </div>
    ),
    defaultErrorComponent: RouteError,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
