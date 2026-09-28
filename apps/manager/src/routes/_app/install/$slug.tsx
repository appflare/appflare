import { createFileRoute, redirect } from "@tanstack/react-router";
import { resolveInstallLink } from "../../../catalog/install-intent.functions";
import { InstallLinkProblem } from "../../../components/install-link-problem";

/**
 * `/install/<slug>`: an install link from another site (an Install button
 * on appflare.dev). Signing in first keeps it (`returnTo`). When an enabled
 * catalog lists the app, its catalog page opens in place of this address;
 * otherwise a plain page says so. Nothing is installed from here: the app's
 * page shows its install action to admins, who still confirm.
 */
export const Route = createFileRoute("/_app/install/$slug")({
  staticData: { title: "Install" },
  loader: async ({ params }) => {
    const target = await resolveInstallLink({ data: { slug: params.slug } });
    if (target.found) {
      throw redirect({ to: "/catalog/$slug", params: { slug: target.key }, replace: true });
    }
    return target;
  },
  component: InstallAppLinkPage,
});

function InstallAppLinkPage() {
  const target = Route.useLoaderData();
  const { viewer } = Route.useRouteContext();
  return (
    <InstallLinkProblem
      kind={target.officialOff ? "official-off" : "app"}
      isAdmin={viewer.role === "admin"}
    />
  );
}
