import { describe, expect, it } from "vitest";
import { redactReportText } from "./redact";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const CF_TOKEN = "Xy7kQ2mN9pL4rT6vB8wC1zD3fG5hJ0aSeUiO";

describe("redactReportText", () => {
  it("removes a planted token and an email address", () => {
    const line = `deploy failed for ada@example.com with token ${CF_TOKEN} (retrying)`;
    const out = redactReportText(line);
    expect(out).not.toContain("ada@example.com");
    expect(out).not.toContain(CF_TOKEN);
    expect(out).toBe("deploy failed for [email] with token [redacted] (retrying)");
  });

  it("takes the account id out of Cloudflare API paths and dashboard links", () => {
    expect(
      redactReportText(
        `Cloudflare API request failed: PUT /accounts/${ACCOUNT}/workers/scripts/cut -> 400: [10021] bad`,
      ),
    ).toBe(
      "Cloudflare API request failed: PUT /accounts/[account id]/workers/scripts/cut -> 400: [10021] bad",
    );
    expect(redactReportText(`https://dash.cloudflare.com/${ACCOUNT}/workers/plans`)).toBe(
      "https://dash.cloudflare.com/[account id]/workers/plans",
    );
    expect(redactReportText(`https://dash.cloudflare.com/?to=/${ACCOUNT}/workers/plans`)).toBe(
      "https://dash.cloudflare.com/?to=/[account id]/workers/plans",
    );
    expect(redactReportText(`zone ${ACCOUNT.toUpperCase()}`)).toBe("zone [id]");
  });

  it("removes values named as secrets, keeping the names", () => {
    expect(redactReportText("with SESSION_SECRET=hunter2hunter2 next")).toBe(
      "with SESSION_SECRET=[redacted] next",
    );
    expect(redactReportText('{"apiToken":"abc","name":"cut"}')).toBe(
      '{"apiToken":"[redacted]","name":"cut"}',
    );
    expect(redactReportText("password = 'p@ss w0rd'")).toBe("password = '[redacted]'");
  });

  it("removes well-known token shapes and credentials in addresses", () => {
    const pat = `ghp_${"a1B2".repeat(9)}`;
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N";
    const out = redactReportText(
      `clone https://x-access-token:${pat}@github.com/o/r ${jwt} Authorization: Bearer abcdefgh12345678 https://hooks.slack.com/services/T0/B0/xyz`,
    );
    for (const secret of [pat, jwt, "abcdefgh12345678", "T0/B0/xyz"]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("github.com/o/r");
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQ\n-----END PRIVATE KEY-----";
    expect(redactReportText(`key: ${pem} end`)).toBe("key: [redacted] end");
  });

  it("removes the value of any name ending in key, but not words that merely contain it", () => {
    expect(redactReportText("set STRIPE_KEY=sk_test_abc key=abc api-key=abc")).toBe(
      "set STRIPE_KEY=[redacted] key=[redacted] api-key=[redacted]",
    );
    expect(redactReportText('{"key":"abc","webhookKey":1}')).toBe(
      '{"key":"[redacted]","webhookKey":1}',
    );
    expect(redactReportText("monkey=banana keyboard=qwerty")).toBe("monkey=banana keyboard=qwerty");
  });

  it("removes every value of an environment line, whatever its name", () => {
    const dump = [
      "Build environment:",
      "NODE_ENV=production",
      "  export DATABASE_URL=postgres://u:p@db.internal:5432/app",
      "export STRIPE_WEBHOOK=whsec_live_abc",
      "npm run build",
    ].join("\n");
    expect(redactReportText(dump)).toBe(
      [
        "Build environment:",
        "NODE_ENV=[redacted]",
        "  export DATABASE_URL=[redacted]",
        "export STRIPE_WEBHOOK=[redacted]",
        "npm run build",
      ].join("\n"),
    );
    // Lower-case names are not environment lines.
    expect(redactReportText("mode=fast")).toBe("mode=fast");
  });

  it("removes long tokens in one case, from 32 characters, when they mix letters and digits", () => {
    const lower = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8"; // 36, one case
    const upper = "A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6"; // 32, one case
    expect(redactReportText(`token ${lower} and ${upper}`)).toBe("token [redacted] and [redacted]");
    // Shorter single-case values and long words without digits stay.
    expect(redactReportText("a1b2c3d4e5f6g7h8i9j0k1l2m3")).toBe("a1b2c3d4e5f6g7h8i9j0k1l2m3");
    expect(redactReportText("this-is-a-long-hyphenated-worker-name")).toBe(
      "this-is-a-long-hyphenated-worker-name",
    );
  });

  it("replaces UUIDs with [id]", () => {
    expect(
      redactReportText(
        "D1 database 3f2a9c1e-5b7d-4e8f-a1c2-9d0e1f2a3b4c and version A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D",
      ),
    ).toBe("D1 database [id] and version [id]");
  });

  it("removes secrets passed as command-line flags", () => {
    expect(
      redactReportText("wrangler x --password hunter2 --api-key=abc123 --token 'a b' --verbose"),
    ).toBe("wrangler x --password [redacted] --api-key=[redacted] --token '[redacted]' --verbose");
  });

  it("replaces this account's subdomain, hostnames and Worker names", () => {
    const names = {
      subdomain: "ada-co",
      hostnames: ["links.ada.example", "*.shop.ada.example", "blog.ada.example/*"],
      workers: ["cut", "cut-worker", "appflare-ada"],
    };
    expect(
      redactReportText(
        "GET https://cut-worker.ada-co.workers.dev, a.shop.ada.example, BLOG.ADA.EXAMPLE, links.ada.example.org; appflare-ada deployed cut; execute cutlery",
        names,
      ),
    ).toBe(
      "GET https://[worker].[domain].workers.dev, a.[domain], [domain], [domain].org; [worker] deployed [worker]; execute cutlery",
    );
    // Names too short to be told apart from words are left alone.
    expect(redactReportText("an ox", { subdomain: "ox", hostnames: [], workers: ["an"] })).toBe(
      "an ox",
    );
  });

  it("keeps what a report needs: steps, versions, names, statuses and ids that are not secret", () => {
    const text =
      "D1 DB: apply migrations: 0001_initial_schema.sql failed; worker open-seo-links version 1.4.2 -> 403: [10013]; job 01J9ZK3M7Q2W4E6R8T0Y2U4I6O";
    expect(redactReportText(text)).toBe(text);
    // "verify token" is a step name, not a secret with a value.
    expect(redactReportText("verify token: Cloudflare API request failed")).toBe(
      "verify token: Cloudflare API request failed",
    );
  });
});
