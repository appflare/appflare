// Creates apps/manager/.dev.vars (gitignored) with fresh random local-only values
// for the secrets the manager needs in `pnpm dev`: BETTER_AUTH_SECRET and
// SETUP_TOKEN. Never overwrites an existing file and never prints the values.
// Local dev then serves /setup?token=<SETUP_TOKEN from the file>.
// CF_API_TOKEN is deliberately not written here; paste a token into the setup wizard.
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const file = join(dirname(fileURLToPath(import.meta.url)), "../.dev.vars");
if (existsSync(file)) {
  console.log("apps/manager/.dev.vars already exists; leaving it alone.");
} else {
  const random = () => randomBytes(32).toString("base64url");
  writeFileSync(file, `BETTER_AUTH_SECRET=${random()}\nSETUP_TOKEN=${random()}\n`, { mode: 0o600 });
  console.log("Wrote apps/manager/.dev.vars (BETTER_AUTH_SECRET, SETUP_TOKEN).");
}
