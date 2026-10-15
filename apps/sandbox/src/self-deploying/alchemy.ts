import type { AlchemyRunRequest } from "@appflare/schema";
import { commandLine, STAGE_TIMEOUTS } from "../protocol";
import type { InstallerStrategy } from "./strategy";

/**
 * Alchemy: one command for the action, with `<stageArg> <stage>` appended.
 * Alchemy keeps its state in the account (its `alchemy-state-store`
 * Worker), so the run needs nothing restored, and a deploy and an update
 * are the same command.
 */

/** The installer's command line with the stage appended. */
export function installerCommand(request: AlchemyRunRequest): string {
  return commandLine([...request.command, request.stageArg, request.stage]);
}

export function alchemyStrategy(request: AlchemyRunRequest): InstallerStrategy {
  return {
    launcher: [],
    ownedResources: null,
    async prepare() {},
    async run({ action, container, env }) {
      await container.run(action, installerCommand(request), {
        cwd: container.project,
        timeoutMs: STAGE_TIMEOUTS.installer,
        env,
        failure: `the installer's ${action} command failed`,
      });
    },
  };
}
