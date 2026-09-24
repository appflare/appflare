import { createRouter } from "@tanstack/react-router";
import { NotFound } from "./components/not-found.tsx";
import { routeTree } from "./routeTree.gen.ts";

export function getRouter() {
  return createRouter({
    routeTree,
    defaultPreload: "intent",
    scrollRestoration: true,
    // Pages are prerendered as `<path>/index.html`, so their URLs end in a slash.
    trailingSlash: "always",
    defaultNotFoundComponent: NotFound,
  });
}
