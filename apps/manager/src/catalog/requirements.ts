import type { InstallTier, Requirement } from "@appflare/schema";

/**
 * What each catalog `requires` value asks of the Cloudflare account, as shown
 * on the app's catalog page before installing. Client-safe: the page and the
 * install job's log use the same words. `sentence` describes an `artifact`
 * tier app; {@link requirementSentence} swaps in the other tiers' wording
 * where the requirement means something else for them.
 */
export const REQUIREMENTS: Record<Requirement, { label: string; sentence: string }> = {
  r2: {
    label: "R2",
    sentence:
      "R2 must be enabled on the account, which needs a payment method on file even on the free tier.",
  },
  zone: {
    label: "A zone on this account",
    sentence:
      "The account needs an active zone, a domain added to Cloudflare, for the app's routes or DNS records.",
  },
  "email-routing": {
    label: "Email Routing",
    sentence:
      "Email Routing must be enabled on a zone in the account so that email can be delivered to the app's Worker.",
  },
  "workers-ai": {
    label: "Workers AI",
    sentence:
      "The app runs models on Workers AI, where use beyond the daily free allocation needs Workers Paid.",
  },
  "browser-rendering": {
    label: "Browser Rendering",
    sentence:
      "The app drives a headless browser with Browser Rendering, whose free plan allows limited browser time a day.",
  },
  containers: {
    label: "Containers",
    sentence: "The app runs Containers, which need the Workers Paid plan on the account.",
  },
};

/**
 * Sentences that differ from {@link REQUIREMENTS} for the tiers that run in
 * the account's sandbox Worker. There the container is where the app is
 * built (`sandbox`) or where its own installer runs (`self-deploying`), not
 * something the app itself runs. A self-deploying app's installer creates
 * its own Workers, and Appflare does not set Email Routing up for it.
 */
const TIER_SENTENCES: Record<
  Exclude<InstallTier, "artifact">,
  Partial<Record<Requirement, string>>
> = {
  sandbox: {
    containers:
      "The app is built in a container in this account, which needs the Workers Paid plan.",
  },
  "self-deploying": {
    containers:
      "The app's installer runs in a container in this account, which needs the Workers Paid plan.",
    "email-routing":
      "Email Routing must be enabled on a zone in the account so that email can be delivered to the app. Appflare does not set Email Routing up for an app that deploys itself.",
  },
};

/**
 * The Email Routing sentence for an app whose manifest sets
 * `install.emailRouting`: Appflare sets routing up itself, on the zone the
 * admin chooses in the install form.
 */
const EMAIL_ROUTING_PROVISIONED =
  "The app receives email through Email Routing on a zone of this account that uses Cloudflare DNS. You choose the zone in the install form; Appflare turns Email Routing on there if it is off and points the app's addresses at its Worker. The Cloudflare token needs the Email Routing permissions for that.";

/** Looked up by plain string: a newer catalog may list a requirement this manager does not know yet. */
const byName: Partial<Record<string, { label: string; sentence: string }>> = REQUIREMENTS;

export function requirementLabel(value: string): string {
  return byName[value]?.label ?? value;
}

/**
 * The sentence for a requirement of an app of `tier`. `provisionsEmailRouting`:
 * the app's manifest sets `install.emailRouting`, so the install sets Email
 * Routing up itself. Only installs Appflare deploys do that; a self-deploying
 * app's installer deploys it instead.
 */
export function requirementSentence(
  value: string,
  context: { tier: InstallTier; provisionsEmailRouting?: boolean },
): string | null {
  const { tier } = context;
  if (
    value === "email-routing" &&
    context.provisionsEmailRouting === true &&
    tier !== "self-deploying"
  ) {
    return EMAIL_ROUTING_PROVISIONED;
  }
  if (tier !== "artifact") {
    const byTier: Partial<Record<string, string>> = TIER_SENTENCES[tier];
    const sentence = byTier[value];
    if (sentence !== undefined) return sentence;
  }
  return byName[value]?.sentence ?? null;
}
