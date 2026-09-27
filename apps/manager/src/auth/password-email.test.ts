import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { readSettings, SETTING } from "../db/settings";
import { emailSendErrorMessage, resetEmail, resetPasswordUrl } from "./password-email";
import {
  changeAuthEmailBinding,
  EMAIL_OFF_MESSAGE,
  EMAIL_ON_MESSAGE,
  PASSWORD_EMAIL_MESSAGES,
  PasswordEmailError,
} from "./password-email.server";
import { parseStoredRecovery } from "./recovery.server";
import { createAuth } from "./server";

const BASE = "https://appflare.appflare-dev.workers.dev";
const SECRET = "test-only-better-auth-secret-0000000000000";

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("reset emails", () => {
  it("link to the manager's own reset page and escape what they show", () => {
    const url = resetPasswordUrl(BASE, "tok/en+1");
    expect(url).toBe(`${BASE}/reset-password?token=tok%2Fen%2B1`);
    const email = resetEmail({ from: "a@example.com", to: "<b>@example.com", url });
    expect(email.subject).toBe("Reset your Appflare password");
    expect(email.text).toContain(url);
    expect(email.html).toContain("&lt;b&gt;@example.com");
    expect(email.html).not.toContain("<b>@");
  });

  it("explain Email Sending's refusals in plain words", () => {
    expect(emailSendErrorMessage({ code: "E_SENDER_NOT_VERIFIED" })).toContain(
      "not set up for Email Sending",
    );
    expect(emailSendErrorMessage(new Error("boom"))).toContain("did not send");
  });
});

describe("Better Auth with reset emails", () => {
  function auth(send: (args: { to: string; url: string }) => Promise<void>) {
    return createAuth({
      db: createDb(env.DB),
      secret: SECRET,
      baseURL: BASE,
      recovery: {
        d1: env.DB,
        accountSecret: () => undefined,
        onAccountCodeUsed: () => {},
        background: () => {},
        sendResetEmail: send,
      },
    });
  }

  function requestReset(a: ReturnType<typeof auth>, email: string) {
    return a.handler(
      new Request(`${BASE}/api/auth/request-password-reset`, {
        method: "POST",
        headers: { origin: BASE, "content-type": "application/json" },
        body: JSON.stringify({ email, redirectTo: "/reset-password" }),
      }),
    );
  }

  it("answers alike for any address, mails only a real user, and the link resets once", async () => {
    const sent: { to: string; url: string }[] = [];
    const a = auth(async (args) => {
      sent.push(args);
    });
    await a.api.createUser({
      body: { email: "ada@example.com", name: "Ada", password: "old password 1", role: "member" },
    });
    const known = await requestReset(a, "ada@example.com");
    const unknown = await requestReset(a, "nobody@example.com");
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(await known.json()).toEqual(await unknown.json());
    expect(sent.map((s) => s.to)).toEqual(["ada@example.com"]);

    const token = new URL(sent[0]?.url ?? "").searchParams.get("token") ?? "";
    // Stored only as a hash.
    const tokenRows = await env.DB.prepare("SELECT identifier FROM verification").all<{
      identifier: string;
    }>();
    expect(tokenRows.results).toHaveLength(1);
    expect(tokenRows.results[0]?.identifier).not.toContain(token);
    expect(new URL(sent[0]?.url ?? "").pathname).toBe("/reset-password");
    await a.api.resetPassword({ body: { token, newPassword: "new password 1" } });
    const stored = await readSettings(createDb(env.DB), [SETTING.lastPasswordRecovery]);
    expect(parseStoredRecovery(stored.last_password_recovery)?.method).toBe("email_link");
    await expect(
      a.api.resetPassword({ body: { token, newPassword: "new password 2" } }),
    ).rejects.toThrow();
    await expect(
      a.api.signInEmail({ body: { email: "ada@example.com", password: "new password 1" } }),
    ).resolves.toBeDefined();
  });
});

describe("changeAuthEmailBinding", () => {
  function fakeApi(options: {
    deployments?: { versions: { version_id: string; percentage: number }[] }[];
    versions?: { id: string; number: number; annotations?: Record<string, string> }[];
  }) {
    const patches: unknown[] = [];
    const deployed: unknown[] = [];
    const api = {
      versions: {
        listDeployments: vi.fn(
          async () =>
            options.deployments ?? [{ versions: [{ version_id: "v1", percentage: 100 }] }],
        ),
        listVersions: vi.fn(async () => options.versions ?? [{ id: "v1", number: 1 }]),
        patchLatestVersion: vi.fn(async (_name: string, patch: unknown) => {
          patches.push(patch);
          return { id: "v2" };
        }),
        createDeployment: vi.fn(async (_name: string, args: unknown) => {
          deployed.push(args);
          return {};
        }),
      },
    };
    // Only the four methods above are used.
    return {
      api: api as unknown as Parameters<typeof changeAuthEmailBinding>[0]["api"],
      patches,
      deployed,
    };
  }

  it("adds a binding that may send only from the sender, then deploys it", async () => {
    const fake = fakeApi({});
    await expect(
      changeAuthEmailBinding({ api: fake.api, workerName: "appflare" }, "reset@example.com"),
    ).resolves.toBe("v2");
    expect(fake.patches).toEqual([
      {
        env: {
          AUTH_EMAIL: { type: "send_email", allowed_sender_addresses: ["reset@example.com"] },
        },
        annotations: { "workers/message": EMAIL_ON_MESSAGE, "workers/tag": "v1" },
      },
    ]);
    expect(fake.deployed).toEqual([
      {
        versions: [{ version_id: "v2", percentage: 100 }],
        annotations: { "workers/message": EMAIL_ON_MESSAGE },
      },
    ]);
  });

  it("removes the binding when turned off", async () => {
    const fake = fakeApi({});
    await changeAuthEmailBinding({ api: fake.api, workerName: "appflare" }, null);
    expect(fake.patches).toEqual([
      {
        env: { AUTH_EMAIL: null },
        annotations: { "workers/message": EMAIL_OFF_MESSAGE, "workers/tag": "v1" },
      },
    ]);
  });

  it("refuses during a gradual deployment, and over an unreleased version", async () => {
    const gradual = fakeApi({
      deployments: [
        {
          versions: [
            { version_id: "v1", percentage: 50 },
            { version_id: "v0", percentage: 50 },
          ],
        },
      ],
    });
    await expect(
      changeAuthEmailBinding({ api: gradual.api, workerName: "appflare" }, "a@example.com"),
    ).rejects.toThrow(PASSWORD_EMAIL_MESSAGES.gradual);
    const unreleased = fakeApi({
      versions: [
        { id: "v1", number: 1 },
        { id: "v9", number: 9 },
      ],
    });
    await expect(
      changeAuthEmailBinding({ api: unreleased.api, workerName: "appflare" }, "a@example.com"),
    ).rejects.toBeInstanceOf(PasswordEmailError);
    expect(unreleased.patches).toEqual([]);
  });

  it("retries over its own earlier attempt that never served", async () => {
    const fake = fakeApi({
      versions: [
        { id: "v1", number: 1 },
        {
          id: "v2",
          number: 2,
          annotations: { "workers/message": EMAIL_ON_MESSAGE, "workers/tag": "v1" },
        },
      ],
    });
    await changeAuthEmailBinding({ api: fake.api, workerName: "appflare" }, "a@example.com");
    expect(fake.patches).toHaveLength(1);
  });
});
