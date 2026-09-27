import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { useStartUpdate } from "../../components/update-banner";
import { homeLanding } from "../../home/home-landing";
import { HomeView } from "../../home/home-view";
import { useAttention } from "../../home/use-attention";

/**
 * `/` (Home): what needs attention, then the installed apps as cards, all
 * from the signed-in layout's data (`getLayoutData`), which the sidebar's
 * count and dots read too. With nothing installed, arriving here goes on
 * to the catalog; a click on Home stays and says so (`home-landing.ts`).
 */
export const Route = createFileRoute("/_app/")({
  staticData: { title: "Home" },
  loader: async ({ location, parentMatchPromise }) => {
    const layout = await parentMatchPromise;
    const installed = layout.loaderData?.apps.length;
    if (installed !== undefined && homeLanding(installed, location.state) === "catalog") {
      throw redirect({ to: "/catalog", replace: true });
    }
  },
  component: HomePage,
});

function HomePage() {
  const [leftForAdmin, setLeftForAdmin] = useState<ReadonlyMap<string, string>>();
  const { data, isAdmin, items, dismissAccountRow } = useAttention(leftForAdmin);
  const update = useStartUpdate();
  return (
    <HomeView
      apps={data.apps}
      items={items}
      isAdmin={isAdmin}
      update={update}
      onDismissAccountRow={dismissAccountRow}
      onUpdateAllOutcome={(outcome) =>
        setLeftForAdmin(new Map(outcome.needsInput.map((i) => [i.installId, i.reason])))
      }
      now={new Date()}
    />
  );
}
