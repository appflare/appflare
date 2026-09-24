import { z } from "zod";
import type { CliTelemetry } from "./telemetry.ts";
import type { Ui } from "./ui.ts";
import { parseJsonOutput, type Wrangler, WranglerError, wranglerArgs } from "./wrangler.ts";

/** A Cloudflare account wrangler can act on. */
export interface Account {
  id: string;
  name: string;
}

const whoamiSchema = z.union([
  z.object({ loggedIn: z.literal(false) }),
  z.looseObject({
    loggedIn: z.literal(true),
    authType: z.string().optional(),
    accounts: z.array(z.looseObject({ id: z.string().min(1), name: z.string() })),
  }),
]);

/** What `wrangler whoami --json` said. */
export type WhoamiState = { loggedIn: false } | { loggedIn: true; accounts: Account[] };

/** Parses `wrangler whoami --json` output (logged-out runs print `{"loggedIn":false}` and exit 1). */
export function parseWhoami(stdout: string): WhoamiState {
  const parsed = whoamiSchema.parse(parseJsonOutput("whoami", stdout));
  if (!parsed.loggedIn) {
    return { loggedIn: false };
  }
  return {
    loggedIn: true,
    accounts: parsed.accounts.map((account) => ({ id: account.id, name: account.name })),
  };
}

/** The outcome of {@link chooseAccount}: an account, or a list the user must pick from. */
export type AccountChoice =
  | { kind: "chosen"; account: Account }
  | { kind: "ask"; accounts: Account[] };

/**
 * Picks the account without asking when possible: `CLOUDFLARE_ACCOUNT_ID` wins
 * (it must be one of the visible accounts), then a single visible account.
 * Several accounts need a prompt; with `--yes` that is an error.
 */
export function chooseAccount(
  accounts: Account[],
  options: { envAccountId?: string; yes: boolean },
): AccountChoice {
  if (options.envAccountId) {
    const account = accounts.find((a) => a.id === options.envAccountId);
    if (!account) {
      throw new Error(
        `CLOUDFLARE_ACCOUNT_ID is set to ${options.envAccountId}, which is not one of the accounts ` +
          `you are logged in to (${accounts.map((a) => a.id).join(", ") || "none"}).`,
      );
    }
    return { kind: "chosen", account };
  }
  const [only, ...rest] = accounts;
  if (!only) {
    throw new Error("You are logged in, but your login has access to no Cloudflare account.");
  }
  if (rest.length === 0) {
    return { kind: "chosen", account: only };
  }
  if (options.yes) {
    throw new Error(
      "You have access to several Cloudflare accounts. Set CLOUDFLARE_ACCOUNT_ID to the one to use, " +
        `or run without --yes to pick one: ${accounts.map((a) => `${a.name} (${a.id})`).join(", ")}.`,
    );
  }
  return { kind: "ask", accounts };
}

async function whoami(wrangler: Wrangler): Promise<WhoamiState> {
  const result = await wrangler.run(wranglerArgs.whoami());
  if (result.code !== 0) {
    // Logged out is the one expected failure; anything else (a bad token, no
    // network) is reported as-is.
    try {
      const state = parseWhoami(result.stdout);
      if (!state.loggedIn) {
        return state;
      }
    } catch {
      // not the logged-out document; report wrangler's own error below
    }
    throw new WranglerError("whoami", result);
  }
  return parseWhoami(result.stdout);
}

/**
 * Makes sure wrangler is authenticated (running `wrangler
 * login` if not), picks the account, and binds `wrangler` to it so every later
 * command gets `CLOUDFLARE_ACCOUNT_ID`.
 */
export async function ensureAccount(
  wrangler: Wrangler,
  ui: Ui,
  options: { env: NodeJS.ProcessEnv; yes: boolean; telemetry?: CliTelemetry | undefined },
): Promise<Account> {
  const { telemetry } = options;
  if (telemetry) telemetry.step = "login";
  ui.step("Checking your Cloudflare login");
  let state = await whoami(wrangler);
  if (telemetry) telemetry.loginNeeded = !state.loggedIn;
  if (!state.loggedIn) {
    if (options.env.CLOUDFLARE_API_TOKEN) {
      throw new Error("CLOUDFLARE_API_TOKEN is set, but wrangler could not log in with it.");
    }
    if (!ui.interactive) {
      throw new Error(
        "wrangler is not logged in. Run `npx wrangler login` first, or run this in a terminal.",
      );
    }
    ui.info("wrangler is not logged in; opening the Cloudflare login in your browser.");
    const login = await wrangler.run(wranglerArgs.login(), {
      stdin: { kind: "inherit" },
      output: "stream",
    });
    if (login.code !== 0) {
      throw new Error(`\`wrangler login\` failed (exit code ${login.code}).`);
    }
    state = await whoami(wrangler);
    if (!state.loggedIn) {
      throw new Error("wrangler is still not logged in after `wrangler login`.");
    }
  }

  if (telemetry) {
    telemetry.step = "account";
    telemetry.severalAccounts = state.accounts.length > 1;
  }
  const choice = chooseAccount(state.accounts, {
    envAccountId: options.env.CLOUDFLARE_ACCOUNT_ID,
    yes: options.yes,
  });
  let account: Account;
  if (choice.kind === "chosen") {
    account = choice.account;
  } else {
    if (!ui.interactive) {
      throw new Error(
        "You have access to several Cloudflare accounts. Set CLOUDFLARE_ACCOUNT_ID to the one to use.",
      );
    }
    const id = await ui.select(
      "Which Cloudflare account?",
      choice.accounts.map((a) => ({ value: a.id, label: a.name, hint: a.id })),
    );
    account = choice.accounts.find((a) => a.id === id) as Account;
  }
  wrangler.accountId = account.id;
  if (telemetry) telemetry.step = "run";
  ui.info(`Account: ${account.name} (${account.id})`);
  return account;
}
