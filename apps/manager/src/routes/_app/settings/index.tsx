import { createFileRoute } from "@tanstack/react-router";
import { redirectMovedSettings } from "../../../components/settings-redirect";

/**
 * `/settings` has no page of its own: it opens Your account, and an anchor
 * of the pages it used to be (`/settings#automatic-updates`) opens the
 * section it named, wherever that lives now.
 */
export const Route = createFileRoute("/_app/settings/")({
  beforeLoad: ({ location }) => redirectMovedSettings(location),
});
