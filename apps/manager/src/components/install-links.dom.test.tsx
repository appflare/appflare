import { Toasty } from "@cloudflare/kumo";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Install links: `/install/github/<owner>/<repo>` and the dialog it opens on
 * the catalog page, and the plain page a link that opens nothing shows. The
 * router is given here (the routes only exist under the Start Vite plugin).
 * Nothing here may start a build or an install.
 */
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ options }),
  redirect: (opts: Record<string, unknown>) => ({ redirectTo: opts }),
  useRouter: () => ({ navigate: async () => {}, invalidate: async () => {} }),
}));
const builds = vi.hoisted(() => ({ startSourceBuild: vi.fn(async () => ({ jobId: "j1" })) }));
vi.mock("../installs/source-builds.functions", () => builds);

const { Route: RepositoryLink } = await import("../routes/_app/install/github/$owner/$repo");
const { CatalogAddMenu } = await import("./catalog-add-menu");
const { InstallLinkProblem } = await import("./install-link-problem");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  builds.startSourceBuild.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

type BeforeLoad = (args: {
  params: { owner: string; repo: string };
  context: { viewer: { role: "admin" | "member" } };
}) => unknown;
const beforeLoad = RepositoryLink.options.beforeLoad as BeforeLoad;

function land(owner: string, repo: string, role: "admin" | "member" = "admin"): unknown {
  try {
    beforeLoad({ params: { owner, repo }, context: { viewer: { role } } });
  } catch (thrown) {
    return thrown;
  }
  return null;
}

describe("/install/github/<owner>/<repo>", () => {
  it("opens the catalog page with the repository for an admin, replacing the link", () => {
    expect(land("cloudflare", "agents-starter")).toEqual({
      redirectTo: {
        to: "/catalog",
        search: { repository: "cloudflare/agents-starter" },
        replace: true,
      },
    });
    expect(land("cloudflare", "agents-starter.git")).toEqual({
      redirectTo: {
        to: "/catalog",
        search: { repository: "cloudflare/agents-starter" },
        replace: true,
      },
    });
  });

  it("opens the plain catalog page for a member", () => {
    expect(land("cloudflare", "agents-starter", "member")).toEqual({
      redirectTo: { to: "/catalog", search: {}, replace: true },
    });
  });

  it("stays on the plain page for anything that is not a GitHub repository", () => {
    for (const [owner, repo] of [
      ["-x", "repo"],
      ["owner", ".."],
      ["owner", "re/po"],
      ["https:", "evil.example"],
      ["owner", "repo?x=1"],
    ] as const) {
      expect(land(owner, repo), `${owner}/${repo}`).toBeNull();
    }
  });
});

describe("the add menu's repository dialog, opened by an install link", () => {
  it("opens with the repository filled in and builds nothing until the admin confirms", async () => {
    act(() =>
      root.render(
        <Toasty>
          <CatalogAddMenu
            repositoryBuilds
            sandbox={{ state: "on", missing: null, confirmed: true }}
            prefill="cloudflare/agents-starter"
          />
        </Toasty>,
      ),
    );
    await act(async () => {});
    const field = [...document.querySelectorAll("input")].find(
      (i) => i.value === "cloudflare/agents-starter",
    );
    expect(field).toBeDefined();
    const build = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Build for review",
    );
    expect(build?.disabled).toBe(true);
    await act(async () => build?.click());
    expect(builds.startSourceBuild).not.toHaveBeenCalled();
  });

  it("stays closed and empty without one", async () => {
    act(() =>
      root.render(
        <Toasty>
          <CatalogAddMenu
            repositoryBuilds
            sandbox={{ state: "on", missing: null, confirmed: true }}
          />
        </Toasty>,
      ),
    );
    await act(async () => {});
    expect(document.body.textContent).not.toContain("Install from a repository");
    expect(builds.startSourceBuild).not.toHaveBeenCalled();
  });
});

describe("the plain page of an install link that opens nothing", () => {
  const hrefs = () => [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));

  it("says the app is not in the catalogs, with the way to the catalog and, for admins, its settings", () => {
    act(() => root.render(<InstallLinkProblem kind="app" isAdmin />));
    expect(container.textContent).toContain("This app is not in your catalogs");
    expect(hrefs()).toContain("/catalog");
    expect(hrefs()).toContain("/settings/catalogs#catalogs");
  });

  it("offers members the catalog only, since they cannot change the catalogs", () => {
    for (const kind of ["app", "official-off"] as const) {
      act(() => root.render(<InstallLinkProblem kind={kind} />));
      expect(hrefs(), kind).toContain("/catalog");
      expect(hrefs(), kind).not.toContain("/settings/catalogs#catalogs");
      const labels = [...container.querySelectorAll("a")].map((a) => a.textContent);
      expect(labels, kind).not.toContain("Catalog settings");
    }
  });

  it("names the official catalog when it is turned off", () => {
    act(() => root.render(<InstallLinkProblem kind="official-off" />));
    expect(container.textContent).toContain("The official catalog is turned off");
  });
});
