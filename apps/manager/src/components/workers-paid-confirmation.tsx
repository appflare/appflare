import { Checkbox, Text } from "@cloudflare/kumo";
import { ACCOUNT_PLAN_COPY } from "../account/plan";

/** The state of one "This account is on Workers Paid" confirmation and its "Remember" option. */
export interface WorkersPaidConfirmationState {
  checked: boolean;
  onChange(checked: boolean): void;
  /** Also record Workers Paid as the account's plan in Settings. */
  remember: boolean;
  onRememberChange(remember: boolean): void;
  disabled?: boolean;
  /**
   * False when Appflare detected the account's plan: a remembered plan
   * would not apply while detection works, so it is not offered.
   */
  offerRemember?: boolean;
}

/**
 * "This account is on Workers Paid", asked per install or update while the
 * account's plan in Settings says free. Ticking it offers "Remember this for
 * the account", which records the plan so later installs stop asking.
 */
export function WorkersPaidConfirmation({
  state,
  label = "This account is on Workers Paid",
  description,
}: {
  state: WorkersPaidConfirmationState;
  label?: string;
  description?: string;
}) {
  return (
    <div className="grid gap-2">
      <div className="grid gap-1">
        <Checkbox
          label={label}
          checked={state.checked}
          disabled={state.disabled}
          onCheckedChange={(checked: boolean) => {
            state.onChange(checked);
            if (!checked) state.onRememberChange(false);
          }}
        />
        {description !== undefined && (
          <Text as="p" variant="secondary" size="sm">
            {description}
          </Text>
        )}
      </div>
      {state.checked && state.offerRemember !== false && (
        <div className="grid gap-1 pl-6">
          <Checkbox
            label={ACCOUNT_PLAN_COPY.remember}
            checked={state.remember}
            disabled={state.disabled}
            onCheckedChange={(checked: boolean) => state.onRememberChange(checked)}
          />
          <Text as="p" variant="secondary" size="sm">
            {ACCOUNT_PLAN_COPY.rememberDescription}
          </Text>
        </div>
      )}
    </div>
  );
}
