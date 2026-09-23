import { describe, expect, it } from "vitest";
import { RESOURCE_KIND_LABELS, resourceKindLabel } from "../components/format";
import { RESOURCE_KINDS } from "../db/schema";
import {
  CUSTOM_DOMAIN_KIND,
  DATA_RESOURCE_KINDS,
  EMAIL_ROUTE_KIND,
  isDataResourceKind,
  QUEUE_CONSUMER_KIND,
  WORKER_BOUND_KINDS,
} from "./resource-kinds";

describe("resource kinds", () => {
  it("records custom domains as their own kind, labeled for people", () => {
    expect(RESOURCE_KINDS).toContain(CUSTOM_DOMAIN_KIND);
    expect(resourceKindLabel(CUSTOM_DOMAIN_KIND)).toBe("Custom domain");
  });

  it("labels every kind", () => {
    for (const kind of RESOURCE_KINDS) expect(RESOURCE_KIND_LABELS[kind], kind).toBeDefined();
  });

  it("puts every kind in exactly one uninstall treatment", () => {
    for (const kind of RESOURCE_KINDS) {
      const treatments = [
        (DATA_RESOURCE_KINDS as readonly string[]).includes(kind),
        (WORKER_BOUND_KINDS as readonly string[]).includes(kind),
        kind === CUSTOM_DOMAIN_KIND,
        kind === QUEUE_CONSUMER_KIND,
        kind === EMAIL_ROUTE_KIND,
      ].filter(Boolean);
      expect(treatments, kind).toHaveLength(1);
    }
  });

  it("never offers a custom domain or a queue consumer as data to keep", () => {
    expect(isDataResourceKind(CUSTOM_DOMAIN_KIND)).toBe(false);
    expect(isDataResourceKind(QUEUE_CONSUMER_KIND)).toBe(false);
    expect(resourceKindLabel(QUEUE_CONSUMER_KIND)).toBe("Queue consumer");
  });

  it("records email routes as their own kind, never data to keep", () => {
    expect(RESOURCE_KINDS).toContain(EMAIL_ROUTE_KIND);
    expect(resourceKindLabel(EMAIL_ROUTE_KIND)).toBe("Email route");
    expect(isDataResourceKind(EMAIL_ROUTE_KIND)).toBe(false);
  });
});
