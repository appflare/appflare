import { Badge, Text } from "@cloudflare/kumo";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { HealthStatus } from "../db/schema";
import { checkInstallHealth } from "../installs/health.functions";
import { BusyButton } from "./busy-button";
import { Timestamp } from "./timestamp";

/**
 * The health of an install's Worker as its last check recorded it: a badge
 * with the check time and, for admins, "Check now" (one probe of the app's
 * health path) on the install page. Home lists an app whose Worker could not
 * be verified or answers with server errors as not responding.
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
    // Recorded by an install's, an update's or a settings change's check, or
    // by "Check now", so it does not guess why: only some of those make a route go live.
    hint: "The last health check could not reach the app. Open the app to check it.",
  },
  unhealthy: {
    variant: "error",
    label: "Unhealthy",
    hint: "The Worker answered its last health check with a server error.",
  },
};

/** The app page's words for a check Cloudflare Access answered in the app's place. */
const BEHIND_ACCESS = {
  label: "Behind Cloudflare Access",
  hint: "Cloudflare Access answered, so Appflare can't check the app itself. Open the app and sign in to check it.",
};

/**
 * `access`: Cloudflare Access answered the check in the app's place (recorded
 * as `unverified`), which says nothing about the app either way.
 */
export function HealthBadge({
  status,
  access = false,
}: {
  status: HealthStatus | null;
  access?: boolean;
}) {
  if (access && status === "unverified") {
    return (
      <Badge variant="neutral" appearance="dot">
        {BEHIND_ACCESS.label}
      </Badge>
    );
  }
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

/**
 * The install page's health row: badge, when it was checked, and "Check now"
 * for admins. "Check now" records its result, including whether Cloudflare
 * Access answered, and the page reloads the install to show it.
 */
export function InstallHealth({
  installId,
  status,
  access,
  checkedAt,
  canCheck,
}: {
  installId: string;
  status: HealthStatus | null;
  /** Cloudflare Access answered the last check (see `HealthBadge`). */
  access: boolean;
  checkedAt: string | null;
  canCheck: boolean;
}) {
  const behindAccess = access && status === "unverified";
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
        <HealthBadge status={status} access={access} />
        {checkedAt !== null && (
          <Text as="span" variant="secondary" size="sm">
            checked <Timestamp iso={checkedAt} />
          </Text>
        )}
        {canCheck && (
          <BusyButton
            pending={pending}
            size="sm"
            variant="secondary"
            icon={<ArrowsClockwiseIcon />}
            onClick={onCheck}
          >
            Check now
          </BusyButton>
        )}
      </span>
      {status !== null && status !== "verified" && (
        <Text as="span" variant="secondary" size="sm">
          {behindAccess ? BEHIND_ACCESS.hint : HEALTH[status].hint}
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
