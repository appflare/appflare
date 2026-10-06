import { TELEMETRY_DOCS_URL } from "@appflare/schema";
import { Link, Switch, Text } from "@cloudflare/kumo";
import { managerSiteLink } from "../site-links";
import { TELEMETRY_COPY, type TelemetryStatus } from "../telemetry/telemetry";

/**
 * The pieces of Settings, Usage data. That page, the docs and the installer's
 * console notice are where usage data is disclosed: no banner anywhere in the
 * app interrupts anyone about it.
 */

/** The "What is sent" link to the docs page. */
export function WhatIsSentLink() {
  return (
    <Link
      href={managerSiteLink(TELEMETRY_DOCS_URL, "usageData")}
      target="_blank"
      rel="noopener noreferrer"
    >
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
      {status.lockedBy === null && (status.devBuild || status.preRelease) && (
        <Text variant="secondary" size="sm">
          {status.devBuild ? TELEMETRY_COPY.devBuild : TELEMETRY_COPY.preRelease}
        </Text>
      )}
    </div>
  );
}
