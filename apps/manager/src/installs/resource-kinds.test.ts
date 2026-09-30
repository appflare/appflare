import { describe, expect, it } from "vitest";
import { RESOURCE_KIND_LABELS, resourceKindLabel } from "../components/format";
import { RESOURCE_KINDS } from "../db/schema";
import {
  ACCESS_KINDS,
  ADDRESS_KINDS,
  CUSTOM_DOMAIN_KIND,
  CUSTOM_HOSTNAME_KIND,
  DATA_RESOURCE_KINDS,
  EMAIL_ROUTE_KIND,
  HYPERDRIVE_KIND,
  HYPERDRIVE_KINDS,
  HYPERDRIVE_SUPERSEDED_KIND,
  isDataResourceKind,
  PIPELINE_KINDS,
  PIPELINE_STREAM_KIND,
  QUEUE_CONSUMER_KIND,
  R2_CATALOG_KIND,
  WILDCARD_DOMAIN_KIND,
  WILDCARD_PARTS_KINDS,
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
        kind === CUSTOM_HOSTNAME_KIND,
        kind === WILDCARD_DOMAIN_KIND,
        (WILDCARD_PARTS_KINDS as readonly string[]).includes(kind),
        kind === QUEUE_CONSUMER_KIND,
        kind === EMAIL_ROUTE_KIND,
        (HYPERDRIVE_KINDS as readonly string[]).includes(kind),
        (PIPELINE_KINDS as readonly string[]).includes(kind),
        kind === R2_CATALOG_KIND,
        (ACCESS_KINDS as readonly string[]).includes(kind),
      ].filter(Boolean);
      expect(treatments, kind).toHaveLength(1);
    }
  });

  it("never offers a custom domain or a queue consumer as data to keep", () => {
    expect(isDataResourceKind(CUSTOM_DOMAIN_KIND)).toBe(false);
    expect(isDataResourceKind(QUEUE_CONSUMER_KIND)).toBe(false);
    expect(resourceKindLabel(QUEUE_CONSUMER_KIND)).toBe("Queue consumer");
  });

  it("records external domains as their own address kind, never data to keep", () => {
    expect(RESOURCE_KINDS).toContain(CUSTOM_HOSTNAME_KIND);
    expect(resourceKindLabel(CUSTOM_HOSTNAME_KIND)).toBe("External domain");
    expect(isDataResourceKind(CUSTOM_HOSTNAME_KIND)).toBe(false);
    expect(ADDRESS_KINDS).toEqual([CUSTOM_DOMAIN_KIND, CUSTOM_HOSTNAME_KIND, WILDCARD_DOMAIN_KIND]);
  });

  it("records a wildcard domain as an address, and its records and routes apart, never data", () => {
    expect(RESOURCE_KINDS).toContain(WILDCARD_DOMAIN_KIND);
    expect(resourceKindLabel(WILDCARD_DOMAIN_KIND)).toBe("Wildcard domain");
    expect(isDataResourceKind(WILDCARD_DOMAIN_KIND)).toBe(false);
    for (const kind of WILDCARD_PARTS_KINDS) {
      expect(RESOURCE_KINDS).toContain(kind);
      expect(isDataResourceKind(kind)).toBe(false);
      expect(ADDRESS_KINDS as readonly string[]).not.toContain(kind);
    }
    expect(WILDCARD_PARTS_KINDS.map(resourceKindLabel)).toEqual(["DNS record", "Workers route"]);
  });

  it("records Hyperdrive configurations as their own kind, never data to keep", () => {
    expect(RESOURCE_KINDS).toContain(HYPERDRIVE_KIND);
    expect(resourceKindLabel(HYPERDRIVE_KIND)).toBe("Hyperdrive configuration");
    expect(isDataResourceKind(HYPERDRIVE_KIND)).toBe(false);
    expect(RESOURCE_KINDS).toContain(HYPERDRIVE_SUPERSEDED_KIND);
    expect(resourceKindLabel(HYPERDRIVE_SUPERSEDED_KIND)).toBe("Replaced Hyperdrive configuration");
    expect(isDataResourceKind(HYPERDRIVE_SUPERSEDED_KIND)).toBe(false);
  });

  it("records Pipelines objects and a bucket's Data Catalog as their own kinds, never data to keep", () => {
    for (const kind of [...PIPELINE_KINDS, R2_CATALOG_KIND]) {
      expect(RESOURCE_KINDS).toContain(kind);
      expect(isDataResourceKind(kind)).toBe(false);
    }
    // The pipeline reads the stream and writes the sink, so it goes first.
    expect(PIPELINE_KINDS).toEqual(["pipeline", "pipeline_sink", PIPELINE_STREAM_KIND]);
    expect(resourceKindLabel(R2_CATALOG_KIND)).toBe("R2 Data Catalog");
  });

  it("records an app's Access application and token as their own kinds, never data to keep", () => {
    for (const kind of ACCESS_KINDS) {
      expect(RESOURCE_KINDS).toContain(kind);
      expect(isDataResourceKind(kind)).toBe(false);
    }
    expect(ACCESS_KINDS.map(resourceKindLabel)).toEqual([
      "Access application",
      "Access service token",
    ]);
  });

  it("records email routes as their own kind, never data to keep", () => {
    expect(RESOURCE_KINDS).toContain(EMAIL_ROUTE_KIND);
    expect(resourceKindLabel(EMAIL_ROUTE_KIND)).toBe("Email route");
    expect(isDataResourceKind(EMAIL_ROUTE_KIND)).toBe(false);
  });
});
