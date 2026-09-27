import { describe, expect, it } from "vitest";
import {
  checkExternalHostname,
  EXTERNAL_DOMAIN_COST,
  gatewayBindingName,
  gatewayHostname,
  saasCheckMessage,
  saasDashboardUrl,
} from "./gateway";

const zones = { gateway: "gateway.example", account: ["gateway.example", "own.example"] };

describe("checkExternalHostname", () => {
  it("normalizes a hostname outside the account", () => {
    expect(checkExternalHostname("  App.Customer.TEST. ", zones)).toEqual({
      ok: true,
      hostname: "app.customer.test",
      apex: false,
    });
  });

  it("marks an apex hostname, whose DNS host must flatten a CNAME", () => {
    expect(checkExternalHostname("customer.test", zones)).toEqual({
      ok: true,
      hostname: "customer.test",
      apex: true,
    });
  });

  it("puts an international name in Punycode", () => {
    const checked = checkExternalHostname("bücher.customer.test", zones);
    expect(checked).toEqual({ ok: true, hostname: "xn--bcher-kva.customer.test", apex: false });
  });

  it("refuses the gateway zone and names under it", () => {
    for (const name of ["gateway.example", "x.gateway.example"]) {
      const checked = checkExternalHostname(name, zones);
      expect(checked.ok).toBe(false);
      expect(!checked.ok && checked.error).toContain("gateway domain");
    }
  });

  it("sends a name under another zone of the account to the custom domain path", () => {
    const checked = checkExternalHostname("app.own.example", zones);
    expect(!checked.ok && checked.error).toContain("Add it as a custom domain instead");
  });

  it("refuses wildcards, URLs and names that are not hostnames", () => {
    expect(checkExternalHostname("*.customer.test", zones).ok).toBe(false);
    expect(checkExternalHostname("https://app.customer.test/x", zones).ok).toBe(false);
    expect(checkExternalHostname("localhost", zones).ok).toBe(false);
    expect(checkExternalHostname("-bad.customer.test", zones).ok).toBe(false);
    expect(checkExternalHostname("", zones)).toEqual({ ok: false, error: "Enter a hostname." });
  });
});

describe("gateway names", () => {
  it("names the CNAME target and one binding per install", () => {
    expect(gatewayHostname("gateway.example")).toBe("appflare-gateway.gateway.example");
    expect(gatewayBindingName("01k6abcdxyz")).toBe("APP_01K6ABCDXYZ");
    expect(gatewayBindingName("i-1")).toBe("APP_I_1");
  });

  it("links the dashboard page that turns Cloudflare for SaaS on", () => {
    expect(saasDashboardUrl("acc1", "gateway.example")).toBe(
      "https://dash.cloudflare.com/?to=/acc1/gateway.example/ssl-tls/custom-hostnames",
    );
  });

  it("explains each refusal and states the cost", () => {
    expect(saasCheckMessage({ kind: "ready", used: 0, allocated: 100 }, "g.example")).toBeNull();
    expect(saasCheckMessage({ kind: "saas-off", dashboardUrl: "" }, "g.example")).toContain(
      "Enable Cloudflare for SaaS",
    );
    expect(
      saasCheckMessage(
        { kind: "missing-permission", permission: "SSL and Certificates: Edit" },
        "g.example",
      ),
    ).toContain("SSL and Certificates: Edit");
    expect(EXTERNAL_DOMAIN_COST).toContain("100 external domains");
    expect(EXTERNAL_DOMAIN_COST).toContain("$0.10 a month");
  });
});
