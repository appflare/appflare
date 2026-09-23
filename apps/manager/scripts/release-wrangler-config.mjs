// Writes dist/server/wrangler.release.json: the Cloudflare Vite plugin's
// generated deploy config (dist/server/wrangler.json) without the manager's
// `SELF` service binding. Run by `pnpm build` after `vite build`; the catalog
// manifest (appflare.jsonc) packs releases from this file.
//
// Why the release leaves `SELF` out: the binding names the Worker itself, and
// only a running manager (its self-update) or the installer knows that name,
// so both add it themselves. Managers from before job units refuse a service
// binding they would have to create, so a release that declared it could not
// be installed by their self-update.
//
// Written next to the generated config so its relative paths still resolve.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_BINDING = "SELF";

/**
 * The deploy config without the `SELF` service binding; other service
 * bindings are kept.
 * @param {Record<string, unknown>} built
 * @returns {Record<string, unknown>}
 */
export function releaseWranglerConfig(built) {
  const services = Array.isArray(built.services) ? built.services : [];
  const kept = services.filter(
    (s) => !(typeof s === "object" && s !== null && s.binding === SELF_BINDING),
  );
  const { services: _services, ...rest } = built;
  return kept.length > 0 ? { ...rest, services: kept } : rest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = join(dirname(fileURLToPath(import.meta.url)), "../dist/server");
  const built = JSON.parse(readFileSync(join(server, "wrangler.json"), "utf8"));
  writeFileSync(
    join(server, "wrangler.release.json"),
    `${JSON.stringify(releaseWranglerConfig(built), null, 2)}\n`,
  );
}
