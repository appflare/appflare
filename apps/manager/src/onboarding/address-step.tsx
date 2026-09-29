import { Button, Radio, Text } from "@cloudflare/kumo";
import { type FormEvent, useState } from "react";
import { FULL_WIDTH_ACTION } from "../components/auth-layout";
import { BusyButton } from "../components/busy-button";
import { TokenPermissionsBanner } from "../components/domain-dialog-parts";
import {
  AddressFields,
  MoveProgress,
  moveActionLabel,
  useAddressFields,
  useAddressMove,
} from "../components/manager-address-move";
import { MessageText } from "../components/message-text";
import type { AddressOptions } from "../domains/manager-address.functions";
import { ADDRESS_UNREADABLE_NOTE } from "./wizard";

/**
 * Setup's "Where should Appflare live?", shown only when the account has an
 * active zone: keep the workers.dev address (the default), or move Appflare
 * to a domain of the account now. The move is the one Domains settings
 * runs, a job whose progress shows here; once it has succeeded the browser
 * goes to the sign-in page at the new address, whose return path
 * (`returnTo`) resumes setup at its last step.
 * Keeping the address, or Later, goes on to the last step here.
 */
export function AddressStep({
  options,
  accountId,
  returnTo,
  onDone,
  go = (url) => window.location.assign(url),
}: {
  options: AddressOptions;
  /** The account Appflare runs in, so dashboard links open it. */
  accountId: string | null;
  /** Setup's last step at the new address. */
  returnTo: string;
  /** Appflare stays where it is: on to the last step. */
  onDone: () => void;
  /** Opens the sign-in page at the new address. */
  go?: (url: string) => void;
}) {
  const [choice, setChoice] = useState<"keep" | "domain">("keep");
  const fields = useAddressFields(options.zones);
  const move = useAddressMove({ kind: "move", returnTo, onMoved: (movedTo) => go(movedTo.url) });
  const here = typeof window === "undefined" ? null : window.location.host;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (choice === "keep") {
      onDone();
      return;
    }
    fields.touch();
    if (fields.target === null) return;
    await move.run(fields.target);
  }

  if (move.movedTo !== null) {
    return <MoveProgress hostname={move.movedTo.hostname} jobId={null} done />;
  }
  const following = move.following;
  if (following !== null || (move.starting && fields.target !== null)) {
    return (
      <MoveProgress
        hostname={following?.hostname ?? fields.target?.hostname ?? ""}
        jobId={following?.jobId ?? null}
        job={move.job}
        refused={move.refused}
      />
    );
  }

  return (
    <form className="grid gap-5" onSubmit={onSubmit}>
      <Radio.Group
        value={choice}
        onValueChange={(v) => setChoice(v === "domain" ? "domain" : "keep")}
        appearance="card"
      >
        <Radio.Legend className="sr-only">Where Appflare lives</Radio.Legend>
        <Radio.Item
          value="keep"
          label="Keep the workers.dev address"
          description={
            here === null ? "Appflare stays where it is now." : `Appflare stays at ${here}.`
          }
        />
        <Radio.Item
          value="domain"
          label="Use a domain of yours"
          description="A name in one of your domains on Cloudflare. The workers.dev address then sends visits there, and you sign in again at the new address."
        />
      </Radio.Group>
      {choice === "domain" && (
        <div className="grid gap-4">
          {options.missing.length > 0 && (
            <TokenPermissionsBanner options={options} accountId={accountId} />
          )}
          <AddressFields zones={options.zones} fields={fields} move={move} />
        </div>
      )}
      <div className="grid gap-2">
        <BusyButton
          type="submit"
          variant="primary"
          className={FULL_WIDTH_ACTION}
          pending={move.moving}
          disabled={choice === "domain" && (fields.zone === null || move.blocked)}
        >
          {choice === "domain" ? moveActionLabel(move, "Continue") : "Continue"}
        </BusyButton>
        <Button variant="secondary" className={FULL_WIDTH_ACTION} onClick={onDone}>
          Later
        </Button>
      </div>
    </form>
  );
}

/**
 * The last step's quiet line when the address step was skipped because the
 * account's domains could not be read.
 */
export function AddressSkippedNote() {
  return (
    <Text variant="secondary">
      <MessageText message={ADDRESS_UNREADABLE_NOTE} newTab />
    </Text>
  );
}
