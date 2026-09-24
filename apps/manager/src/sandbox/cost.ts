import {
  DEFAULT_EXPECTED_BUILD_MINUTES,
  DEFAULT_SANDBOX_INSTANCE_TYPE,
  type IndexBuild,
  type SandboxInstanceType,
} from "@appflare/schema";

/**
 * What one sandbox build costs on Workers Paid. A build runs one container
 * for as long as it takes; Cloudflare bills its memory, vCPU and disk by the
 * second beyond what Workers Paid includes each month. Rates and sizes as
 * published on developers.cloudflare.com/containers/pricing/ and
 * /containers/platform-details/limits/ (September 2026); the estimate is
 * shown as approximate and links to that page. The minutes are the catalog
 * entry's `expectedMinutes`, an estimate by whoever packaged the app, and are
 * always worded as one: a build is billed for as long as it actually runs.
 * Client-safe (no bindings).
 */

export interface InstanceSize {
  vcpu: number;
  memoryGiB: number;
  diskGB: number;
}

export const INSTANCE_SIZES: Record<SandboxInstanceType, InstanceSize> = {
  "standard-1": { vcpu: 0.5, memoryGiB: 4, diskGB: 8 },
  "standard-2": { vcpu: 1, memoryGiB: 6, diskGB: 12 },
};

/** US dollars per unit-second beyond the included usage. */
export const CONTAINER_RATES = {
  memoryGiBSecond: 0.0000025,
  vcpuSecond: 0.00002,
  diskGBSecond: 0.00000007,
} as const;

/** What Workers Paid includes each month, in unit-seconds. */
export const INCLUDED_PER_MONTH = {
  memoryGiBSeconds: 25 * 3600,
  vcpuSeconds: 375 * 60,
  diskGBSeconds: 200 * 3600,
} as const;

export const CONTAINERS_PRICING_URL = "https://developers.cloudflare.com/containers/pricing/";

export interface BuildEstimate {
  instanceType: SandboxInstanceType;
  size: InstanceSize;
  /** Estimated wall-clock minutes of one build (the catalog's `expectedMinutes`). */
  minutes: number;
  /** US dollars one build of the estimated length costs beyond the included usage. */
  usd: number;
  /** About how many such builds the included usage covers each month (rounded down to 5). */
  includedBuilds: number;
}

export function estimateBuild(
  instanceType: SandboxInstanceType = DEFAULT_SANDBOX_INSTANCE_TYPE,
  minutes: number = DEFAULT_EXPECTED_BUILD_MINUTES,
): BuildEstimate {
  const size = INSTANCE_SIZES[instanceType];
  const seconds = minutes * 60;
  const memory = size.memoryGiB * seconds;
  const vcpu = size.vcpu * seconds;
  const disk = size.diskGB * seconds;
  const usd =
    memory * CONTAINER_RATES.memoryGiBSecond +
    vcpu * CONTAINER_RATES.vcpuSecond +
    disk * CONTAINER_RATES.diskGBSecond;
  const covered = Math.min(
    INCLUDED_PER_MONTH.memoryGiBSeconds / memory,
    INCLUDED_PER_MONTH.vcpuSeconds / vcpu,
    INCLUDED_PER_MONTH.diskGBSeconds / disk,
  );
  return {
    instanceType,
    size,
    minutes,
    usd,
    includedBuilds: covered >= 5 ? Math.floor(covered / 5) * 5 : Math.floor(covered),
  };
}

/** The estimate of an index entry's build block. */
export function estimateIndexBuild(
  build: Pick<IndexBuild, "instanceType" | "expectedMinutes">,
): BuildEstimate {
  return estimateBuild(build.instanceType, build.expectedMinutes);
}

/** `US$0.012`: three decimals below ten cents, else two. */
export function formatUsd(usd: number): string {
  return `US$${usd.toFixed(usd < 0.1 ? 3 : 2)}`;
}

function formatVcpu(vcpu: number): string {
  return vcpu === 0.5 ? "1/2 vCPU" : `${vcpu} vCPU`;
}

/** "standard-1 (1/2 vCPU, 4 GiB memory, 8 GB disk)" */
export function describeInstance(estimate: BuildEstimate): string {
  const { size } = estimate;
  return `${estimate.instanceType} (${formatVcpu(size.vcpu)}, ${size.memoryGiB} GiB memory, ${size.diskGB} GB disk)`;
}

/** "an estimated 10 minutes", "an estimated 1 minute": how the catalog's minutes are shown. */
export function estimatedMinutes(minutes: number): string {
  return `an estimated ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/**
 * "standard-1 (1/2 vCPU, 4 GiB memory, 8 GB disk) for an estimated 10
 * minutes: about US$0.012 a build of that length beyond the included usage",
 * the short line an app page and the sandbox builds card show.
 */
export function buildCostLine(estimate: BuildEstimate): string {
  return (
    `${describeInstance(estimate)} for ${estimatedMinutes(estimate.minutes)}: about ` +
    `${formatUsd(estimate.usd)} a build of that length beyond the included usage`
  );
}

/** The sentence the install form and the update confirmation show. */
export function buildCostSentence(estimate: BuildEstimate): string {
  return (
    `Each build runs a ${describeInstance(estimate)} container for ` +
    `${estimatedMinutes(estimate.minutes)} (the catalog's estimate; a build is billed for as long ` +
    `as it actually runs). A build of that length costs about ${formatUsd(estimate.usd)} beyond ` +
    "the container usage Workers Paid includes each month (enough for about " +
    `${estimate.includedBuilds} such builds). A build whose container stops or times out runs ` +
    "once more, which costs as much again."
  );
}

/** The same for a self-deploying app, whose container runs the app's own installer. */
export function installerCostSentence(estimate: BuildEstimate): string {
  return (
    `Each run of the installer uses a ${describeInstance(estimate)} container for ` +
    `${estimatedMinutes(estimate.minutes)} (the catalog's estimate; a run is billed for as long ` +
    `as it actually takes). A run of that length costs about ${formatUsd(estimate.usd)} beyond ` +
    "the container usage Workers Paid includes each month (enough for about " +
    `${estimate.includedBuilds} such runs). Updating and uninstalling run it again.`
  );
}
