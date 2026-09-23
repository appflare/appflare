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

/** Looked up by plain string: a newer catalog may list a requirement this manager does not know yet. */
const byName: Partial<Record<string, { label: string; sentence: string }>> = REQUIREMENTS;

export function requirementLabel(value: string): string {
  return byName[value]?.label ?? value;
}

export function requirementSentence(value: string): string | null {
  return byName[value]?.sentence ?? null;
}
