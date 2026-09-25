import {
  type BuildCommandChoice,
  buildCommandProblem,
  DEFAULT_EXPECTED_BUILD_MINUTES,
} from "@appflare/schema";
import { Banner, Checkbox, Input, Link, Radio } from "@cloudflare/kumo";
import { ShippingContainerIcon } from "@phosphor-icons/react";
import {
  CONTAINERS_PRICING_URL,
  describeInstance,
  estimateBuild,
  formatUsd,
} from "../sandbox/cost";

/**
 * Fields shared by "From a repository" on the Catalog page and "Build from
 * source at a commit" on a catalog app's page: the branch, tag or commit,
 * the build command, and the build's cost confirmation.
 */

export type BuildCommandMode = BuildCommandChoice["mode"];

/** The choice as the form holds it, with the command typed so far. */
export interface BuildCommandState {
  mode: BuildCommandMode;
  command: string;
}

export const INITIAL_BUILD_COMMAND: BuildCommandState = { mode: "detect", command: "" };

/** Why the typed command cannot run, or null (also when another mode is chosen). */
export function buildCommandError(state: BuildCommandState): string | null {
  if (state.mode !== "command") return null;
  const command = state.command.trim();
  if (command.length === 0) return "Enter the command, or choose another option.";
  const problem = buildCommandProblem(command);
  return problem === null ? null : `The command ${problem}.`;
}

/** The choice as the server takes it. */
export function buildCommandChoice(state: BuildCommandState): BuildCommandChoice {
  return state.mode === "command"
    ? { mode: "command", command: state.command.trim() }
    : { mode: state.mode };
}

export function BuildCommandField({
  value,
  onChange,
  disabled,
  detectDescription,
}: {
  value: BuildCommandState;
  onChange(next: BuildCommandState): void;
  disabled?: boolean;
  /** What detection does here (a catalog app's own command comes first). */
  detectDescription: string;
}) {
  const error = buildCommandError(value);
  return (
    <div className="grid gap-3">
      <Radio.Group
        legend="Build command"
        value={value.mode}
        onValueChange={(mode: string) =>
          onChange({ ...value, mode: mode === "none" || mode === "command" ? mode : "detect" })
        }
        disabled={disabled}
      >
        <Radio.Item label="Work it out" description={detectDescription} value="detect" />
        <Radio.Item
          label="Run this command"
          description="One plain command, run after the dependencies are installed and before wrangler bundles the Worker. No pipes, quotes or variables."
          value="command"
        />
        <Radio.Item
          label="None"
          description="Only the wrangler config's own build.command runs, as wrangler deploy would run it."
          value="none"
        />
      </Radio.Group>
      {value.mode === "command" && (
        <Input
          label="Command"
          value={value.command}
          onChange={(e) => onChange({ ...value, command: e.currentTarget.value })}
          placeholder="pnpm run build"
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          disabled={disabled}
          error={value.command.length > 0 ? (error ?? undefined) : undefined}
        />
      )}
    </div>
  );
}

/**
 * The cost of one build in the sandbox Worker, which the admin confirms
 * before it starts. A repository has no catalog estimate, so the default
 * container and length are shown.
 */
export function SourceBuildCostConfirmation({
  checked,
  onChange,
  disabled,
  what,
}: {
  checked: boolean;
  onChange(checked: boolean): void;
  disabled?: boolean;
  /** "the repository" or "Cut at that commit". */
  what: string;
}) {
  const estimate = estimateBuild(undefined, DEFAULT_EXPECTED_BUILD_MINUTES);
  return (
    <div className="grid gap-3">
      <Banner
        variant="alert"
        icon={<ShippingContainerIcon weight="fill" />}
        title="Built in your account, not checked"
        description={
          <div className="grid gap-2">
            <span>
              Your sandbox Worker clones {what} and builds it in a {describeInstance(estimate)}{" "}
              container on Workers Paid. Its dependencies are installed with install scripts
              disabled and nothing in the container can reach your account, but its build command is
              its own code, and nobody has reviewed it for you. You review what it declares before
              anything is installed.
            </span>
            <span>
              A build that takes {estimate.minutes} minutes costs about {formatUsd(estimate.usd)}{" "}
              beyond the container usage Workers Paid includes each month; a build is billed for as
              long as it actually runs.
            </span>
            <Link href={CONTAINERS_PRICING_URL} target="_blank" rel="noopener noreferrer">
              Containers pricing
              <Link.ExternalIcon />
            </Link>
          </div>
        }
      />
      <Checkbox
        label={`Build it in my sandbox Worker (about ${formatUsd(estimate.usd)} for a ${estimate.minutes}-minute build beyond the included usage)`}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value: boolean) => onChange(value)}
      />
    </div>
  );
}
