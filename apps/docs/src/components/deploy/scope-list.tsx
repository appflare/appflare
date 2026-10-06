import { MANAGER_OAUTH_SCOPE_BY_GROUP, OFFLINE_ACCESS_SCOPE } from "@appflare/cf-api/oauth";
import {
  MANAGER_SCOPE_REASONS,
  OFFLINE_ACCESS_REASON,
  type RequestedGroupKey,
  type ScopeReason,
  scopeReasonText,
} from "@appflare/cf-api/scope-reasons";
import { Button } from "@cloudflare/kumo/components/button";
import { Popover } from "@cloudflare/kumo/components/popover";
import type { ScopeExamples } from "../../deploy/scope-examples.ts";

/** One permission Appflare asks for, and why. */
export interface ListedScope {
  /** The OAuth scope id, as Cloudflare's consent page lists it. */
  scope: string;
  reason: ScopeReason;
  /** The reason's sentence, with example apps when there are some. */
  why: string;
}

/**
 * Every scope Appflare asks Cloudflare for, in the order it asks, each with
 * its reason. Billing is never asked for (Cloudflare has no sign-in scope
 * for it), so it is not here.
 */
export function listedScopes(examples: ScopeExamples): ListedScope[] {
  const listed: ListedScope[] = [];
  for (const [group, scope] of Object.entries(MANAGER_OAUTH_SCOPE_BY_GROUP)) {
    if (scope === null) continue;
    const reason = MANAGER_SCOPE_REASONS[group as RequestedGroupKey];
    listed.push({
      scope,
      reason,
      why: scopeReasonText(reason, examples[group as RequestedGroupKey] ?? []),
    });
  }
  listed.push({
    scope: OFFLINE_ACCESS_SCOPE,
    reason: OFFLINE_ACCESS_REASON,
    why: OFFLINE_ACCESS_REASON.text,
  });
  return listed;
}

/**
 * The permissions as a list, each with a "Why?" button that opens its
 * reason in a popover. Kumo's popover (Base UI) opens on a tap or on Enter
 * and Space, closes on Escape or a tap outside, and gives the focus back to
 * the button. Its width never passes the screen's, less a margin.
 */
export function ScopeList({ examples }: { examples: ScopeExamples }) {
  return (
    <ul className="grid divide-y divide-kumo-hairline">
      {listedScopes(examples).map(({ scope, reason, why }) => (
        <li key={scope} className="flex items-center justify-between gap-3 py-1.5">
          <span className="min-w-0 text-kumo-default [overflow-wrap:anywhere]">{reason.label}</span>
          <Popover>
            <Popover.Trigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-kumo-link max-sm:h-11 max-sm:px-3"
                  aria-label={`Why Appflare needs ${reason.label}`}
                />
              }
            >
              Why?
            </Popover.Trigger>
            <Popover.Content side="top" align="end" className="w-80 max-w-[calc(100vw-2rem)]">
              <Popover.Description className="text-kumo-default">{why}</Popover.Description>
              {/* The id Cloudflare's consent page lists, for anyone matching the two. */}
              <p className="mt-1.5 text-kumo-subtle text-xs">
                Cloudflare permission:{" "}
                <span className="font-mono [overflow-wrap:anywhere]" translate="no">
                  {scope}
                </span>
              </p>
            </Popover.Content>
          </Popover>
        </li>
      ))}
    </ul>
  );
}
