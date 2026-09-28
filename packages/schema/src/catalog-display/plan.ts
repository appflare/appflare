import type { Plan } from "../catalog";

/** A plan as one short word for tiles and pills; its full name for tooltips and screen readers. */
export const PLAN_WORDS: Record<Plan, { word: string; name: string; tooltip: string }> = {
  free: { word: "Free", name: "Workers Free", tooltip: "Works on the Workers Free plan" },
  paid: { word: "Paid", name: "Workers Paid", tooltip: "Needs the Workers Paid plan" },
};

/** A plan as the app page's stat strip shows it, with the sentence behind it. */
export const PLAN_STATS: Record<Plan, { value: string; tooltip: string }> = {
  free: { value: "Free", tooltip: "Runs on Cloudflare's free Workers plan." },
  paid: {
    value: "Workers Paid",
    tooltip: "Needs Cloudflare's Workers Paid plan on your account.",
  },
};
