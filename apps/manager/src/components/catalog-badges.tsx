import type { InstallTier, Plan } from "@appflare/schema";
import { Badge, cn, Text } from "@cloudflare/kumo";
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
import { installedState } from "../catalog/installed-state";
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
 * What the catalog index says about an app beyond its name: the Workers plan it
 * needs, how it is built, when the catalog last checked that it installs, what
 * it runs on, and whether it is installed here. The catalog list and each
 * app's page render these same components so their wording always matches.
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

/** The tint of a primitive's chip: green available, amber not available, grey unknown. */
const CHIP_TONES: Record<Availability, string> = {
  available: "bg-kumo-success-tint text-kumo-success",
  unavailable: "bg-kumo-warning-tint text-kumo-warning",
  unknown: "bg-kumo-recessed text-kumo-subtle",
  provided: "bg-kumo-info-tint text-kumo-info",
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

/** One primitive as a small tinted icon, named with its availability by tooltip and screen-reader text. */
function PrimitiveChip({ status }: { status: PrimitiveStatus }) {
  const PrimitiveIcon = PRIMITIVE_ICONS[status.id];
  const text = statusText(status);
  return (
    <Tooltip
      content={text}
      className={cn(
        "flex size-7 items-center justify-center rounded-md",
        CHIP_TONES[status.availability],
      )}
    >
      <PrimitiveIcon size={16} aria-hidden />
      <span className="sr-only">{text}</span>
    </Tooltip>
  );
}

/**
 * The primitives line of a catalog card: every primitive the app uses as an
 * icon, always rendered. "Worker only" when the app needs nothing beyond a
 * Worker; a muted note when the list may be incomplete.
 */
export function PrimitiveIcons({
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
    <div className="flex min-h-7 flex-wrap items-center gap-1.5">
      {statuses.map((status) => (
        <PrimitiveChip key={status.id} status={status} />
      ))}
      {statuses.length === 0 && note === null && (
        <Tooltip content="Needs nothing beyond a Worker, which every plan includes.">
          <Text as="span" variant="secondary" size="sm">
            Worker only
          </Text>
        </Tooltip>
      )}
      {note !== null && (
        <Tooltip content={note}>
          <Text as="span" variant="secondary" size="sm">
            More on its page
          </Text>
        </Tooltip>
      )}
    </div>
  );
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

/** What the tints mean, once, above the cards. */
export function AvailabilityLegend() {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      {(Object.keys(CHIP_TONES) as Availability[]).map((availability) => (
        <span key={availability} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className={cn("size-3 rounded-sm ring ring-kumo-hairline", CHIP_TONES[availability])}
          />
          <Text as="span" variant="secondary" size="sm">
            {AVAILABILITY_LABELS[availability]}
          </Text>
        </span>
      ))}
    </span>
  );
}

/** Whether the app is installed here: one dot badge for one install or several; nothing when it is not. */
export function InstalledBadge({
  instances,
}: {
  instances: ReadonlyArray<{ status: string; instanceName: string }>;
}) {
  const state = installedState(instances);
  if (state === null) return null;
  return (
    <Tooltip content={state.details.join(", ")}>
      <Badge variant={state.tone} appearance="dot">
        {state.label}
      </Badge>
    </Tooltip>
  );
}
