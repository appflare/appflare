import { describe, expect, it } from "vitest";
import { type AddressDomain, type AppAddressInput, appAddress } from "./app-address";

const custom = (id: string, name: string, live = true): AddressDomain => ({
  id: `i1:domain:${id}`,
  kind: "domain",
  name,
  live,
});
const external = (id: string, name: string, live = true): AddressDomain => ({
  id: `i1:custom_hostname:${id}`,
  kind: "custom_hostname",
  name,
  live,
});

function input(over: Partial<AppAddressInput> = {}): AppAddressInput {
  return {
    workerName: "cut",
    workersDevEnabled: true,
    servedDomain: null,
    domains: [],
    subdomain: "acme",
    ...over,
  };
}

describe("appAddress", () => {
  it("is the workers.dev URL without a live domain", () => {
    expect(appAddress(input())).toBe("https://cut.acme.workers.dev");
    expect(appAddress(input({ domains: [custom("01B", "cut.example.com", false)] }))).toBe(
      "https://cut.acme.workers.dev",
    );
  });

  it("is null while workers.dev is off and no domain is live, or the subdomain is unknown", () => {
    expect(appAddress(input({ workersDevEnabled: false }))).toBeNull();
    expect(
      appAddress(
        input({ workersDevEnabled: false, domains: [external("01A", "go.customer.test", false)] }),
      ),
    ).toBeNull();
    expect(appAddress(input({ subdomain: null }))).toBeNull();
  });

  it("prefers the domain that answered when workers.dev was turned off", () => {
    const domains = [custom("01A", "a.example.com"), external("01B", "go.customer.test")];
    expect(
      appAddress(input({ workersDevEnabled: false, servedDomain: "go.customer.test", domains })),
    ).toBe("https://go.customer.test");
  });

  it("skips a served domain that is no longer attached", () => {
    expect(
      appAddress(
        input({ servedDomain: "gone.example.com", domains: [external("01B", "go.customer.test")] }),
      ),
    ).toBe("https://go.customer.test");
  });

  it("takes the first live custom domain before any external domain, even while workers.dev is on", () => {
    const domains = [
      external("01A", "go.customer.test"),
      custom("01D", "b.example.com"),
      custom("01B", "pending.example.com", false),
      custom("01C", "a.example.com"),
    ];
    expect(appAddress(input({ domains }))).toBe("https://a.example.com");
  });

  it("takes the first live external domain when no custom domain is live", () => {
    const domains = [
      custom("01A", "pending.example.com", false),
      external("01C", "second.customer.test"),
      external("01B", "first.customer.test"),
    ];
    expect(appAddress(input({ workersDevEnabled: false, domains }))).toBe(
      "https://first.customer.test",
    );
  });

  it("opens a live wildcard domain at its base, after custom domains and before external ones", () => {
    const wildcard: AddressDomain = {
      id: "i1:wildcard_domain:01C",
      kind: "wildcard_domain",
      name: "tunnels.example.com",
      live: true,
    };
    expect(
      appAddress(
        input({
          workersDevEnabled: false,
          domains: [external("01A", "go.customer.test"), wildcard],
        }),
      ),
    ).toBe("https://tunnels.example.com");
    expect(
      appAddress(
        input({ workersDevEnabled: false, domains: [wildcard, custom("01D", "a.example.com")] }),
      ),
    ).toBe("https://a.example.com");
  });
});
