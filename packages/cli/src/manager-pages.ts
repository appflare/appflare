/**
 * The manager's own pages the installer sends people to once the manager
 * runs: each one's name as the manager shows it, and its path with the
 * section on the page. The manager builds the same paths from its settings
 * map; the paths are pinned in a test here so a moved section is noticed.
 */
export const MANAGER_PAGES = {
  updates: { name: "Settings > Updates", path: "/settings/updates#appflare" },
  versions: { name: "Settings > Updates > Recent versions", path: "/settings/updates#versions" },
  building: { name: "Settings > Building apps", path: "/settings/building#sandbox" },
  dangerZone: {
    name: "Settings > Your account > Danger zone",
    path: "/settings/account#danger-zone",
  },
} as const satisfies Record<string, { name: string; path: string }>;

export type ManagerPage = keyof typeof MANAGER_PAGES;

/** Stands for the manager's address where the installer does not know it. */
export const MANAGER_ADDRESS_PLACEHOLDER = "https://<your manager>";

/**
 * The full URL of one of the manager's pages: `managerPageUrl(
 * "https://appflare.acme.workers.dev/", "dangerZone")` is
 * `https://appflare.acme.workers.dev/settings/account#danger-zone`. Without
 * an address, the placeholder stands in for it.
 */
export function managerPageUrl(managerUrl: string | null, page: ManagerPage): string {
  const base = (managerUrl ?? MANAGER_ADDRESS_PLACEHOLDER).replace(/\/+$/, "");
  return `${base}${MANAGER_PAGES[page].path}`;
}

/** "Settings > Updates (https://…/settings/updates#appflare)": the page's name and where it is. */
export function managerPageRef(managerUrl: string | null, page: ManagerPage): string {
  return `${MANAGER_PAGES[page].name} (${managerPageUrl(managerUrl, page)})`;
}

/** The lines printed after an install: where to update, build apps and remove the manager. */
export function managerPageLines(managerUrl: string): string[] {
  return [
    "Once it is set up, the manager's own settings take it from there:",
    `  update Appflare      ${managerPageUrl(managerUrl, "updates")}`,
    `  sandbox builds       ${managerPageUrl(managerUrl, "building")}`,
    `  remove Appflare      ${managerPageUrl(managerUrl, "dangerZone")}`,
  ];
}
