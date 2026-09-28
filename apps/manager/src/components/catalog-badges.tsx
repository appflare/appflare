import type { InstallTier, Plan } from "@appflare/schema";
import { type AppLicense, licenseBadgeCopy } from "@appflare/schema/catalog-display";
import { Badge, Text } from "@cloudflare/kumo";
import {
  ArchiveIcon,
  BrowserIcon,
  ChartLineIcon,
  ClockIcon,
  CubeIcon,
  DatabaseIcon,
  EnvelopeSimpleIcon,
  FlowArrowIcon,
  GlobeIcon,
  type Icon,
  ImageIcon,
  KeyIcon,
  LockKeyIcon,
  PipeIcon,
  PlugsConnectedIcon,
  QueueIcon,
  SealCheckIcon,
  ShippingContainerIcon,
  SparkleIcon,
  VectorThreeIcon,
} from "@phosphor-icons/react";
import type { CapabilitiesView } from "../capabilities/capabilities";
import {
  type AppPrimitives,
  AVAILABILITY_LABELS,
  type Availability,
  PRIMITIVE_LABELS,
  type PrimitiveId,
  type PrimitiveStatus,
  primitiveStatuses,
  primitivesNote,
} from "../catalog/primitives";
import { installCheckBadgeCopy, PLAN_BADGES } from "./catalog-badge-copy";
import { Tooltip } from "./tooltip";

/**
 * What the catalog index says about an app beyond its name, on the app's
 * page and the page of a build from source: the Workers plan it needs, how it
 * is built, when the catalog last tested that it installs, its license, and
 * what it runs on.
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

/**
 * The app's license as its repository declares it: the id in a neutral
 * badge, a muted "Source-available" before a source-available one, and "No
 * license" in the warning tone; what the license allows in the tooltip.
 */
export function LicenseBadge({ license }: { license: AppLicense }) {
  const copy = licenseBadgeCopy(license);
  return (
    <Tooltip content={copy.tooltip}>
      <Badge variant={copy.variant}>
        {copy.prefix !== null && <span className="font-normal opacity-75">{copy.prefix}</span>}
        {copy.label}
      </Badge>
    </Tooltip>
  );
}

/** One icon per primitive; a compile error here means a new primitive needs one. */
export const PRIMITIVE_ICONS: Record<PrimitiveId, Icon> = {
  kv: KeyIcon,
  d1: DatabaseIcon,
  r2: ArchiveIcon,
  "durable-objects": CubeIcon,
  hyperdrive: PlugsConnectedIcon,
  vectorize: VectorThreeIcon,
  "analytics-engine": ChartLineIcon,
  queues: QueueIcon,
  pipelines: PipeIcon,
  workflows: FlowArrowIcon,
  cron: ClockIcon,
  "workers-ai": SparkleIcon,
  "browser-rendering": BrowserIcon,
  images: ImageIcon,
  containers: ShippingContainerIcon,
  "email-routing": EnvelopeSimpleIcon,
  zone: GlobeIcon,
  access: LockKeyIcon,
};

const BADGE_VARIANTS: Record<Availability, "success" | "warning" | "neutral" | "info"> = {
  available: "success",
  unavailable: "warning",
  unknown: "neutral",
  provided: "info",
};

function statusText(status: PrimitiveStatus): string {
  return `${PRIMITIVE_LABELS[status.id]}: ${AVAILABILITY_LABELS[status.availability]}. ${status.reason}`;
}

/** The app page's primitives: a badge per primitive with its name and availability. */
export function PrimitiveBadges({
  primitives,
  capabilities,
  tier,
}: {
  primitives: AppPrimitives;
  capabilities: CapabilitiesView | null;
  tier: InstallTier;
}) {
  const statuses = primitiveStatuses(primitives, capabilities);
  const note = primitivesNote(primitives, tier);
  return (
    <div className="grid justify-items-center gap-2">
      <div className="flex flex-wrap justify-center gap-2">
        {statuses.map((status) => {
          const PrimitiveIcon = PRIMITIVE_ICONS[status.id];
          return (
            <Tooltip key={status.id} content={statusText(status)}>
              <Badge
                variant={BADGE_VARIANTS[status.availability]}
                icon={<PrimitiveIcon aria-hidden />}
              >
                {PRIMITIVE_LABELS[status.id]}
                <span className="sr-only">: {AVAILABILITY_LABELS[status.availability]}</span>
              </Badge>
            </Tooltip>
          );
        })}
        {statuses.length === 0 && note === null && (
          <Text as="span" variant="secondary">
            Worker only: nothing beyond a Worker, which every plan includes.
          </Text>
        )}
      </div>
      {note !== null && (
        <Text as="span" variant="secondary" size="sm">
          {note}
        </Text>
      )}
    </div>
  );
}
