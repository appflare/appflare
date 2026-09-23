// Creates apps/manager/.dev.vars (gitignored) with fresh random local-only values
// for the secrets the manager needs in `pnpm dev`: BETTER_AUTH_SECRET and
// SETUP_TOKEN. Never overwrites an existing value and never prints the values.
// Local dev then serves /setup?token=<SETUP_TOKEN from the file>.
// CF_API_TOKEN is deliberately not written here; paste a token into the setup wizard.
//
// It also adds CATALOG_INDEX_URL, pointing the catalog at the local
// `scripts/serve-artifacts.mjs` server (default port 8766), when the file lacks it.
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LOCAL_CATALOG = "CATALOG_INDEX_URL=http://127.0.0.1:8766/index.json";

const file = join(dirname(fileURLToPath(import.meta.url)), "../.dev.vars");
if (existsSync(file)) {
  const current = readFileSync(file, "utf8");
  if (/^CATALOG_INDEX_URL=/m.test(current)) {
    console.log("apps/manager/.dev.vars already exists; leaving it alone.");
  } else {
    const sep = current.length === 0 || current.endsWith("\n") ? "" : "\n";
    appendFileSync(file, `${sep}${LOCAL_CATALOG}\n`);
    console.log("Added CATALOG_INDEX_URL (local serve-artifacts) to apps/manager/.dev.vars.");
  }
} else {
  const random = () => randomBytes(32).toString("base64url");
  writeFileSync(
    file,
    `BETTER_AUTH_SECRET=${random()}\nSETUP_TOKEN=${random()}\n${LOCAL_CATALOG}\n`,
    { mode: 0o600 },
  );
  console.log("Wrote apps/manager/.dev.vars (BETTER_AUTH_SECRET, SETUP_TOKEN, CATALOG_INDEX_URL).");
}
