import { Banner, LinkButton } from "@cloudflare/kumo";
import { ArrowSquareOutIcon, InfoIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { getAddressStatus } from "../domains/address-status.functions";
import {
  ADDRESS_WATCH_MS,
  movedLine,
  movedUrl,
  watchesAddress,
  watchStep,
} from "../domains/address-watch";
import { ACTIONS_UNDER_ON_PHONE, BannerActions } from "./message-text";

/**
 * Whether someone typed into a form on this page since it loaded or since
 * the form was last sent: going elsewhere would lose that. Typing is what
 * counts, since React keeps a controlled field's default value in step with
 * its value, so comparing the two says nothing.
 */
function useUnsavedInput(): () => boolean {
  const [state] = useState(() => ({ dirty: false }));
  useEffect(() => {
    const onInput = (event: Event) => {
      if (event.target instanceof Element && event.target.closest("form") !== null) {
        state.dirty = true;
      }
    };
    const onSubmit = () => {
      state.dirty = false;
    };
    document.addEventListener("input", onInput, true);
    document.addEventListener("submit", onSubmit, true);
    return () => {
      document.removeEventListener("input", onInput, true);
      document.removeEventListener("submit", onSubmit, true);
    };
  }, [state]);
  // One function for the page's life, so the watch never starts over.
  const [isDirty] = useState(() => () => state.dirty);
  return isDirty;
}

/**
 * Every page, at the workers.dev address only: while Appflare waits to move
 * to its domain, asks every 15 seconds whether it moved (domains/address-watch.ts).
 * Once it has: one line, "Appflare moved to <host>.", and the same page at
 * the new address; with unsaved input in a form, an "Open <host>" button
 * instead of leaving by itself. Nothing at any other address, and no more
 * asking once nothing is pending.
 */
export function AddressWatch() {
  const [moved, setMoved] = useState<{ hostname: string; url: string } | null>(null);
  const unsaved = useUnsavedInput();

  useEffect(() => {
    if (!watchesAddress(window.location.host)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const ask = async () => {
      let step: ReturnType<typeof watchStep>;
      try {
        step = watchStep(await getAddressStatus(), window.location.host);
      } catch {
        // No answer this time; ask again later.
        step = { kind: "wait" };
      }
      if (stopped) return;
      if (step.kind === "moved") {
        const url = movedUrl(step.hostname, window.location);
        setMoved({ hostname: step.hostname, url });
        if (!unsaved()) window.location.assign(url);
        return;
      }
      if (step.kind === "wait") timer = setTimeout(() => void ask(), ADDRESS_WATCH_MS);
    };
    void ask();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [unsaved]);

  if (moved === null) return null;
  return (
    <div className="fixed inset-x-0 bottom-0 p-3 sm:left-auto sm:max-w-md" role="status">
      <Banner
        variant="default"
        icon={<InfoIcon weight="fill" />}
        className={ACTIONS_UNDER_ON_PHONE}
        title={movedLine(moved.hostname)}
        action={
          unsaved() ? (
            <BannerActions>
              <LinkButton href={moved.url} variant="primary" icon={<ArrowSquareOutIcon />}>
                Open {moved.hostname}
              </LinkButton>
            </BannerActions>
          ) : undefined
        }
      />
    </div>
  );
}
