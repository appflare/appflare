import { defineConfig } from "drizzle-kit";

// `drizzle-kit generate` only: it diffs src/db/schema.ts against the last
// snapshot and writes SQL into src/db/migrations/. Nothing here talks to a
// database; the Worker applies the files itself (src/db/migrate.ts).
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
});
