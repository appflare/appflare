import { Link, LinkButton } from "@cloudflare/kumo";
import { QuestionIcon } from "@phosphor-icons/react";
import { type DocsTopic, docsUrl } from "../docs-topics";
import { Tooltip } from "./tooltip";

export const DOCS_LINK_LABEL = "Learn more in the docs";

/**
 * A link to the docs page that explains the thing next to it, opened in a
 * new tab. `icon` (the default) is a small help button with a tooltip, for
 * titles and card headers; `inline` is a "Learn more" text link, for the end
 * of a sentence, a dialog's description, or a banner's action.
 */
export function DocsLink({
  topic,
  variant = "icon",
}: {
  topic: DocsTopic;
  variant?: "icon" | "inline";
}) {
  const href = docsUrl(topic);
  if (variant === "inline") {
    return (
      <Link href={href} target="_blank" rel="noopener noreferrer">
        Learn more
        <Link.ExternalIcon />
      </Link>
    );
  }
  return (
    <Tooltip
      content={DOCS_LINK_LABEL}
      render={
        <LinkButton
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          variant="ghost"
          size="sm"
          shape="square"
          icon={QuestionIcon}
          aria-label={DOCS_LINK_LABEL}
        />
      }
    />
  );
}
