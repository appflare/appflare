import { Dialog } from "@cloudflare/kumo/primitives/dialog";
import { buttonVariants } from "@fumadocs/base-ui/components/ui/button";
import {
  ArrowSquareOutIcon,
  CheckIcon,
  CopyIcon,
  PaperPlaneTiltIcon,
  XIcon,
} from "@phosphor-icons/react";
import {
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
  useRef,
  useState,
} from "react";
import { track } from "../../analytics/analytics.ts";
import { type BrowserKind, chromeIntentUrl, inAppBrowserName } from "../../in-app/browser.ts";
import { pageUrl } from "../../in-app/share.ts";
import { useBrowser } from "../../in-app/use-browser.ts";
import { opensLightbox } from "../catalog/gallery-navigation.ts";
import { LinkToCopy, useLinkActions } from "./link-actions.tsx";

export type InAppBrowser = Extract<BrowserKind, { kind: "in-app" }>;

const PRIMARY = buttonVariants({
  variant: "primary",
  className: "h-11 w-full gap-2 px-4 text-base [&_svg]:size-5",
});
const SECONDARY = buttonVariants({
  variant: "secondary",
  className: "h-11 w-full gap-2 px-3 [&_svg]:size-4.5",
});

/**
 * A bottom sheet on a phone (a centred card on a wider screen), in Base
 * UI's dialog through Kumo, like the screenshot lightbox: the focus stays in
 * it, Escape and the backdrop close it, and it is named by its title.
 */
const SHEET =
  "fixed inset-x-0 bottom-0 z-50 grid max-h-[90dvh] gap-5 overflow-y-auto rounded-t-2xl border-fd-border border-t bg-fd-background px-5 pt-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] text-fd-foreground shadow-2xl outline-none transition-[opacity,translate] duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 max-sm:data-[ending-style]:translate-y-6 max-sm:data-[starting-style]:translate-y-6 motion-reduce:transition-none sm:inset-x-auto sm:top-1/2 sm:bottom-auto sm:left-1/2 sm:w-[min(calc(100vw-2rem),26rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:border sm:p-6";

/** One numbered step of the iPhone instructions. */
function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span
        aria-hidden="true"
        className="flex size-7 shrink-0 items-center justify-center rounded-full bg-fd-secondary font-semibold text-sm tabular-nums"
      >
        {n}
      </span>
      <span className="pt-0.5 leading-relaxed">{children}</span>
    </li>
  );
}

/** A menu's name as the app shows it. */
function MenuWord({ children }: { children: ReactNode }) {
  return <strong className="font-semibold">{children}</strong>;
}

/**
 * Asks a visitor in an app's own browser (X's, Instagram's) to open the
 * page in their real browser before installing, because the Cloudflare
 * sign-in may not finish where they are (Google's sign-in refuses to run
 * there; email and password can work). On an iPhone the app's menu is the
 * only way out, so it says where to tap; on Android, one tap hands the page
 * to Chrome. Copy link and Send to my computer (the share sheet, where the
 * browser has one) carry the page to another device. `path` is the page
 * that carries what the visitor was doing, such as an app's install page.
 * Continue here anyway follows `href`, the link that was pressed, for a
 * visitor who wants to try, or whose browser was taken for an app's.
 */
export function OpenInBrowserSheet({
  browser,
  path,
  href,
  title,
  open,
  onOpenChange,
}: {
  browser: InAppBrowser;
  path: string;
  /** Where the pressed link goes: installing here after all. */
  href: string;
  /** What the share sheet calls the link. */
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const first = useRef<HTMLElement | null>(null);
  const { state, sharing, copy, share } = useLinkActions(path, title, "in_app_browser");
  const page = () => window.location.pathname;
  // Only built once open, in the browser: the address is the one the page was opened at.
  const intent = open && browser.platform === "android" ? chromeIntentUrl(pageUrl(path)) : null;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/50 transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-reduce:transition-none" />
        <Dialog.Popup
          // Base UI hides the rest of the page from assistive technology
          // without saying so on the dialog itself.
          aria-modal="true"
          initialFocus={first}
          className={SHEET}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="grid gap-1">
              <Dialog.Title className="text-balance font-semibold text-xl tracking-tight">
                Open this in your browser
              </Dialog.Title>
              <Dialog.Description className="text-fd-muted-foreground leading-relaxed">
                {inAppBrowserName(browser.app)} may not be able to finish the Cloudflare sign-in.
              </Dialog.Description>
            </div>
            <Dialog.Close
              aria-label="Close"
              className={buttonVariants({
                variant: "ghost",
                size: "icon",
                className: "-mt-1 -mr-2",
              })}
            >
              <XIcon aria-hidden="true" />
            </Dialog.Close>
          </div>

          {browser.platform === "ios" && (
            <ol className="m-0 grid list-none gap-3 p-0">
              <Step n={1}>
                Tap <MenuWord>•••</MenuWord> or the share icon, at the top or bottom of the screen.
              </Step>
              <Step n={2}>
                Choose <MenuWord>Open in browser</MenuWord> or <MenuWord>Open in Safari</MenuWord>.
              </Step>
            </ol>
          )}
          {intent !== null && (
            <div className="grid gap-2">
              <a
                ref={(el) => {
                  first.current = el;
                }}
                href={intent}
                onClick={() =>
                  track("handoff_action", {
                    action: "open",
                    reason: "in_app_browser",
                    page: page(),
                  })
                }
                className={PRIMARY}
              >
                <ArrowSquareOutIcon aria-hidden="true" />
                Open in Chrome
              </a>
              <p className="m-0 text-center text-fd-muted-foreground text-sm">
                Not opening? Use the menu (<MenuWord>⋮</MenuWord>) and choose{" "}
                <MenuWord>Open in browser</MenuWord>.
              </p>
            </div>
          )}
          {browser.platform === "other" && (
            <p className="m-0 leading-relaxed">
              Use the app's menu to open this page in your browser.
            </p>
          )}

          <div className="grid gap-3 border-fd-border border-t pt-4">
            <p className="m-0 text-fd-muted-foreground text-sm">Or finish on your computer:</p>
            {/* Stacked: side by side, "Send to my computer" wraps on a phone. */}
            <div className="grid gap-2">
              <button
                type="button"
                ref={(el) => {
                  if (intent === null) first.current = el;
                }}
                onClick={() => void copy()}
                className={SECONDARY}
              >
                {state === "copied" ? (
                  <CheckIcon aria-hidden="true" />
                ) : (
                  <CopyIcon aria-hidden="true" />
                )}
                {state === "copied" ? "Link copied" : "Copy link"}
              </button>
              {sharing && (
                <button type="button" onClick={() => void share()} className={SECONDARY}>
                  <PaperPlaneTiltIcon aria-hidden="true" />
                  Send to my computer
                </button>
              )}
            </div>
            {state === "failed" && <LinkToCopy path={path} />}
            <p role="status" className="sr-only">
              {state === "copied" ? "Link copied" : ""}
            </p>
          </div>

          <a
            href={href}
            onClick={() =>
              track("handoff_action", {
                action: "continue",
                reason: "in_app_browser",
                page: page(),
              })
            }
            className="-my-2 inline-flex min-h-11 items-center justify-self-center rounded-sm text-fd-muted-foreground text-sm underline underline-offset-4 hover:text-fd-foreground focus-visible:outline-2 focus-visible:outline-fd-ring focus-visible:outline-offset-2"
          >
            Continue here anyway
          </a>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * A link that starts installing: Install Appflare, or an app's Install. In
 * an app's own browser a tap opens {@link OpenInBrowserSheet} instead of
 * following it, and counts {@link SiteEvents.handoff_shown}; its
 * `aria-haspopup="dialog"` keeps the site's click counting from taking that
 * tap for a visit to `href`. Everywhere else, and before the page runs, it is
 * the plain link.
 */
export function InstallLink({
  href,
  handoffPath,
  shareTitle,
  children,
  ...rest
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "onClick"> & {
  href: string;
  /** The page to move to: see {@link OpenInBrowserSheet}. */
  handoffPath: string;
  shareTitle: string;
  children: ReactNode;
}) {
  const browser = useBrowser();
  const inApp = browser?.kind === "in-app" ? browser : null;
  const [open, setOpen] = useState(false);

  function onClick(event: MouseEvent<HTMLAnchorElement>) {
    // A modified or middle click opens the link as the browser would (a new tab, a download).
    if (inApp === null || event.defaultPrevented || !opensLightbox(event)) return;
    event.preventDefault();
    setOpen(true);
    track("handoff_shown", {
      reason: "in_app_browser",
      app: inApp.app,
      page: window.location.pathname,
    });
  }

  return (
    <>
      <a
        href={href}
        onClick={onClick}
        aria-haspopup={inApp === null ? undefined : "dialog"}
        {...rest}
      >
        {children}
      </a>
      {inApp !== null && (
        <OpenInBrowserSheet
          browser={inApp}
          path={handoffPath}
          href={href}
          title={shareTitle}
          open={open}
          onOpenChange={setOpen}
        />
      )}
    </>
  );
}
