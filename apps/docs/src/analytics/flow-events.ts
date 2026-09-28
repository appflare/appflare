import type { FlowAction, FlowState } from "../install/flow.ts";
import type { SiteEvents } from "./analytics.ts";

/**
 * The analytics events of the install pages and `/my/`, read from their
 * steps. None of them carries the visitor's Appflare address: only whether
 * there is one.
 */

/** What an install page's first step says about the link a visitor followed; null when it names nothing. */
export function installLinkEvent(
  first: FlowState,
  hadManager: boolean,
): SiteEvents["install_link_clicked"] | null {
  if (first.context.page !== "install") return null;
  const { request } = first.context;
  if (request === null) return null;
  return {
    kind: request.kind,
    slug: request.kind === "app" ? request.slug : null,
    repo: request.kind === "repo" ? request.repo : null,
    has_manager: hadManager,
    target: first.view.step === "opening" ? "manager" : "no-manager",
  };
}

/** Whether a click made this browser remember an Appflare, and on which page. */
export function registeredEvent(
  action: FlowAction,
  next: FlowState,
): SiteEvents["manager_registered"] | null {
  if (action.type !== "remember") return null;
  const { view } = next;
  const kept =
    (view.step === "saved" && view.justRemembered) || (view.step === "opening" && view.remembered);
  return kept ? { has_manager: true, page: next.context.page } : null;
}
