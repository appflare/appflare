import { Badge, Button, Text, Tooltip } from "@cloudflare/kumo";
import { ArrowsClockwiseIcon, QuestionIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { HealthStatus } from "../db/schema";
import { checkInstallHealth } from "../installs/health.functions";
import { formatDateTime } from "./format";

/**
 * The health of an install's Worker as its last check recorded it: a badge
 * with the check time and, for admins, "Check now" (one probe of the app's
 * health path) on the install page; an icon in the installed list when the
 * Worker could not be verified or answers with server errors.
 */

type BadgeVariant = "success" | "warning" | "error" | "neutral";

const HEALTH: Record<HealthStatus, { variant: BadgeVariant; label: string; hint: string }> = {
  verified: {
    variant: "success",
    label: "Verified",
    hint: "The Worker answered its last health check.",
  },
  unverified: {
    variant: "warning",
    label: "Not verified yet",
    hint: "The Worker did not answer its last health check; its route may still have been going live. Open the app to check.",
  },
  unhealthy: {
    variant: "error",
    label: "Unhealthy",
    hint: "The Worker answered its last health check with a server error.",
  },
};

export function HealthBadge({ status }: { status: HealthStatus | null }) {
  if (status === null) {
    return (
      <Badge variant="neutral" appearance="dot">
        Not checked
      </Badge>
    );
  }
  return (
    <Badge variant={HEALTH[status].variant} appearance="dot">
      {HEALTH[status].label}
    </Badge>
  );
}

/** The install page's health row: badge, when it was checked, and "Check now" for admins. */
export function InstallHealth({
  installId,
  status,
  checkedAt,
  canCheck,
}: {
  installId: string;
  status: HealthStatus | null;
  checkedAt: string | null;
  canCheck: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onCheck() {
    setPending(true);
    setError(null);
    try {
      await checkInstallHealth({ data: { installId } });
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not check the app.");
    }
    setPending(false);
  }

  return (
    <span className="grid gap-1.5">
      <span className="flex flex-wrap items-center gap-2">
        <HealthBadge status={status} />
        {checkedAt !== null && (
          <Text as="span" variant="secondary" size="sm">
            checked {formatDateTime(checkedAt)}
          </Text>
        )}
        {canCheck && (
          <Button
            size="sm"
            variant="secondary"
            icon={<ArrowsClockwiseIcon />}
            loading={pending}
            onClick={onCheck}
          >
            Check now
          </Button>
        )}
      </span>
      {status !== null && status !== "verified" && (
        <Text as="span" variant="secondary" size="sm">
          {HEALTH[status].hint}
        </Text>
      )}
      {error !== null && (
        <Text as="span" variant="error" size="sm">
          {error}
        </Text>
      )}
    </span>
  );
}

/** For the installed list: an icon when the last check did not verify the Worker, else nothing. */
export function HealthIcon({
  status,
  checkedAt,
}: {
  status: HealthStatus | null;
  checkedAt: string | null;
}) {
  if (status !== "unverified" && status !== "unhealthy") return null;
  const entry = HEALTH[status];
  const label = `Health: ${entry.label.toLowerCase()} (checked ${formatDateTime(checkedAt)})`;
  const Icon = status === "unhealthy" ? WarningCircleIcon : QuestionIcon;
  return (
    <Tooltip
      content={label}
      render={
        <span
          role="img"
          aria-label={label}
          className={status === "unhealthy" ? "text-kumo-danger" : "text-kumo-warning"}
        />
      }
    >
      <Icon size={18} weight="fill" />
    </Tooltip>
  );
}
