// Creates apps/manager/.dev.vars (gitignored) with a fresh random local-only value
// for the secret the manager needs in `pnpm dev`: BETTER_AUTH_SECRET. Never
// overwrites an existing value and never prints it. Local dev then serves the
// setup wizard at /setup. CF_API_TOKEN is deliberately not written here; paste a
// token into the setup wizard (against scripts/fake-cloudflare-api.mjs, any
// placeholder works).
//
// It also adds CATALOG_INDEX_URL and MANAGER_RELEASES_URL, pointing the catalog
// and Appflare's own release check at the local `scripts/serve-artifacts.mjs`
// server (default port 8766), when the file lacks them. GITHUB_TOKEN is never
// written here: the local feed needs none.
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LOCAL_URLS = {
  CATALOG_INDEX_URL: "http://127.0.0.1:8766/index.json",
  MANAGER_RELEASES_URL: "http://127.0.0.1:8766/releases",
};

const file = join(dirname(fileURLToPath(import.meta.url)), "../.dev.vars");
if (existsSync(file)) {
  const current = readFileSync(file, "utf8");
  const missing = Object.entries(LOCAL_URLS).filter(
    ([name]) => !new RegExp(`^${name}=`, "m").test(current),
  );
  if (missing.length === 0) {
    console.log("apps/manager/.dev.vars already exists; leaving it alone.");
  } else {
    const sep = current.length === 0 || current.endsWith("\n") ? "" : "\n";
    appendFileSync(file, `${sep}${missing.map(([n, v]) => `${n}=${v}\n`).join("")}`);
    console.log(
      `Added ${missing.map(([n]) => n).join(", ")} (local serve-artifacts) to apps/manager/.dev.vars.`,
    );
  }
} else {
  const random = () => randomBytes(32).toString("base64url");
  const urls = Object.entries(LOCAL_URLS)
    .map(([n, v]) => `${n}=${v}\n`)
    .join("");
  writeFileSync(file, `BETTER_AUTH_SECRET=${random()}\n${urls}`, {
    mode: 0o600,
  });
  console.log(
    "Wrote apps/manager/.dev.vars (BETTER_AUTH_SECRET, CATALOG_INDEX_URL, MANAGER_RELEASES_URL).",
  );
}
