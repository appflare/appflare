import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

/**
 * Kumo's spinner ring lives in one module of Kumo's build
 * (`dist/chunks/loader-<hash>.js`), and Kumo's own components import it
 * directly: `Button` draws it whenever `loading` is set, and imports it even
 * when nothing does, so the ring's code ships with every page that has a
 * button. The manager draws busy states with the Appflare mark instead
 * (`AppflareLoader`, which takes the same props), so this plugin serves that
 * module as a re-export of `AppflareLoader` under the name Kumo imports it by.
 * Any Kumo component that shows a loader then shows the mark, and the ring is
 * not in the build at all; `scripts/check-no-kumo-ring.mjs` checks the output.
 * Register it in `plugins` for builds and in
 * `optimizeDeps.rolldownOptions.plugins` for dev, where Kumo is served from
 * Vite's pre-bundled dependencies and ordinary plugins never see its files.
 * The pre-bundle is cached, mark included: after editing the loader (`@appflare/brand/loader`),
 * restart dev with `--force` to see the change inside Kumo's components.
 *
 * The chunk's file name and its export name are Kumo build details that can
 * change in any release. The export name is read from the chunk itself, and
 * a `vite build` environment in which no chunk matched fails, so a Kumo
 * release that renames the chunk stops the build instead of quietly bringing
 * the ring back.
 *
 * Delete this plugin once Kumo's `Button` accepts a custom loader or icon for
 * its loading state; the manager's `BusyButton` already draws the mark itself,
 * so only the unused ring in the bundle depends on it.
 */
const KUMO_LOADER_CHUNK = /[\\/]@cloudflare[\\/]kumo[\\/]dist[\\/]chunks[\\/]loader-[\w-]+\.js$/;
const APPFLARE_LOADER = resolve(
  import.meta.dirname,
  "../node_modules/@appflare/brand/src/appflare-loader.tsx",
);

export function kumoLoaderAsAppflareLoader(): Plugin {
  // Only a Vite build checks for a match: `configResolved` never runs when the
  // plugin is handed to the dev pre-bundler, which may bundle an environment's
  // dependencies without Kumo in them.
  let isBuild = false;
  const matchedEnvironments = new Set<string>();
  return {
    name: "appflare:kumo-loader",
    enforce: "pre",
    configResolved(config) {
      isBuild = config.command === "build";
    },
    load: {
      filter: { id: KUMO_LOADER_CHUNK },
      handler(id) {
        const source = readFileSync(id.replace(/\?.*$/, ""), "utf8");
        const exported = /export\s*\{\s*Loader as (\w+)\s*\}/.exec(source)?.[1];
        if (!exported) {
          this.error(`Kumo's loader module no longer exports Loader the expected way: ${id}`);
        }
        // `environment` is absent inside the dev pre-bundler.
        matchedEnvironments.add(this.environment?.name ?? "");
        return `export { AppflareLoader as ${exported} } from ${JSON.stringify(APPFLARE_LOADER)};\n`;
      },
    },
    buildEnd(error) {
      if (!isBuild || error) return;
      const name = this.environment.name;
      if (!matchedEnvironments.has(name)) {
        this.error(
          `No Kumo loader chunk (dist/chunks/loader-*.js) was bundled in the "${name}" build, so Kumo's spinner ring may be back. Update KUMO_LOADER_CHUNK in scripts/kumo-loader.ts to the chunk that now exports Loader.`,
        );
      }
    },
  };
}
