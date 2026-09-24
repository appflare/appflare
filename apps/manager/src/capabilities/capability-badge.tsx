import { Badge } from "@cloudflare/kumo";
import { CheckCircleIcon, WarningIcon } from "@phosphor-icons/react";
import type { CapabilityBadge as CapabilityBadgeValue } from "./capabilities";

/**
 * What the account capability probes (or the admin's Workers plan setting)
 * say about one requirement, next to it on the catalog page. Renders nothing
 * when there is nothing to say.
 */
export function CapabilityBadge({ badge }: { badge: CapabilityBadgeValue | null }) {
  if (badge === null) return null;
  return badge.met ? (
    <Badge variant="success" icon={<CheckCircleIcon aria-hidden />}>
      {badge.label}
    </Badge>
  ) : (
    <Badge variant="warning" icon={<WarningIcon aria-hidden />}>
      {badge.label}
    </Badge>
  );
}
