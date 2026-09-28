import { createRouter } from "@tanstack/react-router";
import { NotFound } from "./components/not-found";
import { PagePending } from "./components/page-pending";
import { RouteError } from "./components/route-error";
import { NOT_FOUND_MODE } from "./router-not-found";
import { PENDING_MIN_MS, PENDING_MS } from "./router-timing";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: "intent",
    defaultPendingMs: PENDING_MS,
    defaultPendingMinMs: PENDING_MIN_MS,
    // Inside the signed-in shell it takes the page's place only; elsewhere,
    // and as the SPA shell's body (SPA mode renders the pending component in
    // place of the matched routes), it fills the window.
    defaultPendingComponent: PagePending,
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
