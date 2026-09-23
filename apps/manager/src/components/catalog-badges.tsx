import type { Plan, Requirement } from "@appflare/schema";
import { Badge, Text, Tooltip } from "@cloudflare/kumo";
import {
  ArchiveIcon,
  BrowserIcon,
  EnvelopeSimpleIcon,
  GlobeIcon,
  type Icon,
  PuzzlePieceIcon,
  SealCheckIcon,
  ShippingContainerIcon,
  SparkleIcon,
} from "@phosphor-icons/react";
import { requirementLabel } from "../catalog/requirements";
import { installCheckBadgeCopy, PLAN_BADGES } from "./catalog-badge-copy";

/**
 * What the catalog index says about an app beyond its name: the Workers plan it
 * needs, when the catalog last checked that it installs, and what the account must offer.
 * The catalog list and each app's page render these same components so their
 * wording always matches.
 */

/** The index's `plan`. */
export function PlanBadge({ plan }: { plan: Plan }) {
  const { variant, label } = PLAN_BADGES[plan];
  return <Badge variant={variant}>{label}</Badge>;
}

/** The index's `lastVerified`: the day on the badge, the exact time in its tooltip. */
export function InstallCheckBadge({ lastVerified }: { lastVerified: string | null }) {
  const copy = installCheckBadgeCopy(lastVerified);
  return (
    // Kumo's default trigger is an unstyled button, so keyboard users can open the tooltip too.
    <Tooltip content={copy.tooltip}>
      {copy.checked ? (
        <Badge variant="success" icon={<SealCheckIcon aria-hidden />}>
          {copy.label}
        </Badge>
      ) : (
        <Badge variant="neutral">{copy.label}</Badge>
      )}
    </Tooltip>
  );
}

/** One icon per `requires` value; a compile error here means a new requirement needs one. */
const REQUIREMENT_ICONS: Record<Requirement, Icon> = {
  r2: ArchiveIcon,
  zone: GlobeIcon,
  "email-routing": EnvelopeSimpleIcon,
  "workers-ai": SparkleIcon,
  "browser-rendering": BrowserIcon,
  containers: ShippingContainerIcon,
};

/** Looked up by plain string: a newer catalog may list a requirement this manager does not know yet. */
const iconsByName: Partial<Record<string, Icon>> = REQUIREMENT_ICONS;

/**
 * The index's `requires` as a row of icons, each named by a tooltip with the
 * same label the app's prerequisites callout uses. Renders nothing when the
 * app needs nothing beyond the Workers baseline.
 */
export function RequirementIcons({ requires }: { requires: readonly string[] }) {
  if (requires.length === 0) return null;
  return (
    <span className="inline-flex items-center gap-2">
      <Text as="span" variant="secondary" size="sm">
        Requires
      </Text>
      {requires.map((requirement) => {
        const RequirementIcon = iconsByName[requirement] ?? PuzzlePieceIcon;
        const label = requirementLabel(requirement);
        return (
          <Tooltip key={requirement} content={label} className="text-kumo-subtle">
            <RequirementIcon size={18} aria-hidden />
            <span className="sr-only">{label}</span>
          </Tooltip>
        );
      })}
    </span>
  );
}
