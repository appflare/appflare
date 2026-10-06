/**
 * Entry for Better Auth's schema generator only (never bundled), run by
 * `pnpm auth:generate`, which loads workspace packages from source.
 * It builds the real `createAuth` options with inert stand-ins so the generated
 * tables always match the plugins the manager runs with.
 */
import { createAuth } from "../src/auth/server";

export const auth = createAuth({
  db: {} as never,
  secret: "schema-generation-only-not-a-secret-000000",
  baseURL: "http://localhost",
});
