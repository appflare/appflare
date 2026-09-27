import { describe, expect, it } from "vitest";
import { z } from "zod";
import { catalogManifestSchema } from "./catalog";
import {
  catalogInstallDirsSchema,
  DEFAULT_INSTALL_DIRS,
  installDirList,
  installDirPackageManager,
  installDirProblem,
  lockfilePackageManager,
  lockfilesOf,
  MAX_INSTALL_DIRS,
} from "./install-dirs";
import { buildCatalogManifestSchema } from "./sandbox";

const manifest = {
  slug: "blog",
  name: "Blog",
  summary: "A blog.",
  homepage: "https://github.com/example/templates",
  repo: "example/templates",
  license: "MIT",
  categories: [],
  maintainers: [],
  source: { ref: "main", sha: "0".repeat(40) },
  install: {
    tier: "artifact",
    packageManager: "pnpm",
    wranglerConfig: "templates/blog/wrangler.jsonc",
    workerName: "blog",
  },
  plan: "free",
  requires: [],
  secrets: [],
  vars: [],
  postInstall: [],
  tokenPermissions: [],
};

function withInstall(install: Record<string, unknown>) {
  return catalogManifestSchema.safeParse({
    ...manifest,
    install: { ...manifest.install, ...install },
  });
}

describe("install.installDirs", () => {
  it("is optional, and the root is installed when it is omitted", () => {
    const parsed = withInstall({});
    expect(parsed.success).toBe(true);
    expect(parsed.data?.install.installDirs).toBeUndefined();
    expect(parsed.data && installDirList(parsed.data.install)).toEqual([{ path: "." }]);
    expect(DEFAULT_INSTALL_DIRS).toEqual([{ path: "." }]);
  });

  it("keeps several directories in their order, with their settings", () => {
    const installDirs = [
      { path: "templates/blog", lockfile: "none" },
      { path: "." },
      { path: "packages/api", packageManager: "npm", lockfile: "required" },
    ];
    const parsed = withInstall({ installDirs });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.data?.install.installDirs).toEqual(installDirs);
    expect(parsed.data && installDirList(parsed.data.install)).toEqual(installDirs);
  });

  it("is shared by every Worker of an entry of several Workers", () => {
    const parsed = withInstall({
      installDirs: [{ path: "api" }, { path: "web", lockfile: "none" }],
      workers: [
        { name: "api", wranglerConfig: "templates/blog/wrangler.jsonc", primary: true },
        { name: "web", wranglerConfig: "web/wrangler.jsonc" },
      ],
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("refuses a path that leaves the checkout or is absolute", () => {
    for (const [path, message] of [
      ["..", 'path ".." contains ..; an install directory must stay inside the checkout'],
      [
        "templates/../../etc",
        'path "templates/../../etc" contains ..; an install directory must stay inside the checkout',
      ],
      [
        "/srv/app",
        'path "/srv/app" is absolute; give a path relative to the root of the checkout, such as templates/blog',
      ],
      [
        "C:/app",
        'path "C:/app" is absolute; give a path relative to the root of the checkout, such as templates/blog',
      ],
      ["templates\\blog", 'path "templates\\blog" uses a backslash; separate directories with /'],
      ["", "path is empty; use . for the root of the checkout"],
      ["./blog", 'path "./blog" contains a . directory; write it without one'],
      ["blog/", 'path "blog/" has an empty directory name (a doubled or trailing /)'],
      [
        "blog site",
        'path "blog site" may contain only letters, digits, and . @ + _ - between the / separators',
      ],
    ] as const) {
      const parsed = withInstall({ installDirs: [{ path }] });
      expect(parsed.success, path).toBe(false);
      expect(parsed.error?.issues, path).toEqual([
        expect.objectContaining({ path: ["install", "installDirs", 0, "path"], message }),
      ]);
    }
  });

  it("refuses a directory listed twice, an empty list, and too many directories", () => {
    const twice = withInstall({ installDirs: [{ path: "." }, { path: "site" }, { path: "." }] });
    expect(twice.error?.issues).toEqual([
      expect.objectContaining({
        path: ["install", "installDirs", 2, "path"],
        message: 'path "." is listed twice; each directory is installed once',
      }),
    ]);
    expect(withInstall({ installDirs: [] }).success).toBe(false);
    const many = Array.from({ length: MAX_INSTALL_DIRS + 1 }, (_, i) => ({ path: `d${i}` }));
    expect(withInstall({ installDirs: many }).success).toBe(false);
    expect(catalogInstallDirsSchema.safeParse(many.slice(1)).success).toBe(true);
  });

  it("refuses an unknown package manager or lockfile rule", () => {
    expect(withInstall({ installDirs: [{ path: ".", packageManager: "deno" }] }).success).toBe(
      false,
    );
    expect(withInstall({ installDirs: [{ path: ".", lockfile: "optional" }] }).success).toBe(false);
  });

  it("is refused on self-deploying entries, whose installer runs without the packer", () => {
    const parsed = withInstall({
      tier: "self-deploying",
      installDirs: [{ path: "." }],
      selfDeploying: {
        tool: "alchemy",
        deployCommand: ["pnpm", "alchemy", "deploy", "--yes"],
        destroyCommand: ["pnpm", "alchemy", "destroy", "--yes"],
        stateStore: "cloudflare",
        workers: ["app-{{stage}}"],
      },
    });
    expect(parsed.error?.issues).toEqual([
      expect.objectContaining({
        path: ["install", "installDirs"],
        message:
          "install.installDirs is not allowed for the self-deploying tier: its installer runs at the root of the checkout, without the packer that installs these directories",
      }),
    ]);
    const schema = JSON.stringify(z.toJSONSchema(catalogManifestSchema));
    expect(schema).toContain('"not":{"required":["installDirs"]}');
  });

  it("reaches a sandbox build's catalog manifest with the same rules", () => {
    const install = { ...manifest.install, tier: "sandbox" };
    expect(
      buildCatalogManifestSchema.safeParse({
        ...manifest,
        install: { ...install, installDirs: [{ path: "templates/blog", lockfile: "none" }] },
      }).success,
    ).toBe(true);
    expect(
      buildCatalogManifestSchema.safeParse({
        ...manifest,
        install: { ...install, installDirs: [{ path: "../x" }] },
      }).success,
    ).toBe(false);
  });

  it("states the path rule in the JSON Schema for editors", () => {
    const pattern = new RegExp(
      (
        z.toJSONSchema(catalogInstallDirsSchema) as unknown as {
          items: { properties: { path: { pattern: string } } };
        }
      ).items.properties.path.pattern,
    );
    for (const ok of [".", "blog", "templates/blog", "a/.hidden", "@scope/pkg", "a..b"]) {
      expect(pattern.test(ok), ok).toBe(true);
      expect(installDirProblem(ok), ok).toBeNull();
    }
    for (const bad of ["..", "../x", "a/..", "a/./b", "/a", "a//b", "a/", ""]) {
      expect(pattern.test(bad), bad).toBe(false);
      expect(installDirProblem(bad), bad).not.toBeNull();
    }
  });
});

describe("package manager of an install directory", () => {
  it("names each lockfile's package manager, pnpm first", () => {
    expect(lockfilePackageManager(new Set(["package.json"]))).toBeNull();
    expect(lockfilePackageManager(new Set(["bun.lockb"]))).toBe("bun");
    expect(lockfilePackageManager(new Set(["package-lock.json", "pnpm-lock.yaml"]))).toBe("pnpm");
    expect(lockfilesOf("npm")).toEqual(["package-lock.json", "npm-shrinkwrap.json"]);
    expect(lockfilesOf("bun")).toEqual(["bun.lock", "bun.lockb"]);
  });

  it("is the entry's when the directory holds its lockfile or none, else the lockfile's", () => {
    expect(installDirPackageManager(new Set(["package.json"]), "pnpm")).toBe("pnpm");
    expect(installDirPackageManager(new Set(["yarn.lock", "package-lock.json"]), "npm")).toBe(
      "npm",
    );
    expect(installDirPackageManager(new Set(["yarn.lock"]), "pnpm")).toBe("yarn");
  });
});
