import { type ParsedLocation, redirect } from "@tanstack/react-router";
import { settingsRedirect } from "./navigation";

/**
 * For a settings route's `beforeLoad`: when the address is one Settings
 * used to have (`settingsRedirect`), replaces it with where that setting
 * lives now, so old bookmarks and links in older messages still land on
 * the right section.
 */
export function redirectMovedSettings(location: Pick<ParsedLocation, "pathname" | "hash">): void {
  const href = settingsRedirect(location.pathname, location.hash);
  if (href !== null) throw redirect({ href, replace: true });
}
