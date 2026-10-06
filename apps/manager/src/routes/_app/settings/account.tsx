import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";
import { getCapabilityRowsData } from "../../../capabilities/capability-rows.functions";
import { parseReconnectOutcome } from "../../../cloudflare/reconnect-outcome";
import { SETTINGS_PAGES } from "../../../components/navigation";
import { AccountSettingsView } from "../../../components/settings-pages";
import { redirectMovedSettings } from "../../../components/settings-redirect";
import { getDangerZoneState } from "../../../danger/danger.functions";
import { getTokenStatus } from "../../../server/token.functions";

/**
 * `?cloudflare=<outcome>`: how a Cloudflare sign-in that just came back
 * ended (`/api/cloudflare/oauth-return` sends the browser here with it);
 * `?reconnect=1`: open Reconnect Cloudflare at once (Home's action). Both
 * are taken out of the address once read, so a reload shows neither again.
 */
const accountSearchSchema = z.object({
  cloudflare: z.string().max(40).optional().catch(undefined),
  // The router reads `1` as a number.
  reconnect: z.coerce.string().max(1).optional().catch(undefined),
});

/**
 * `/settings/account` (Your account): the Cloudflare account and how
 * Appflare connects to it (admins reconnect or change it) with the link that
 * makes appflare.dev open this Appflare at the address in the address bar,
 * what the account can run, and, for the owner only, the danger zone. Links
 * to the sections that moved to Building apps, and to the account setup list
 * and its rows under their old anchors, are sent on (`settingsRedirect`).
 */
export const Route = createFileRoute("/_app/settings/account")({
  staticData: { title: SETTINGS_PAGES.account.label },
  validateSearch: accountSearchSchema,
  beforeLoad: ({ location }) => redirectMovedSettings(location),
  loader: async ({ context }) => {
    const [tokenStatus, capabilities, danger] = await Promise.all([
      getTokenStatus(),
      getCapabilityRowsData(),
      context.viewer.isOwner ? getDangerZoneState() : null,
    ]);
    return { tokenStatus, capabilities, danger };
  },
  component: AccountSettingsPage,
});

function AccountSettingsPage() {
  const data = Route.useLoaderData();
  const { viewer } = Route.useRouteContext();
  const search = Route.useSearch();
  const navigate = useNavigate();
  // Read once; the address loses them just below.
  const [outcome] = useState(() => parseReconnectOutcome(search.cloudflare));
  const [startOpen] = useState(() => search.reconnect === "1");
  useEffect(() => {
    if (search.cloudflare === undefined && search.reconnect === undefined) return;
    void navigate({ to: ".", search: {}, hash: "connection", replace: true });
  }, [navigate, search.cloudflare, search.reconnect]);
  // The address this browser uses (an Access hostname, a custom domain or
  // workers.dev), which is the one appflare.dev should send it back to.
  return (
    <AccountSettingsView
      {...data}
      viewer={viewer}
      managerUrl={window.location.origin}
      reconnectOutcome={outcome}
      reconnectOpen={startOpen}
    />
  );
}
