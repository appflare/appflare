import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { SETTING, writeSettings } from "../db/settings";
import {
  addressRedirectTarget,
  createAddressRedirect,
  isManagerWorkersDevHost,
  isServerPath,
  serveRequest,
} from "./address-redirect";

const DEV = "https://appflare.ada.workers.dev";
const HOST = "appflare.example.com";

const get = (url: string, method = "GET") => ({ method, url });

describe("addressRedirectTarget", () => {
  it("sends a page on the manager's workers.dev host to the same path and query there", () => {
    expect(addressRedirectTarget(get(`${DEV}/apps/abc?tab=health&x=1`), HOST, "appflare")).toBe(
      `https://${HOST}/apps/abc?tab=health&x=1`,
    );
    expect(addressRedirectTarget(get(`${DEV}/`), HOST, "appflare")).toBe(`https://${HOST}/`);
    expect(addressRedirectTarget(get(`${DEV}/login`, "HEAD"), HOST, "appflare")).toBe(
      `https://${HOST}/login`,
    );
    // Sign-in links (a password reset) carry on to the new address too.
    expect(
      addressRedirectTarget(
        get(`${DEV}/api/auth/reset-password/t0k?callbackURL=%2F`),
        HOST,
        "appflare",
      ),
    ).toBe(`https://${HOST}/api/auth/reset-password/t0k?callbackURL=%2F`);
  });

  it("leaves health checks, server functions, bundles and other methods alone", () => {
    expect(addressRedirectTarget(get(`${DEV}/api/health`), HOST, "appflare")).toBeNull();
    expect(addressRedirectTarget(get(`${DEV}/_serverFn/abc`), HOST, "appflare")).toBeNull();
    expect(addressRedirectTarget(get(`${DEV}/assets/main-1a2b.js`), HOST, "appflare")).toBeNull();
    expect(addressRedirectTarget(get(`${DEV}/apps`, "POST"), HOST, "appflare")).toBeNull();
    expect(
      addressRedirectTarget(get(`${DEV}/api/auth/sign-in/email`, "POST"), HOST, "appflare"),
    ).toBeNull();
  });

  it("leaves version previews, other Workers and other hosts alone", () => {
    const preview = "https://1a2b3c4d-appflare.ada.workers.dev/";
    expect(addressRedirectTarget(get(preview), HOST, "appflare")).toBeNull();
    expect(
      addressRedirectTarget(get("https://beta-appflare.ada.workers.dev/"), HOST, "appflare"),
    ).toBeNull();
    expect(
      addressRedirectTarget(get("https://wiki.ada.workers.dev/"), HOST, "appflare"),
    ).toBeNull();
    expect(addressRedirectTarget(get(`https://${HOST}/apps`), HOST, "appflare")).toBeNull();
    expect(addressRedirectTarget(get("http://localhost:5173/"), HOST, "appflare")).toBeNull();
  });

  it("does nothing while Appflare has no address, or does not know its Worker", () => {
    expect(addressRedirectTarget(get(`${DEV}/`), null, "appflare")).toBeNull();
    expect(addressRedirectTarget(get(`${DEV}/`), HOST, null)).toBeNull();
  });
});

describe("isManagerWorkersDevHost", () => {
  it("matches the Worker's own workers.dev host only", () => {
    expect(isManagerWorkersDevHost("appflare.ada.workers.dev", "appflare")).toBe(true);
    expect(isManagerWorkersDevHost("APPFLARE.ada.workers.dev", "appflare")).toBe(true);
    expect(isManagerWorkersDevHost("0badcafe-appflare.ada.workers.dev", "appflare")).toBe(false);
    expect(isManagerWorkersDevHost("appflare.example.com", "appflare")).toBe(false);
  });
});

describe("serveRequest", () => {
  /**
   * The assets binding with `not_found_handling: "single-page-application"`
   * (the manager's config): a path that matches no file answers the shell
   * with 200, whatever it looks like; without a shell, a 404.
   */
  const assetsOf = (files: Record<string, string>) =>
    ({
      fetch: async (input: RequestInfo | URL) => {
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        const body = files[path] ?? files["/index.html"];
        return body === undefined ? new Response("", { status: 404 }) : new Response(body);
      },
    }) as Pick<Fetcher, "fetch">;
  const built = assetsOf({ "/index.html": "shell", "/favicon.svg": "icon" });
  const app = async (request: Request) => new Response(`app ${request.method}`);
  const serve = async (path: string, method = "GET", assets = built) =>
    (await serveRequest(new Request(`${DEV}${path}`, { method }), assets, app)).text();

  it("answers pages, public files and missing files from the assets", async () => {
    expect(await serve("/apps/abc")).toBe("shell");
    expect(await serve("/favicon.svg")).toBe("icon");
    expect(await serve("/missing.json")).toBe("shell");
  });

  it("hands server paths and other methods to the app", async () => {
    expect(await serve("/api/health")).toBe("app GET");
    expect(await serve("/_serverFn/abc", "POST")).toBe("app POST");
    expect(await serve("/login", "POST")).toBe("app POST");
  });

  it("hands a page to the app while there is no shell yet (the build renders it)", async () => {
    expect(await serve("/", "GET", assetsOf({}))).toBe("app GET");
  });
});

describe("isServerPath", () => {
  it("is true for server routes and server functions only", () => {
    expect(isServerPath("/api/health")).toBe(true);
    expect(isServerPath("/_serverFn/abc")).toBe(true);
    expect(isServerPath("/apps/x")).toBe(false);
    expect(isServerPath("/favicon.svg")).toBe(false);
    expect(isServerPath("/api")).toBe(false);
  });
});

describe("createAddressRedirect", () => {
  beforeEach(async () => {
    await reset();
    await createMigrator(migrations).ensure(env.DB);
    await writeSettings(createDb(env.DB), { [SETTING.workerName]: "appflare" });
  });

  it("answers 302 from the stored address, reading it at most once per interval", async () => {
    let clock = 0;
    const redirect = createAddressRedirect({ ttlMs: 1000, now: () => clock });
    expect(await redirect.check(new Request(`${DEV}/apps`), env.DB)).toBeNull();

    await writeSettings(createDb(env.DB), { [SETTING.managerHostname]: HOST });
    // Still the cached answer until the interval passes, or the cache is dropped.
    expect(await redirect.check(new Request(`${DEV}/apps`), env.DB)).toBeNull();
    redirect.invalidate();
    const response = await redirect.check(new Request(`${DEV}/apps?q=1`), env.DB);
    expect(response?.status).toBe(302);
    expect(response?.headers.get("location")).toBe(`https://${HOST}/apps?q=1`);
    expect(response?.headers.get("cache-control")).toBe("no-store");

    await env.DB.prepare("DELETE FROM settings WHERE key = ?1").bind(SETTING.managerHostname).run();
    clock += 1001;
    expect(await redirect.check(new Request(`${DEV}/apps`), env.DB)).toBeNull();
  });

  it("serves the request here when the address cannot be read", async () => {
    const redirect = createAddressRedirect();
    const broken = {
      prepare: () => {
        throw new Error("D1 is unavailable");
      },
    } as unknown as D1Database;
    expect(await redirect.check(new Request(`${DEV}/apps`), broken)).toBeNull();
  });
});
