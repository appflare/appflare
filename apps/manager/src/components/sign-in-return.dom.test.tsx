import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The sign-in pages with a page to return to (`?returnTo=`). The routes run
 * under the router and load through server functions, which only exist under
 * the Start Vite plugin; the search, the route context and the router's
 * `navigate` are given here instead, and the search goes through each route's
 * own `validateSearch`, as the router would pass it.
 */
const page = vi.hoisted(() => ({
  search: {} as Record<string, unknown>,
  context: { version: "1.0.0", emailReset: true } as Record<string, unknown>,
  navigate: vi.fn(async (_opts: unknown) => {}),
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useRouteContext: () => page.context,
    useSearch: () => page.search,
  }),
  redirect: (opts: Record<string, unknown>) => ({ redirectTo: opts }),
  useRouter: () => ({ navigate: page.navigate, invalidate: async () => {} }),
}));

const auth = vi.hoisted(() => ({
  signInEmail: vi.fn(async (_body: unknown) => ({ error: null as unknown })),
  signInPasskey: vi.fn(async () => ({ error: null as unknown })),
  requestPasswordReset: vi.fn(async (_body: unknown) => ({ error: null as unknown })),
  $fetch: vi.fn(async (_path: string, _opts: unknown) => ({ error: null as unknown })),
}));
vi.mock("../auth/client", () => ({
  authClient: {
    signIn: { email: auth.signInEmail, passkey: auth.signInPasskey },
    requestPasswordReset: auth.requestPasswordReset,
    resetPassword: vi.fn(async () => ({ error: null })),
    $fetch: auth.$fetch,
  },
}));
const setup = vi.hoisted(() => ({ needsSetup: false }));
vi.mock("../server/setup.functions", () => ({
  getSetupStatus: async () => ({ needsSetup: setup.needsSetup }),
}));
vi.mock("../server/version.functions", () => ({ loadAppflareVersion: async () => "1.0.0" }));
vi.mock("../server/recovery.functions", () => ({
  getPasswordRecoveryOptions: async () => ({ emailReset: true }),
}));

const { Route: Login } = await import("../routes/login");
const { Route: ForgotPassword } = await import("../routes/forgot-password");
const { Route: ResetPassword } = await import("../routes/reset-password");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface RouteLike {
  options: {
    component?: unknown;
    validateSearch?: unknown;
    beforeLoad?: unknown;
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  page.navigate.mockClear();
  auth.signInEmail.mockClear();
  auth.signInPasskey.mockClear();
  auth.requestPasswordReset.mockClear();
  auth.$fetch.mockClear();
  setup.needsSetup = false;
  (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = () => {};
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

/** Renders `route` as the router would at `?<raw search>`. */
function open(route: RouteLike, raw: Record<string, unknown>) {
  const schema = route.options.validateSearch as { parse: (v: unknown) => Record<string, unknown> };
  page.search = schema.parse(raw);
  const Page = route.options.component as ComponentType;
  act(() => root.render(<Page />));
}

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((b) => b.textContent === name);
  if (found === undefined) throw new Error(`no "${name}" button`);
  return found;
}

function link(name: string): HTMLAnchorElement {
  const found = [...document.querySelectorAll("a")].find((a) => a.textContent === name);
  if (found === undefined) throw new Error(`no "${name}" link`);
  return found;
}

async function submit(form: HTMLFormElement | null) {
  if (form === null) throw new Error("no form");
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("the sign-in page with a page to return to", () => {
  it("opens that page, section included, after signing in with a password", async () => {
    open(Login, { returnTo: "/apps/01J9ZQ7K3M#secrets" });
    await submit(document.querySelector("form"));
    expect(auth.signInEmail).toHaveBeenCalledOnce();
    expect(page.navigate).toHaveBeenCalledWith({
      href: "/apps/01J9ZQ7K3M#secrets",
      replace: true,
    });
  });

  it("opens it after signing in with a passkey", async () => {
    open(Login, { returnTo: "/install/cut" });
    await act(async () => button("Sign in with a passkey").click());
    expect(auth.signInPasskey).toHaveBeenCalledOnce();
    expect(page.navigate).toHaveBeenCalledWith({ href: "/install/cut", replace: true });
  });

  it("goes home instead of anywhere that is not one of the manager's pages", async () => {
    for (const hostile of [
      "//evil.example",
      "/\\evil.example",
      "javascript:alert(1)",
      "https://evil.example/catalog",
    ]) {
      page.navigate.mockClear();
      open(Login, { returnTo: hostile });
      await submit(document.querySelector("form"));
      expect(page.navigate, hostile).toHaveBeenCalledWith({ href: "/", replace: true });
      expect(link("Forgot your password?").getAttribute("href"), hostile).toBe("/forgot-password");
    }
  });

  it("looks the same, and carries the page to the password recovery pages", () => {
    open(Login, {});
    const plain = container.textContent;
    open(Login, { returnTo: "/catalog/cut" });
    expect(container.textContent).toBe(plain);
    expect(link("Forgot your password?").getAttribute("href")).toBe(
      "/forgot-password?returnTo=%2Fcatalog%2Fcut",
    );
  });

  it("sends it on to setup while there is no owner yet", async () => {
    setup.needsSetup = true;
    const beforeLoad = Login.options.beforeLoad as (args: unknown) => Promise<unknown>;
    await expect(beforeLoad({ search: { returnTo: "/install/cut" } })).rejects.toEqual({
      redirectTo: { href: "/setup?returnTo=%2Finstall%2Fcut" },
    });
  });
});

describe("password recovery with a page to return to", () => {
  it("asks for a reset link that comes back to it", async () => {
    page.context = { version: "1.0.0", emailReset: true };
    open(ForgotPassword, { returnTo: "/install/cut" });
    await submit(document.querySelector("form"));
    expect(auth.requestPasswordReset).toHaveBeenCalledWith({
      email: "",
      redirectTo: "/reset-password?returnTo=%2Finstall%2Fcut",
    });
    expect(link("Back to sign in").getAttribute("href")).toBe("/login?returnTo=%2Finstall%2Fcut");
  });

  it("signs in towards it after a recovery code", async () => {
    page.context = { version: "1.0.0", emailReset: false };
    open(ForgotPassword, { returnTo: "/apps/01J9#secrets" });
    await submit(document.querySelector("form"));
    expect(auth.$fetch).toHaveBeenCalledOnce();
    expect(link("Sign in").getAttribute("href")).toBe("/login?returnTo=%2Fapps%2F01J9%23secrets");
  });

  it("keeps it on the page the emailed link opens", () => {
    open(ResetPassword, { token: "tok", returnTo: "/catalog/cut" });
    expect(link("Back to sign in").getAttribute("href")).toBe("/login?returnTo=%2Fcatalog%2Fcut");
    open(ResetPassword, { returnTo: "/catalog/cut" });
    expect(link("Ask for a new link").getAttribute("href")).toBe(
      "/forgot-password?returnTo=%2Fcatalog%2Fcut",
    );
    open(ResetPassword, { token: "tok", returnTo: "//evil.example" });
    expect(link("Back to sign in").getAttribute("href")).toBe("/login");
  });
});
