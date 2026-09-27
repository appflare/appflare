/**
 * Links inside a message string. Job errors and server errors are stored and
 * passed around as plain strings, yet many of them send the admin somewhere
 * in the manager ("add a token in GitHub access settings"). Such a message
 * carries the link as `[label](/path#anchor)`; the UI renders it as a link
 * (`MessageText`), and anything that shows the message outside the manager
 * uses `plainMessage`, which keeps the label only. A message can carry text
 * from a build or an installer, so only a path to one of the manager's own
 * pages becomes a link (`internal-path.ts`); anything else stays text.
 * Client-safe and server-safe.
 */
import { isMessageLinkPath } from "./internal-path";

/**
 * The link token for `label` pointing at `href`, a path inside the manager.
 * A label can be a name someone typed ("Links [beta]"); brackets would end
 * the token early, so they show as parentheses.
 */
export function messageLink(label: string, href: string): string {
  if (!isMessageLinkPath(href)) throw new Error(`not a path inside the manager: ${href}`);
  return `[${label.replace(/\[/g, "(").replace(/\]/g, ")")}](${href})`;
}

export type MessageSegment =
  | { kind: "text"; text: string }
  | { kind: "link"; label: string; href: string };

// `[label](/path)`: the label has no brackets, the path no spaces or parentheses.
const LINK = /\[([^[\]]+)\]\((\/[^\s()]*)\)/g;

/** The message as text and link segments, in order; a message with no link is one text segment. */
export function messageSegments(message: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let last = 0;
  for (const match of message.matchAll(LINK)) {
    const [whole, label, href] = match;
    const at = match.index;
    if (label === undefined || href === undefined || !isMessageLinkPath(href)) continue;
    if (at > last) segments.push({ kind: "text", text: message.slice(last, at) });
    segments.push({ kind: "link", label, href });
    last = at + whole.length;
  }
  if (last < message.length) segments.push({ kind: "text", text: message.slice(last) });
  return segments;
}

/** The message with each link reduced to its label, for places that cannot show links. */
export function plainMessage(message: string): string {
  return messageSegments(message)
    .map((s) => (s.kind === "text" ? s.text : s.label))
    .join("");
}
