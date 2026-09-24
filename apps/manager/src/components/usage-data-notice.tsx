import { TELEMETRY_DOCS_URL } from "@appflare/schema";
import { Banner, Link, Switch, Text } from "@cloudflare/kumo";
import { ChartBarIcon, WarningCircleIcon, XIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { TELEMETRY_COPY, type TelemetryStatus } from "../telemetry/telemetry";

/** The "What is sent" link to the docs page. */
export function WhatIsSentLink() {
  return (
    <Link href={TELEMETRY_DOCS_URL} target="_blank" rel="noopener noreferrer">
      {TELEMETRY_COPY.whatIsSent}
      <Link.ExternalIcon />
    </Link>
  );
}

/** What leaving usage data on does for the people who run Appflare; shown before the switch. */
export function UsageDataBenefits() {
  return (
    <div className="grid gap-1.5">
      <Text>{TELEMETRY_COPY.benefitsIntro}</Text>
      <ul className="grid list-disc gap-1 pl-5">
        {TELEMETRY_COPY.benefits.map((benefit) => (
          <li key={benefit}>
            <Text as="span">{benefit}</Text>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What is and is never sent, with the link to the full list; shown after the switch. */
export function UsageDataSummary() {
  return (
    <div className="grid gap-1.5">
      <Text variant="secondary">{TELEMETRY_COPY.sent}</Text>
      <Text variant="secondary">{TELEMETRY_COPY.neverSent}</Text>
      <WhatIsSentLink />
    </div>
  );
}

/** The switch, off and disabled with the reason when a Worker variable turns usage data off. */
export function UsageDataSwitch({
  status,
  checked,
  disabled,
  onChange,
}: {
  status: TelemetryStatus;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  const locked = status.lockedBy !== null;
  return (
    <div className="grid gap-1">
      <Switch
        label={TELEMETRY_COPY.switchLabel}
        checked={locked ? false : checked}
        disabled={locked || disabled === true}
        onCheckedChange={onChange}
      />
      {status.lockedBy !== null && (
        <Text variant="secondary" size="sm">
          {TELEMETRY_COPY.lockedBy(status.lockedBy)}
        </Text>
      )}
      <Text variant="secondary" size="sm">
        {TELEMETRY_COPY.scope}
      </Text>
      {status.lockedBy === null && status.devBuild && (
        <Text variant="secondary" size="sm">
          {TELEMETRY_COPY.devBuild}
        </Text>
      )}
    </div>
  );
}

/**
 * The usage-data notice: usage data is on (or which Worker variable turns it
 * off), what it is for, and how to turn it off. It only informs; nothing
 * waits for it. The last setup screen shows it as it is; the home page shows
 * it once per manager, to admins of a manager updated from a version without
 * usage data, with `onDismiss`, which hides it for every admin.
 */
export function UsageDataNotice({
  status,
  onDismiss,
}: {
  status: TelemetryStatus;
  onDismiss?: () => Promise<void>;
}) {
  const [dismissing, setDismissing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function dismiss(run: () => Promise<void>) {
    setDismissing(true);
    setError(null);
    try {
      await run();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not dismiss the notice.");
      setDismissing(false);
    }
  }

  const locked = status.lockedBy;
  return (
    <div className="grid gap-2">
      <Banner
        variant={locked === null ? "default" : "secondary"}
        icon={<ChartBarIcon weight="fill" />}
        title={locked === null ? TELEMETRY_COPY.noticeOn : TELEMETRY_COPY.noticeOff}
        description={
          <div className="grid gap-1.5">
            {locked === null ? (
              <>
                <p>{TELEMETRY_COPY.noticeBody}</p>
                <p>{TELEMETRY_COPY.noticeTurnOff}</p>
                {status.devBuild && <p>{TELEMETRY_COPY.devBuild}</p>}
              </>
            ) : (
              <p>{TELEMETRY_COPY.noticeLocked(locked)}</p>
            )}
            <span>
              <WhatIsSentLink />
            </span>
          </div>
        }
        action={
          onDismiss === undefined ? undefined : (
            <Banner.Action
              variant="ghost"
              icon={<XIcon />}
              aria-label={TELEMETRY_COPY.dismiss}
              title={TELEMETRY_COPY.dismiss}
              loading={dismissing}
              onClick={() => void dismiss(onDismiss)}
            />
          )
        }
      />
      {error !== null && (
        <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={error} />
      )}
    </div>
  );
}
