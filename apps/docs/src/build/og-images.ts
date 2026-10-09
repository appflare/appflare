import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Plugin } from "vite";
import { ogImagePath } from "../lib/shared.ts";

/**
 * The same-site OpenGraph image paths an HTML document references, such as
 * `/og/start/install/image.png` for
 * `<meta property="og:image" content="https://docs.example/og/start/install/image.png">`.
 */
export function ogImagePaths(html: string, siteUrl: string): string[] {
  const paths: string[] = [];
  for (const tag of html.match(/<meta\b[^>]*>/g) ?? []) {
    if (!/\bproperty=["']og:image["']/.test(tag)) continue;
    const content = /\bcontent=["']([^"']+)["']/.exec(tag)?.[1];
    if (content?.startsWith(`${siteUrl}/`)) paths.push(content.slice(siteUrl.length));
  }
  return paths;
}

async function htmlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
    .map((entry) => join(entry.parentPath, entry.name));
}

/**
 * Writes every OpenGraph image the prerendered pages reference into the static
 * output, as a build step after prerendering.
 *
 * The prerenderer saves each response as text, which would corrupt a PNG, so
 * the images are fetched here instead: from a preview server of the built app
 * (the same way the prerenderer reaches it), and saved byte for byte. The build
 * fails if a page references an image the app cannot render.
 */
export function ogImages({ siteUrl }: { siteUrl: string }): Plugin {
  return {
    name: "appflare-og-images",
    apply: "build",
    enforce: "post",
    buildApp: {
      order: "post",
      async handler(viteBuilder) {
        const client = viteBuilder.environments.client;
        if (!client) throw new Error('Vite\'s "client" environment is missing');
        const outDir = resolve(viteBuilder.config.root, client.config.build.outDir);

        // Existing shared links may still reference the previous default image.
        const paths = new Set<string>([ogImagePath([])]);
        for (const file of await htmlFiles(outDir)) {
          for (const path of ogImagePaths(await readFile(file, "utf8"), siteUrl)) paths.add(path);
        }
        const { preview } = await import("vite");
        const server = await preview({
          configFile: viteBuilder.config.configFile,
          preview: { port: 0, open: false },
          logLevel: "warn",
        });
        try {
          const base = server.resolvedUrls?.local[0];
          if (!base) throw new Error("The preview server has no local URL");
          for (const path of paths) {
            const response = await fetch(new URL(path, base));
            const type = response.headers.get("content-type") ?? "";
            if (!response.ok || !type.startsWith("image/")) {
              throw new Error(`OpenGraph image ${path}: ${response.status} ${type}`);
            }
            const target = resolve(outDir, `.${path}`);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, new Uint8Array(await response.arrayBuffer()));
          }
        } finally {
          await server.close();
        }
        viteBuilder.config.logger.info(`Wrote ${paths.size} OpenGraph images`);
      },
    },
  };
}
