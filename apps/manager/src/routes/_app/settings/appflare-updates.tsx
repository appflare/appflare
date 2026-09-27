import { createFileRoute } from "@tanstack/react-router";
import { redirectMovedSettings } from "../../../components/settings-redirect";

/**
 * `/settings/appflare-updates`, where Appflare's own version and updates
 * used to be: they are on the Updates page now, and the anchor this address
 * carried (`#versions`) opens the same section there.
 */
export const Route = createFileRoute("/_app/settings/appflare-updates")({
  beforeLoad: ({ location }) => redirectMovedSettings(location),
});
