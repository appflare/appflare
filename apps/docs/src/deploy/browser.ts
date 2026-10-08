import { browserMemory } from "../install/memory.ts";
import { buildOAuthSetup } from "./config.ts";
import { DeployFlow } from "./flow.ts";
import { type FetchLike, installerApi } from "./installer-api.ts";
import { managerApi } from "./manager-api.ts";
import { browserDeployStorage } from "./storage.ts";
import { TokenKeeper } from "./tokens.ts";

/** The deploy page's flow, wired to this browser. */
export function createBrowserFlow(): DeployFlow {
  const fetch: FetchLike = (input, init) => window.fetch(input, init);
  const storage = browserDeployStorage();
  const tokens = new TokenKeeper({ slot: storage.grant, fetch });
  return new DeployFlow({
    setup: buildOAuthSetup(window.location.origin),
    storage,
    tokens,
    api: installerApi({ fetch, accessToken: () => tokens.accessToken() }),
    manager: managerApi(fetch),
    origin: window.location.origin,
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
    navigate: (url) => window.location.assign(url),
    search: window.location.search,
    memory: browserMemory(),
  });
}
