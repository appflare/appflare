import type { ServiceId } from "../services";

/**
 * How a sentence counts what an app uses or what an install adds: "a D1
 * database", "two KV namespaces", "an R2 bucket", and, for a service that
 * is not counted in units, its name alone ("Images", "Workers AI"). Lists
 * join with commas and "and": "a cron trigger, two queues and Images".
 */

/** A resource counted in units, or a service named as a whole. */
export type ServiceNoun =
  | { countable: true; singular: string; plural: string }
  | { countable: false; name: string };

function countable(singular: string): ServiceNoun {
  return { countable: true, singular, plural: pluralOf(singular) };
}

function uncountable(name: string): ServiceNoun {
  return { countable: false, name };
}

/**
 * Each service as a sentence names it. A service whose resources the install
 * creates one by one is counted by that resource; a product the Worker binds
 * as a whole, or that the account turns on, is named alone.
 */
export const SERVICE_NOUNS: Record<ServiceId, ServiceNoun> = {
  kv: countable("KV namespace"),
  d1: countable("D1 database"),
  r2: countable("R2 bucket"),
  "durable-objects": countable("Durable Object class"),
  hyperdrive: countable("Hyperdrive configuration"),
  vectorize: countable("Vectorize index"),
  "analytics-engine": uncountable("Analytics Engine"),
  queues: countable("queue"),
  pipelines: countable("Pipelines stream"),
  workflows: countable("Workflow"),
  cron: countable("cron trigger"),
  "workers-ai": uncountable("Workers AI"),
  "browser-rendering": uncountable("Browser Rendering"),
  images: uncountable("Images"),
  containers: uncountable("Containers"),
  "email-routing": uncountable("Email Routing"),
  zone: countable("domain"),
  access: uncountable("Cloudflare Access"),
};

/** "index" to "indexes", "class" to "classes", "policy" to "policies", else an "s". */
export function pluralOf(singular: string): string {
  if (/(?:s|x|z|ch|sh)$/.test(singular)) return `${singular}es`;
  if (/[^aeiou]y$/.test(singular)) return `${singular.slice(0, -1)}ies`;
  return `${singular}s`;
}

/** Letters whose spoken name starts with a vowel sound: "an F", "an R2", "an SQL". */
const VOWEL_SOUND_LETTERS: ReadonlySet<string> = new Set("AEFHILMNORSX");

/**
 * "a" or "an" before `phrase`, by how its first word sounds. An initialism
 * ("KV", "R2", "DNS") is read letter by letter, so "an R2 bucket" and "a KV
 * namespace"; a word by its first sound, so "an index", "a unique name" and
 * "an hour".
 */
export function indefiniteArticle(phrase: string): "a" | "an" {
  const word = phrase.trim().split(/\s+/, 1)[0] ?? "";
  if (word === "") return "a";
  if (/^\d/.test(word)) return /^(?:8|11|18)(?:\D|$)/.test(word) ? "an" : "a";
  if (/^[A-Z][A-Z0-9]*$/.test(word)) {
    return VOWEL_SOUND_LETTERS.has(word.charAt(0)) ? "an" : "a";
  }
  const lower = word.toLowerCase();
  // A "you" or "w" sound, spelled with a vowel.
  if (/^(?:uni|use|usu|uti|ur[aeiou]|eu|one$|once$)/.test(lower)) return "a";
  // A silent "h".
  if (/^(?:hour|honest|honou?r|heir)/.test(lower)) return "an";
  return /^[aeiou]/.test(lower) ? "an" : "a";
}

const NUMBER_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

/**
 * `count` of a countable noun: "a D1 database", "an R2 bucket", "two KV
 * namespaces", "12 queues". Numbers up to nine are spelled out.
 */
export function countOf(singular: string, count: number, plural = pluralOf(singular)): string {
  if (count === 1) return `${indefiniteArticle(singular)} ${singular}`;
  const number =
    Number.isInteger(count) && count >= 0 && count < NUMBER_WORDS.length
      ? NUMBER_WORDS[count]
      : String(count);
  return `${number} ${plural}`;
}

/** A service in a sentence: its resource counted ("two queues"), or its name ("Images"). */
export function serviceCount(id: ServiceId, count: number): string {
  const noun = SERVICE_NOUNS[id];
  return noun.countable ? countOf(noun.singular, count, noun.plural) : noun.name;
}

/** "A", "A and B", "A, B and C". */
export function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * Services and how many of each, as one list: "a cron trigger, two D1
 * databases and Images". A count below one leaves the service out.
 */
export function servicesPhrase(counts: Iterable<readonly [ServiceId, number]>): string {
  const parts: string[] = [];
  for (const [id, count] of counts) {
    if (count >= 1) parts.push(serviceCount(id, count));
  }
  return listWords(parts);
}
