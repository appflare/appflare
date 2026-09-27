import { describe, expect, it } from "vitest";
import { dashboardUrl, zeroTrustDashboardUrl, zoneDashboardUrl } from "./dashboard-links";

const ACCOUNT = "0123456789abcdef0123456789abcdef";

describe("dashboard links", () => {
  it("open the given account directly", () => {
    expect(dashboardUrl(ACCOUNT, "workers/plans")).toBe(
      `https://dash.cloudflare.com/?to=/${ACCOUNT}/workers/plans`,
    );
    expect(dashboardUrl(ACCOUNT, "/r2/overview")).toBe(
      `https://dash.cloudflare.com/?to=/${ACCOUNT}/r2/overview`,
    );
  });

  it("let the dashboard ask for the account when the id is not known", () => {
    for (const unknown of [null, undefined, ""]) {
      expect(dashboardUrl(unknown, "workers-and-pages")).toBe(
        "https://dash.cloudflare.com/?to=/:account/workers-and-pages",
      );
    }
  });

  it("encode the account id and the zone name", () => {
    expect(dashboardUrl("a/b?c", "workers/plans")).toBe(
      "https://dash.cloudflare.com/?to=/a%2Fb%3Fc/workers/plans",
    );
    expect(zoneDashboardUrl(ACCOUNT, "gateway.example", "ssl-tls/custom-hostnames")).toBe(
      `https://dash.cloudflare.com/?to=/${ACCOUNT}/gateway.example/ssl-tls/custom-hostnames`,
    );
  });

  it("link the Zero Trust dashboard the same way", () => {
    expect(zeroTrustDashboardUrl(ACCOUNT, "home")).toBe(
      `https://one.dash.cloudflare.com/?to=/${ACCOUNT}/home`,
    );
    expect(zeroTrustDashboardUrl(null, "home")).toBe(
      "https://one.dash.cloudflare.com/?to=/:account/home",
    );
  });
});
