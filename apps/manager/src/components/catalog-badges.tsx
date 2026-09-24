import type { InstallTier, Plan, Requirement } from "@appflare/schema";
import { Badge, Text } from "@cloudflare/kumo";
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
import { type CapabilitiesView, requirementBadge } from "../capabilities/capabilities";
import { requirementLabel } from "../catalog/requirements";
import { installCheckBadgeCopy, PLAN_BADGES } from "./catalog-badge-copy";
import { Tooltip } from "./tooltip";

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

const TIER_BADGES: Record<InstallTier, { label: string; tooltip: string }> = {
  artifact: {
    label: "Signed release",
    tooltip: "Built from its pinned commit and signed by the catalog.",
  },
  sandbox: {
    label: "Built in your account",
    tooltip:
      "No prebuilt release: your sandbox Worker builds the pinned commit on Workers Paid. The build is not signed.",
  },
  "self-deploying": {
    label: "Self-deploying",
    tooltip:
      "Ships its own installer, which your sandbox Worker runs on Workers Paid with a Cloudflare token you create for the app.",
  },
};

/** The index's `tier`: how the app gets built. */
export function TierBadge({ tier }: { tier: InstallTier }) {
  const { label, tooltip } = TIER_BADGES[tier];
  return (
    <Tooltip content={tooltip}>
      {tier === "artifact" ? (
        <Badge variant="neutral" icon={<SealCheckIcon aria-hidden />}>
          {label}
        </Badge>
      ) : (
        <Badge variant="info" icon={<ShippingContainerIcon aria-hidden />}>
          {label}
        </Badge>
      )}
    </Tooltip>
  );
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
 * same label the app's prerequisites callout uses. With the account's
 * detected capabilities, an icon is green when the account meets the
 * requirement, amber when it does not, and neutral when Appflare cannot
 * tell; the tooltip says which. Renders nothing when the app needs nothing
 * beyond the Workers baseline.
 */
export function RequirementIcons({
  requires,
  capabilities = null,
}: {
  requires: readonly string[];
  capabilities?: CapabilitiesView | null;
}) {
  if (requires.length === 0) return null;
  return (
    <span className="inline-flex items-center gap-2">
      <Text as="span" variant="secondary" size="sm">
        Requires
      </Text>
      {requires.map((requirement) => {
        const RequirementIcon = iconsByName[requirement] ?? PuzzlePieceIcon;
        const badge = capabilities === null ? null : requirementBadge(requirement, capabilities);
        const label =
          badge === null
            ? requirementLabel(requirement)
            : `${requirementLabel(requirement)}. ${badge.label}`;
        const tone =
          badge === null
            ? "text-kumo-subtle"
            : badge.met
              ? "text-kumo-success"
              : "text-kumo-warning";
        return (
          <Tooltip key={requirement} content={label} className={tone}>
            <RequirementIcon size={18} aria-hidden weight={badge === null ? "regular" : "fill"} />
            <span className="sr-only">{label}</span>
          </Tooltip>
        );
      })}
    </span>
  );
}
