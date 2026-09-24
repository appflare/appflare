import { TELEMETRY_DOCS_URL } from "@appflare/schema";
import { Banner, Button, Link, Switch, Text } from "@cloudflare/kumo";
import { ChartBarIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { type NoticeSurface, TELEMETRY_COPY, type TelemetryStatus } from "../telemetry/telemetry";
import { acknowledgeTelemetryNotice } from "../telemetry/telemetry.functions";

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
 * The usage-data notice: what it is for, its switch (on by default), what is
 * and is not sent, and Continue, which records the choice. The setup step shows it inline; the home page shows it
 * as a banner to admins of a manager updated from a version without usage
 * data. Nothing is sent before Continue.
 */
export function UsageDataNotice({
  status,
  via,
  onDone,
}: {
  status: TelemetryStatus;
  via: NoticeSurface;
  onDone: () => void | Promise<void>;
}) {
  const [enabled, setEnabled] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onContinue() {
    setPending(true);
    setError(null);
    try {
      await acknowledgeTelemetryNotice({ data: { enabled, via } });
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the choice.");
      setPending(false);
    }
  }

  const body = (
    <div className="grid gap-3">
      <UsageDataBenefits />
      <UsageDataSwitch status={status} checked={enabled} disabled={pending} onChange={setEnabled} />
      <UsageDataSummary />
      {error !== null && (
        <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={error} />
      )}
    </div>
  );
  const button = (
    <Button variant="primary" loading={pending} onClick={() => void onContinue()}>
      {TELEMETRY_COPY.continue}
    </Button>
  );

  if (via === "banner") {
    return (
      <Banner
        variant="default"
        icon={<ChartBarIcon weight="fill" />}
        title={TELEMETRY_COPY.title}
        description={body}
        action={button}
      />
    );
  }
  return (
    <section className="grid gap-3">
      <Text variant="heading" as="h2">
        {TELEMETRY_COPY.title}
      </Text>
      {body}
      {button}
    </section>
  );
}
