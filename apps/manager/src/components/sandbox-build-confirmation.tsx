import type { IndexBuild } from "@appflare/schema";
import { Checkbox, Collapsible, Link, Text } from "@cloudflare/kumo";
import { ShippingContainerIcon } from "@phosphor-icons/react";
import {
  buildCostSentence,
  CONTAINERS_PRICING_URL,
  estimateIndexBuild,
  formatUsd,
  installerCostSentence,
} from "../sandbox/cost";
import { SandboxFirstNote } from "./sandbox-first";

/**
 * The cost confirmation of a sandbox tier install or update: the app has no
 * prebuilt release, so the account's sandbox Worker builds the pinned commit
 * in a container on Workers Paid. The Install (or Update) button stays off
 * until the admin ticks the box. For a self-deploying app (`kind:
 * "installer"`) the container runs the app's own installer instead, with the
 * app's token; it costs the same way. With `sandboxFirst` the install
 * also turns sandbox builds on first, and says so.
 *
 * A quiet block rather than a banner: one line on what happens and the
 * checkbox with the estimate; how it works, the cost detail and the pricing
 * link fold behind "How this works".
 */
export function SandboxBuildConfirmation({
  build,
  checked,
  onChange,
  disabled,
  action,
  kind = "build",
  sandboxFirst = false,
}: {
  build: Pick<IndexBuild, "instanceType" | "expectedMinutes" | "pin">;
  checked: boolean;
  onChange(checked: boolean): void;
  disabled?: boolean;
  /** What the build (or installer run) is for. */
  action: "install" | "update" | "settings change";
  /** A build of the app, or a run of its own installer (self-deploying tier). */
  kind?: "build" | "installer";
  /** Sandbox builds are off and this turns them on first. */
  sandboxFirst?: boolean;
}) {
  const estimate = estimateIndexBuild(build);
  const installer = kind === "installer";
  const commit = <span className="font-mono text-[0.9em]">{build.pin.slice(0, 12)}</span>;
  return (
    <div className="grid gap-2">
      <Text bold>
        <span className="inline-flex items-center gap-1.5">
          <ShippingContainerIcon aria-hidden />
          {installer ? "Deployed by its own installer" : "Built in your account"}
        </span>
      </Text>
      <Text variant="secondary" size="sm">
        {installer
          ? `The ${action} runs the app's own installer in your sandbox Worker, on Workers Paid.`
          : `This app has no prebuilt release, so the ${action} builds it in your sandbox Worker, on Workers Paid.`}
      </Text>
      {sandboxFirst && <SandboxFirstNote />}
      <Checkbox
        label={
          installer
            ? `Run its installer in my sandbox Worker (about ${formatUsd(estimate.usd)} a run beyond the included usage)`
            : `Build it in my sandbox Worker (about ${formatUsd(estimate.usd)} a build beyond the included usage)`
        }
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value: boolean) => onChange(value)}
      />
      <Collapsible.Root>
        <Collapsible.DefaultTrigger>How this works</Collapsible.DefaultTrigger>
        <Collapsible.DefaultPanel>
          <div className="grid gap-2 pt-1">
            <Text variant="secondary" size="sm">
              {installer ? (
                <>
                  The installer runs at commit {commit} with the app's token. It creates and changes
                  the app's Workers and resources itself; Appflare records them, and only the
                  installer deletes them.
                </>
              ) : (
                <>
                  Your sandbox Worker builds commit {commit}. The result is not signed; Appflare
                  checks it came from that commit.
                </>
              )}
            </Text>
            <Text variant="secondary" size="sm">
              {installer ? installerCostSentence(estimate) : buildCostSentence(estimate)}
            </Text>
            <Text variant="secondary" size="sm">
              <Link href={CONTAINERS_PRICING_URL} target="_blank" rel="noopener noreferrer">
                Containers pricing
                <Link.ExternalIcon />
              </Link>
            </Text>
          </div>
        </Collapsible.DefaultPanel>
      </Collapsible.Root>
    </div>
  );
}
