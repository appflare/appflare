import type { IndexBuild } from "@appflare/schema";
import { Banner, Checkbox, Link } from "@cloudflare/kumo";
import { ShippingContainerIcon } from "@phosphor-icons/react";
import {
  buildCostSentence,
  CONTAINERS_PRICING_URL,
  estimateIndexBuild,
  formatUsd,
  installerCostSentence,
} from "../sandbox/cost";

/**
 * The cost confirmation of a sandbox tier install or update: the app has no
 * prebuilt release, so the account's sandbox Worker builds the pinned commit
 * in a container on Workers Paid. The Install (or Update) button stays off
 * until the admin ticks the box. For a self-deploying app (`kind:
 * "installer"`) the container runs the app's own installer instead, with the
 * app's token; it costs the same way.
 */
export function SandboxBuildConfirmation({
  build,
  checked,
  onChange,
  disabled,
  action,
  kind = "build",
}: {
  build: Pick<IndexBuild, "instanceType" | "expectedMinutes" | "pin">;
  checked: boolean;
  onChange(checked: boolean): void;
  disabled?: boolean;
  /** What the build (or installer run) is for. */
  action: "install" | "update" | "settings change";
  /** A build of the app, or a run of its own installer (self-deploying tier). */
  kind?: "build" | "installer";
}) {
  const estimate = estimateIndexBuild(build);
  if (kind === "installer") {
    return (
      <div className="grid gap-3">
        <Banner
          variant="alert"
          icon={<ShippingContainerIcon weight="fill" />}
          title="Deployed by its own installer"
          description={
            <div className="grid gap-2">
              <span>
                This app ships its own installer. The {action} runs it at commit{" "}
                <span className="font-mono text-[0.9em]">{build.pin.slice(0, 12)}</span> in your
                sandbox Worker, on Workers Paid, with the app's token. The installer creates and
                changes the app's Workers and resources itself; Appflare records them, and only the
                installer deletes them.
              </span>
              <span>{installerCostSentence(estimate)}</span>
              <Link href={CONTAINERS_PRICING_URL} target="_blank" rel="noopener noreferrer">
                Containers pricing
                <Link.ExternalIcon />
              </Link>
            </div>
          }
        />
        <Checkbox
          label={`Run its installer in my sandbox Worker (an estimated ${formatUsd(estimate.usd)} a run beyond the included usage)`}
          checked={checked}
          disabled={disabled}
          onCheckedChange={(value: boolean) => onChange(value)}
        />
      </div>
    );
  }
  return (
    <div className="grid gap-3">
      <Banner
        variant="alert"
        icon={<ShippingContainerIcon weight="fill" />}
        title="Built in your account"
        description={
          <div className="grid gap-2">
            <span>
              This app has no prebuilt release. The {action} builds commit{" "}
              <span className="font-mono text-[0.9em]">{build.pin.slice(0, 12)}</span> in your
              sandbox Worker, on Workers Paid. The result is not signed; Appflare checks it came
              from that commit.
            </span>
            <span>{buildCostSentence(estimate)}</span>
            <Link href={CONTAINERS_PRICING_URL} target="_blank" rel="noopener noreferrer">
              Containers pricing
              <Link.ExternalIcon />
            </Link>
          </div>
        }
      />
      <Checkbox
        label={`Build it in my sandbox Worker (an estimated ${formatUsd(estimate.usd)} a build beyond the included usage)`}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value: boolean) => onChange(value)}
      />
    </div>
  );
}
