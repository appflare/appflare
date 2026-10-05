import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig, type Plugin } from "vite";
import { kumoLoaderAsAppflareLoader } from "../scripts/kumo-loader.ts";
import catalog from "./fixtures/catalog.json" with { type: "json" };
import formApps from "./fixtures/form-apps.json" with { type: "json" };

const fixturePath = resolve(import.meta.dirname, "fixtures/data.ts");
function fixtureServerCalls(): Plugin {
  return {
    name: "appflare:screenshot-fixtures",
    enforce: "pre",
    transform(code, id) {
      if (id === resolve(import.meta.dirname, "styles.css"))
        return `${code}\n@source "../src/**/*.{ts,tsx}";`;
    },
    resolveId(id, importer) {
      if (id === "./routeTree.gen" && importer?.endsWith("/src/router.tsx"))
        return resolve(import.meta.dirname, "route-tree.ts");
      if (!importer || !id.endsWith(".functions")) return;
      return `\0screenshot:${resolve(dirname(importer), `${id}.ts`)}`;
    },
    load(id) {
      if (!id.startsWith("\0screenshot:")) return;
      const source = readFileSync(id.slice("\0screenshot:".length), "utf8");
      const names = [...source.matchAll(/^export (?:const|function|async function) (\w+)/gm)].map(
        (m) => m[1],
      );
      return `import { fixture } from ${JSON.stringify(fixturePath)};\n${names.map((name) => `export const ${name} = (...args) => fixture(${JSON.stringify(name)}, args);`).join("\n")}`;
    },
    configureServer(server) {
      // Setup signs the new owner in through Better Auth's own endpoint, not
      // a server function; this stands in for it so the wizard moves on.
      server.middlewares.use("/api/auth/sign-in/email", (_request, response) => {
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            redirect: false,
            token: "screenshot",
            user: { id: "user-ada", name: "Ada Lovelace", email: "ada@example.com" },
          }),
        );
      });
      const media = new Map(
        [...catalog.apps, ...formApps.apps].flatMap((app) =>
          [app.media.icon, ...("screenshots" in app.media ? app.media.screenshots : [])]
            .filter((file): file is NonNullable<typeof file> => file != null)
            .map(
              (file) =>
                [
                  file.sha256,
                  { slug: app.slug, url: file.url, icon: file === app.media.icon },
                ] as const,
            ),
        ),
      );
      server.middlewares.use("/api/catalog/media", (request, response, next) => {
        const digest = request.url?.split("/").pop();
        const file = digest && media.get(digest);
        if (!file) return next();
        const extension = new URL(file.url).pathname.split(".").pop();
        response.setHeader("Content-Type", extension === "svg" ? "image/svg+xml" : "image/png");
        response.end(
          readFileSync(
            resolve(
              import.meta.dirname,
              file.icon
                ? `fixtures/icons/${file.slug}.${extension}`
                : `fixtures/media/${digest}.${extension}`,
            ),
          ),
        );
      });
    },
  };
}

export default defineConfig({
  root: import.meta.dirname,
  resolve: {
    alias: { "#manager-router": resolve(import.meta.dirname, "../src/router.tsx") },
    conditions: ["@appflare/source", ...defaultClientConditions],
  },
  optimizeDeps: { rolldownOptions: { plugins: [kumoLoaderAsAppflareLoader()] } },
  plugins: [fixtureServerCalls(), react(), tailwindcss(), kumoLoaderAsAppflareLoader()],
  server: { port: 5388, strictPort: true },
});
