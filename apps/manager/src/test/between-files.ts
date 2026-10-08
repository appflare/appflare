/**
 * Setup file for the Worker test projects (vitest.config.ts). The `worker`
 * project runs every test file in one workerd runtime, so a file must not leave
 * data behind for the next: `reset()` empties every binding after its last test.
 * Without it, files that pass on their own fail on rows an earlier file wrote.
 *
 * `reset` comes from the pool's own `cloudflare:test-internal`, which workerd
 * serves natively. `cloudflare:test` exports the same function, but importing
 * it here also imports the Worker entry, and Vitest runs a setup file again
 * before every test file: Vitest reported 250s of setup that way, against 3s.
 */
import { reset } from "cloudflare:test-internal";
import { afterAll } from "vitest";

afterAll(async () => {
  await reset();
});
