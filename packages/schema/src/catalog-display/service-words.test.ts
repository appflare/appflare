import { describe, expect, it } from "vitest";
import { SERVICE_IDS, type ServiceId } from "../services";
import {
  countOf,
  indefiniteArticle,
  listWords,
  pluralOf,
  SERVICE_NOUNS,
  serviceCount,
  servicesPhrase,
} from "./service-words";

/** Every service id, as one of it and two of it read in a sentence. */
const SAMPLES: ReadonlyArray<readonly [ServiceId, string, string]> = [
  ["kv", "a KV namespace", "two KV namespaces"],
  ["d1", "a D1 database", "two D1 databases"],
  ["r2", "an R2 bucket", "two R2 buckets"],
  ["durable-objects", "a Durable Object class", "two Durable Object classes"],
  ["hyperdrive", "a Hyperdrive configuration", "two Hyperdrive configurations"],
  ["vectorize", "a Vectorize index", "two Vectorize indexes"],
  ["analytics-engine", "Analytics Engine", "Analytics Engine"],
  ["queues", "a queue", "two queues"],
  ["pipelines", "a Pipelines stream", "two Pipelines streams"],
  ["workflows", "a Workflow", "two Workflows"],
  ["cron", "a cron trigger", "two cron triggers"],
  ["workers-ai", "Workers AI", "Workers AI"],
  ["browser-rendering", "Browser Rendering", "Browser Rendering"],
  ["images", "Images", "Images"],
  ["containers", "Containers", "Containers"],
  ["email-routing", "Email Routing", "Email Routing"],
  ["zone", "a domain", "two domains"],
  ["access", "Cloudflare Access", "Cloudflare Access"],
];

describe("service words", () => {
  it("has a sample for every service id", () => {
    expect(SAMPLES.map(([id]) => id)).toEqual([...SERVICE_IDS]);
    expect(Object.keys(SERVICE_NOUNS)).toEqual([...SERVICE_IDS]);
  });

  it.each(SAMPLES)("counts %s: one is %j, two are %j", (id, one, two) => {
    expect(serviceCount(id, 1)).toBe(one);
    expect(serviceCount(id, 2)).toBe(two);
  });

  it("names an uncountable service without an article or a number", () => {
    for (const id of SERVICE_IDS) {
      const noun = SERVICE_NOUNS[id];
      if (noun.countable) continue;
      expect(serviceCount(id, 3)).toBe(noun.name);
      expect(serviceCount(id, 3)).not.toMatch(/^(?:a|an|\d+|three) /);
    }
  });

  it("spells numbers up to nine and writes larger ones as digits", () => {
    expect(serviceCount("queues", 9)).toBe("nine queues");
    expect(serviceCount("queues", 10)).toBe("10 queues");
    expect(serviceCount("kv", 12)).toBe("12 KV namespaces");
  });

  it("joins the mixed list with commas and a final and", () => {
    expect(servicesPhrase([["cron", 1]])).toBe("a cron trigger");
    expect(
      servicesPhrase([
        ["cron", 1],
        ["images", 1],
      ]),
    ).toBe("a cron trigger and Images");
    expect(
      servicesPhrase([
        ["cron", 1],
        ["d1", 2],
        ["r2", 1],
        ["workers-ai", 1],
        ["browser-rendering", 1],
        ["analytics-engine", 1],
        ["images", 1],
      ]),
    ).toBe(
      "a cron trigger, two D1 databases, an R2 bucket, Workers AI, Browser Rendering, Analytics Engine and Images",
    );
    expect(
      servicesPhrase(
        new Map<ServiceId, number>([
          ["kv", 0],
          ["vectorize", 2],
        ]),
      ),
    ).toBe("two Vectorize indexes");
    expect(servicesPhrase([])).toBe("");
  });
});

describe("indefiniteArticle", () => {
  it.each([
    ["R2 bucket", "an"],
    ["KV namespace", "a"],
    ["D1 database", "a"],
    ["SQL database", "an"],
    ["DNS record", "a"],
    ["F1 key", "an"],
    ["index", "an"],
    ["Email route", "an"],
    ["External domain", "an"],
    ["Hyperdrive configuration", "a"],
    ["unique name", "a"],
    ["useful one", "a"],
    ["update", "an"],
    ["hour", "an"],
    ["8-minute build", "an"],
    ["5-minute build", "a"],
    ["", "a"],
  ] as const)("%j takes %j", (phrase, article) => {
    expect(indefiniteArticle(phrase)).toBe(article);
  });
});

describe("countOf and pluralOf", () => {
  it.each([
    ["Vectorize index", "Vectorize indexes"],
    ["Durable Object class", "Durable Object classes"],
    ["Workers route", "Workers routes"],
    ["policy", "policies"],
    ["key", "keys"],
  ])("%j becomes %j", (singular, plural) => {
    expect(pluralOf(singular)).toBe(plural);
  });

  it("counts any noun, with an explicit plural when it is irregular", () => {
    expect(countOf("Rate limit", 1)).toBe("a Rate limit");
    expect(countOf("Email route", 1)).toBe("an Email route");
    expect(countOf("Email route", 3)).toBe("three Email routes");
    expect(countOf("R2 Data Catalog", 2, "R2 Data Catalogs")).toBe("two R2 Data Catalogs");
    expect(countOf("secret", 0)).toBe("no secrets");
  });
});

describe("listWords", () => {
  it.each([
    [[], ""],
    [["A"], "A"],
    [["A", "B"], "A and B"],
    [["A", "B", "C"], "A, B and C"],
  ] as const)("%j reads %j", (items, words) => {
    expect(listWords(items)).toBe(words);
  });
});
