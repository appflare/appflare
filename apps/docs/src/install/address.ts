/**
 * The address of a visitor's Appflare, as this site keeps it: the origin
 * only (`https://appflare.example.com`), never a path. An address is
 * accepted when it is `https:`, or `http:` on this computer (`localhost`,
 * `127.0.0.1`, `[::1]`), and carries no user name or password. The site
 * only ever sends a visitor to an address that passed this check, so a
 * link or a stored value cannot point it at `javascript:` or any other kind
 * of page.
 */

export type AddressCheck = { ok: true; origin: string } | { ok: false; error: string };

/** The hosts that may use `http:`: an Appflare running on the visitor's own computer. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Longer than any real address; anything past it is refused unread. */
const MAX_ADDRESS_LENGTH = 2048;

/** The address a new Appflare gets, as the example in every message. */
export const EXAMPLE_ADDRESS = "https://appflare.yourname.workers.dev";

const NOT_AN_ADDRESS = `That is not a web address. Enter one such as ${EXAMPLE_ADDRESS}.`;

const refused = (error: string): AddressCheck => ({ ok: false, error });

/**
 * Checks a full address, scheme included, as it arrives in a link or from
 * this browser's storage.
 */
export function checkAddress(text: string): AddressCheck {
  const value = text.trim();
  if (value === "") return refused(`Enter your Appflare's address, such as ${EXAMPLE_ADDRESS}.`);
  if (value.length > MAX_ADDRESS_LENGTH) return refused("That address is too long.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return refused(NOT_AN_ADDRESS);
  }
  if (url.protocol === "http:") {
    if (!LOCAL_HOSTS.has(url.hostname)) {
      return refused(
        "Use the address that starts with https://. Only an Appflare on this computer can use http://.",
      );
    }
  } else if (url.protocol !== "https:") {
    return refused(NOT_AN_ADDRESS);
  }
  if (url.username !== "" || url.password !== "") {
    return refused("Enter the address without a user name or password.");
  }
  if (url.hostname === "") return refused(NOT_AN_ADDRESS);
  return { ok: true, origin: url.origin };
}

/**
 * Checks what a visitor typed in the address field. People often leave out
 * `https://`, so a plain host name gets it added; anything that names
 * another scheme (`javascript:`, `data:`) or starts with a slash is refused
 * rather than guessed at.
 */
export function checkTypedAddress(text: string): AddressCheck {
  const value = text.trim();
  if (value === "" || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return checkAddress(value);
  // A scheme without `//` (`javascript:`, `mailto:`), as opposed to `host:port`.
  if (/^[a-z][a-z0-9+.-]*:(?!\d+(?:[/?#]|$))/i.test(value) || /^[/\\]/.test(value)) {
    return refused(NOT_AN_ADDRESS);
  }
  return checkAddress(`https://${value}`);
}

/** Whether `value` is exactly an address this site keeps: a checked origin and nothing more. */
export function isAppflareOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const check = checkAddress(value);
  return check.ok && check.origin === value;
}
