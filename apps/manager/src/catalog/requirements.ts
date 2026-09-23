import type { Requirement } from "@appflare/schema";

/**
 * What each catalog `requires` value asks of the Cloudflare account, as shown
 * on the app's catalog page before installing. Client-safe: the page and the
 * install job's log use the same words.
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
 * The sentence for a requirement. `provisionsEmailRouting`: the app's manifest
 * sets `install.emailRouting`, so the install sets Email Routing up itself.
 */
export function requirementSentence(
  value: string,
  context: { provisionsEmailRouting?: boolean } = {},
): string | null {
  if (value === "email-routing" && context.provisionsEmailRouting === true) {
    return EMAIL_ROUTING_PROVISIONED;
  }
  return byName[value]?.sentence ?? null;
}
