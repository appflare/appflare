import { describe, expect, it, vi } from "vitest";

// The server functions only exist under the Start Vite plugin.
vi.mock("../installs/custom-domains.functions", () => ({ getDomainOptions: vi.fn() }));
vi.mock("../installs/external-domains.functions", () => ({ getExternalDomainOptions: vi.fn() }));
vi.mock("../installs/worker-names.functions", () => ({ listTakenWorkerNames: vi.fn() }));

const { addressDomain, domainGroups, domainMatches, workersDevStatus, zoneNote } = await import(
  "./install-address-field"
);

const base = {
  zones: [{ id: "z1", name: "example.com" }],
  name: "links",
  wildcard: false,
  wholeDomainAgreed: false,
  hostname: "",
  gateway: "gateway.example.net",
  accountZones: ["example.com"],
  method: "http" as const,
};

describe("the address an install gets", () => {
  it("is workers.dev only until a domain is picked", () => {
    expect(addressDomain({ ...base, place: "workers" }).domain).toBeNull();
  });

  it("is the typed name under a domain of the account, or the domain itself when empty", () => {
    expect(addressDomain({ ...base, place: "zone:z1" }).domain).toEqual({
      kind: "custom",
      zoneId: "z1",
      hostname: "links.example.com",
    });
    expect(addressDomain({ ...base, place: "zone:z1", name: "" }).domain).toEqual({
      kind: "custom",
      zoneId: "z1",
      hostname: "example.com",
    });
    // Another domain typed in full is refused, not put under this one.
    const refused = addressDomain({ ...base, place: "zone:z1", name: "evil.org" });
    expect(refused.domain).toBeNull();
    expect(refused.zoneCheck?.ok).toBe(false);
  });

  it("asks before a wildcard takes a whole domain", () => {
    const wildcard = { ...base, place: "zone:z1" as const, wildcard: true, name: "" };
    expect(addressDomain(wildcard).domain).toBeNull();
    expect(addressDomain({ ...wildcard, wholeDomainAgreed: true }).domain).toEqual({
      kind: "wildcard",
      zoneId: "z1",
      hostname: "example.com",
      wholeDomain: true,
    });
    expect(addressDomain({ ...wildcard, name: "tunnels" }).domain).toEqual({
      kind: "wildcard",
      zoneId: "z1",
      hostname: "tunnels.example.com",
    });
  });

  it("is a whole hostname elsewhere, through the gateway, with how it is verified", () => {
    const elsewhere = { ...base, place: "external" as const, hostname: "Links.Example.org" };
    expect(addressDomain(elsewhere).domain).toEqual({
      kind: "external",
      hostname: "links.example.org",
      validation: "http",
    });
    // A name in the account's own domains is a custom domain instead.
    expect(addressDomain({ ...elsewhere, hostname: "go.example.com" }).domain).toBeNull();
    // Without a gateway nothing elsewhere can be served.
    expect(addressDomain({ ...elsewhere, gateway: null }).domain).toBeNull();
  });
});

describe("the lines under the address", () => {
  it("say green or red at a glance, checking while it checks, and nothing while idle", () => {
    expect(workersDevStatus({ state: "free" }, null)).toEqual({
      tone: "success",
      text: "Available",
    });
    expect(workersDevStatus({ state: "checking" }, null)?.tone).toBe("pending");
    expect(workersDevStatus(null, null)).toBeNull();
    expect(workersDevStatus({ state: "taken", message: "Taken." }, null)).toEqual({
      tone: "danger",
      text: "Taken.",
    });
    expect(workersDevStatus(null, { appName: "Mailflare" })?.text).toContain(
      "installs once per account",
    );
  });

  it("name a domain taken whole, and every name under a wildcard", () => {
    expect(zoneNote("example.com", "example.com", false)).toContain(
      "The app takes example.com itself",
    );
    expect(zoneNote("tunnels.example.com", "example.com", true)).toContain("*.tunnels.example.com");
    expect(zoneNote("links.example.com", "example.com", false)).toContain(
      "workers.dev address turns off",
    );
  });
});

describe("the domain picker", () => {
  const zones = [
    { id: "z1", name: "example.com" },
    { id: "z2", name: "garnet.dev" },
  ];
  const base = {
    workersDev: "acme.workers.dev",
    zones,
    loading: false,
    missing: [],
    withDomains: true,
    wildcard: false,
  };

  it("lists workers.dev, then the account's domains, then another domain", () => {
    expect(domainGroups(base).map((g) => [g.value, g.items.map((i) => i.value)])).toEqual([
      ["workers.dev", ["workers"]],
      ["Your domains", ["zone:z1", "zone:z2"]],
      ["Elsewhere", ["external"]],
    ]);
  });

  it("says why there is no domain to pick, and offers none elsewhere to a wildcard app", () => {
    expect(domainGroups({ ...base, zones: null, loading: true })[1]?.items[0]?.label).toBe(
      "Reading your domains…",
    );
    expect(domainGroups({ ...base, zones: [], missing: ["Zone: Read"] })[1]?.items[0]).toEqual({
      value: "none",
      label: "None the token can see (it may lack Zone: Read)",
      disabled: true,
    });
    expect(domainGroups({ ...base, wildcard: true }).map((g) => g.value)).toEqual([
      "workers.dev",
      "Your domains, with every name under it",
    ]);
    expect(domainGroups({ ...base, withDomains: false })).toHaveLength(1);
  });

  it("filters by what is typed, and always keeps another domain", () => {
    const [, mine, elsewhere] = domainGroups(base);
    const garnet = mine?.items[1];
    const other = elsewhere?.items[0];
    if (garnet === undefined || other === undefined) throw new Error("missing options");
    expect(domainMatches(garnet, "GAR")).toBe(true);
    expect(domainMatches(garnet, "example")).toBe(false);
    expect(domainMatches(other, "zzz")).toBe(true);
    expect(domainMatches(garnet, "  ")).toBe(true);
  });
});
