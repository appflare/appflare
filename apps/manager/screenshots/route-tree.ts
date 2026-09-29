// biome-ignore-all lint/suspicious/noExplicitAny: Route.update needs the same options cast as TanStack's generated route tree.
import { Route as rootRoute } from "../src/routes/__root";
import { Route as appRoute } from "../src/routes/_app";
import { Route as installedApp } from "../src/routes/_app/apps/$installId";
import { Route as catalogApp } from "../src/routes/_app/catalog/$slug";
import { Route as catalog } from "../src/routes/_app/catalog/index";
import { Route as home } from "../src/routes/_app/index";
import { Route as job } from "../src/routes/_app/jobs/$jobId";
import { Route as account } from "../src/routes/_app/settings/account";
import { Route as building } from "../src/routes/_app/settings/building";
import { Route as domains } from "../src/routes/_app/settings/domains";
import { Route as notifications } from "../src/routes/_app/settings/notifications";
import { Route as updates } from "../src/routes/_app/settings/updates";
import { Route as users } from "../src/routes/_app/settings/users";
import { Route as setupRoute } from "../src/routes/setup";

const app = appRoute.update({ id: "/_app", getParentRoute: () => rootRoute } as any);
const setup = setupRoute.update({
  id: "/setup",
  path: "/setup",
  getParentRoute: () => rootRoute,
} as any);
export const routeTree = rootRoute.addChildren([
  setup,
  app.addChildren([
    home.update({ id: "/", path: "/", getParentRoute: () => app } as any),
    catalog.update({ id: "/catalog/", path: "/catalog/", getParentRoute: () => app } as any),
    catalogApp.update({
      id: "/catalog/$slug",
      path: "/catalog/$slug",
      getParentRoute: () => app,
    } as any),
    installedApp.update({
      id: "/apps/$installId",
      path: "/apps/$installId",
      getParentRoute: () => app,
    } as any),
    job.update({ id: "/jobs/$jobId", path: "/jobs/$jobId", getParentRoute: () => app } as any),
    account.update({
      id: "/settings/account",
      path: "/settings/account",
      getParentRoute: () => app,
    } as any),
    building.update({
      id: "/settings/building",
      path: "/settings/building",
      getParentRoute: () => app,
    } as any),
    domains.update({
      id: "/settings/domains",
      path: "/settings/domains",
      getParentRoute: () => app,
    } as any),
    notifications.update({
      id: "/settings/notifications",
      path: "/settings/notifications",
      getParentRoute: () => app,
    } as any),
    updates.update({
      id: "/settings/updates",
      path: "/settings/updates",
      getParentRoute: () => app,
    } as any),
    users.update({
      id: "/settings/users",
      path: "/settings/users",
      getParentRoute: () => app,
    } as any),
  ]),
]);
