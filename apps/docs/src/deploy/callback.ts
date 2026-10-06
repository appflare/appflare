import type { CallbackParams } from "./arrival.ts";
import {
  type CallbackProblem,
  decideCallback,
  type ExchangeProblem,
  exchangeForGrant,
  OAUTH_RETURN_PATH,
  type ReturnFields,
} from "./authorize.ts";
import { DEPLOY_PATH } from "./config.ts";
import type { FetchLike } from "./installer-api.ts";
import type { DeployStorage } from "./storage.ts";
import type { TokenKeeper } from "./tokens.ts";

/**
 * The callback page's whole job, once the address bar is clean (see
 * `arrival.ts`): a deploy sign-in is finished here and the tab goes back to
 * the deploy page; a manager's Reconnect Cloudflare goes back to that
 * manager as a form POST, after the visitor confirms its address. The code
 * is never stored and never shown.
 */

export type CallbackView =
  | { step: "working" }
  /**
   * A reconnect for the Appflare at `origin`: waiting for the visitor to
   * confirm it is theirs. `fields` stay in memory until then.
   */
  | { step: "confirm-return"; origin: string; fields: ReturnFields }
  /** Confirmed: the browser is on its way to the Appflare, which reports the outcome. */
  | { step: "returning"; origin: string }
  /** The visitor did not confirm: nothing was sent. */
  | { step: "cancelled" }
  /** Consent was not given at Cloudflare. */
  | { step: "declined" }
  | { step: "problem"; problem: CallbackProblem | ExchangeProblem }
  /** Signed in; on the way back to the deploy page. */
  | { step: "done" };

export interface CallbackDeps {
  params: CallbackParams | null;
  storage: Pick<DeployStorage, "authorization">;
  tokens: Pick<TokenKeeper, "keep">;
  navigate: (url: string) => void;
  fetch?: FetchLike;
  now?: () => number;
}

export async function runCallback(deps: CallbackDeps): Promise<CallbackView> {
  const params = deps.params ?? { code: null, state: null, error: null };
  const pending = deps.storage.authorization.read();
  const decision = decideCallback(params, pending);
  switch (decision.kind) {
    case "confirm-return":
      return { step: "confirm-return", origin: decision.origin, fields: decision.fields };
    case "problem":
      return { step: "problem", problem: decision.problem };
    case "declined":
      deps.storage.authorization.clear();
      return { step: "declined" };
    case "exchange": {
      // A sign-in is finished once, whatever happens next.
      deps.storage.authorization.clear();
      const result = await exchangeForGrant(decision.code, decision.pending, deps.fetch, deps.now);
      if (!result.ok) return { step: "problem", problem: result.problem };
      deps.tokens.keep(result.grant);
      deps.navigate(DEPLOY_PATH);
      return { step: "done" };
    }
  }
}

/** The form a confirmed reconnect is posted with: `<origin>/api/cloudflare/oauth-return`. */
export function returnForm(
  origin: string,
  fields: ReturnFields,
): { action: string; fields: Array<[string, string]> } {
  const list: Array<[string, string]> =
    "code" in fields
      ? [
          ["code", fields.code],
          ["state", fields.state],
        ]
      : [
          ["error", fields.error],
          ["state", fields.state],
        ];
  return { action: `${origin}${OAUTH_RETURN_PATH}`, fields: list };
}

/** The part of `Document` the form needs; tests pass a stand-in. */
export interface FormDocument {
  createElement(tag: "form"): HTMLFormElement;
  createElement(tag: "input"): HTMLInputElement;
  body: { append(node: Node): void };
}

/**
 * Builds the form only now, after the visitor confirmed, and submits it:
 * `application/x-www-form-urlencoded`, POST, so the code is never in a URL.
 */
export function submitReturn(doc: FormDocument, origin: string, fields: ReturnFields): void {
  const spec = returnForm(origin, fields);
  const form = doc.createElement("form");
  form.method = "post";
  form.action = spec.action;
  form.enctype = "application/x-www-form-urlencoded";
  form.rel = "noreferrer";
  for (const [name, value] of spec.fields) {
    const input = doc.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.append(input);
  }
  doc.body.append(form);
  form.submit();
}
