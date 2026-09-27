import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { redirectMovedSettings } from "./settings-redirect";

/**
 * The settings routes' redirects in a router of the manager's shape (the
 * real tree only builds under TanStack Start's Vite plugin): `/settings`,
 * the old Appflare updates page and Your account send old addresses on,
 * with the anchor of the section they named.
 */

function tree() {
  const loaded: string[] = [];
  const root = createRootRoute({});
  const app = createRoute({ getParentRoute: () => root, id: "_app" });
  const page = (path: string, redirects = false) =>
    createRoute({
      getParentRoute: () => app,
      path,
      ...(redirects ? { beforeLoad: ({ location }) => redirectMovedSettings(location) } : {}),
      loader: () => {
        loaded.push(path);
        return {};
      },
    });
  const routeTree = root.addChildren([
    app.addChildren([
      page("/settings/", true),
      page("/settings/appflare-updates", true),
      page("/settings/account", true),
      page("/settings/building"),
      page("/settings/updates"),
      page("/settings/notifications"),
    ]),
  ]);
  return { routeTree, loaded };
}

async function arrive(href: string) {
  const { routeTree, loaded } = tree();
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [href] }),
    // The browser's code path: the manager renders as a single-page app.
    isServer: false,
    origin: "http://localhost",
  });
  await router.load();
  const { pathname, hash } = router.state.location;
  return { at: hash === "" ? pathname : `${pathname}#${hash}`, loaded };
}

describe("old settings addresses", () => {
  it.each([
    ["/settings", "/settings/account"],
    ["/settings/", "/settings/account"],
    ["/settings#automatic-updates", "/settings/updates#apps"],
    ["/settings#danger-zone", "/settings/account#danger-zone"],
    ["/settings#appflare-updates", "/settings/updates#appflare"],
    ["/settings#notifications", "/settings/notifications"],
    ["/settings/appflare-updates", "/settings/updates#appflare"],
    ["/settings/appflare-updates#versions", "/settings/updates#versions"],
    ["/settings/account#sandbox", "/settings/building#sandbox"],
    ["/settings/account#github-access", "/settings/building#github-access"],
    ["/settings/account#checklist-sandbox", "/settings/account#capability-sandbox"],
    ["/settings/account#checklist", "/settings/account#capabilities"],
  ])("%s opens %s", async (from, to) => {
    const { at, loaded } = await arrive(from);
    expect(at).toBe(to);
    // Only the page arrived at loads its data.
    expect(loaded).toEqual([to.split("#")[0]]);
  });

  it("leaves current addresses alone", async () => {
    for (const href of [
      "/settings/account",
      "/settings/account#danger-zone",
      "/settings/account#capabilities",
      "/settings/account#capability-token-permissions",
      "/settings/building#github-access",
    ]) {
      expect((await arrive(href)).at).toBe(href);
    }
  });
});
