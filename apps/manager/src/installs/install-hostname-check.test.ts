import { describe, expect, it } from "vitest";
import {
  hostnameAllowsInstall,
  hostnameConsequence,
  hostnameLeftOut,
  hostnameStatus,
  type InstallHostnameCheck,
  LEFT_OUT_TITLE,
} from "./install-hostname-check";

const records: InstallHostnameCheck = {
  state: "records",
  records: [{ type: "CNAME", content: "elsewhere.example.net" }],
};

describe("the install form's check of a custom domain", () => {
  it("warns about a name with DNS records, and lets the install start without it", () => {
    expect(hostnameStatus(records)).toEqual({
      tone: "warning",
      text: "This name already has a DNS record (CNAME).",
    });
    expect(
      hostnameStatus({
        state: "records",
        records: [
          { type: "A", content: "192.0.2.1" },
          { type: "A", content: "192.0.2.2" },
          { type: "AAAA", content: "2001:db8::1" },
        ],
      })?.text,
    ).toBe("This name already has DNS records (A and AAAA).");
    expect(hostnameAllowsInstall(records)).toBe(true);
    expect(hostnameLeftOut(records)).toBe(true);
  });

  it("says what Cloudflare and the install do, and the choices, under a short title", () => {
    const said = hostnameConsequence(records);
    expect(said?.title).toBe(LEFT_OUT_TITLE);
    expect(said?.description).toContain(
      "It already has DNS records, which Cloudflare does not replace unless asked, so the app answers on its workers.dev address only.",
    );
    expect(said?.description).toContain("Choose another name;");
    expect(said?.description).toContain("delete the records in Cloudflare, then install;");
    expect(said?.description).toContain(
      "or install anyway and add the domain from the app's page later",
    );
    expect(hostnameConsequence({ state: "other-worker", worker: "blog" })?.description).toContain(
      "remove the domain from blog in Cloudflare, then install",
    );
  });

  it("warns when the token cannot add domains, naming the permission", () => {
    const check: InstallHostnameCheck = {
      state: "cannot-attach",
      missing: ["Workers Routes: Edit"],
    };
    expect(hostnameStatus(check)).toEqual({
      tone: "warning",
      text: "The Cloudflare token cannot add domains to apps yet.",
    });
    expect(hostnameConsequence(check)?.description).toContain(
      "Cloudflare needs Workers Routes: Edit on this domain",
    );
    expect(hostnameLeftOut(check)).toBe(true);
    expect(hostnameAllowsInstall(check)).toBe(true);
  });

  it("says to reconnect, not to edit a token, for a Cloudflare sign-in", () => {
    const check: InstallHostnameCheck = {
      state: "cannot-attach",
      missing: ["Workers Routes: Edit"],
      connection: "oauth",
    };
    expect(hostnameStatus(check)?.text).toBe(
      "Appflare's Cloudflare sign-in cannot add domains to apps yet.",
    );
    const description = hostnameConsequence(check)?.description ?? "";
    expect(description).toContain("Reconnect Cloudflare in");
    expect(description).not.toMatch(/\btoken\b/i);
    expect(hostnameLeftOut(check)).toBe(true);
  });

  it("holds Install only for a name another app here uses", () => {
    expect(hostnameAllowsInstall({ state: "other-app" })).toBe(false);
    expect(hostnameStatus({ state: "other-app" })?.tone).toBe("danger");
    expect(hostnameConsequence({ state: "other-app" })).toBeNull();
    for (const check of [
      null,
      { state: "checking" },
      { state: "free" },
      { state: "unknown" },
      { state: "other-worker", worker: "blog" },
    ] as const) {
      expect(hostnameAllowsInstall(check)).toBe(true);
    }
  });

  it("is quiet about a free name, a pending check, or one it could not make", () => {
    expect(hostnameStatus({ state: "free" })).toEqual({ tone: "success", text: "Available" });
    expect(hostnameStatus({ state: "checking" })?.tone).toBe("pending");
    expect(hostnameStatus({ state: "unknown" })?.tone).toBe("neutral");
    expect(hostnameStatus(null)).toBeNull();
    for (const check of [{ state: "free" }, { state: "checking" }, { state: "unknown" }] as const) {
      expect(hostnameLeftOut(check)).toBe(false);
      expect(hostnameConsequence(check)).toBeNull();
    }
  });
});
