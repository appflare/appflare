import { Badge, Empty, LayerDialog, Link, Text } from "@cloudflare/kumo";
import { SparkleIcon } from "@phosphor-icons/react";
import ReactMarkdown, { type Components } from "react-markdown";
import { compareVersions } from "../catalog/versions";
import { markdownComponents, markdownPlugins } from "../components/markdown";
import { Timestamp } from "../components/timestamp";
import { isUnread, type ReleaseNote } from "./release-notes";

/**
 * Release notes use the manager's Markdown typography, with their section
 * headings ("Minor Changes") set below the release's own title. Raw HTML is
 * dropped and images are not loaded: the notes come from GitHub, and the
 * browser never fetches anything from there on its own.
 */
const releaseComponents: Components = {
  ...markdownComponents,
  h1: ({ children }) => (
    <Text as="h4" bold>
      {children}
    </Text>
  ),
  h2: ({ children }) => (
    <Text as="h4" bold>
      {children}
    </Text>
  ),
  h3: ({ children }) => (
    <Text as="h4" bold>
      {children}
    </Text>
  ),
  h4: ({ children }) => (
    <Text as="h5" bold>
      {children}
    </Text>
  ),
};

function ReleaseBody({ children }: { children: string }) {
  if (children.trim().length === 0) {
    return <Text variant="secondary">No notes for this release.</Text>;
  }
  return (
    <div className="grid gap-3">
      <ReactMarkdown
        skipHtml
        remarkPlugins={markdownPlugins}
        disallowedElements={["img"]}
        unwrapDisallowed
        components={releaseComponents}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

function Release({
  note,
  current,
  unread,
}: {
  note: ReleaseNote;
  current: string;
  unread: boolean;
}) {
  const order = compareVersions(note.version, current);
  return (
    <article className="grid gap-3" aria-labelledby={`release-${note.version}`}>
      <div className="grid gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Text variant="heading" as="h3">
            <span id={`release-${note.version}`}>{note.name}</span>
          </Text>
          {unread && <Badge variant="primary">New</Badge>}
          {order === 0 && <Badge variant="neutral">Running here</Badge>}
          {order !== null && order > 0 && <Badge variant="outline">Not installed yet</Badge>}
        </div>
        <Text size="sm" variant="secondary">
          {note.publishedAt !== null && (
            <>
              <Timestamp iso={note.publishedAt} dateOnly />
              {" · "}
            </>
          )}
          <Link href={note.url} target="_blank" rel="noopener noreferrer">
            View on GitHub
            <Link.ExternalIcon />
          </Link>
        </Text>
      </div>
      <ReleaseBody>{note.body}</ReleaseBody>
    </article>
  );
}

/**
 * "What's new": Appflare's latest releases, newest first, each with its
 * notes. Releases the viewer had not seen when they opened it are marked
 * "New"; the running version and releases not installed yet are labelled.
 */
export function WhatsNewDialog({
  open,
  onOpenChange,
  current,
  releases,
  seenBefore,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  current: string;
  releases: readonly ReleaseNote[];
  /** What the viewer had seen before this opening, for the "New" badges. */
  seenBefore: string | null;
}) {
  return (
    <LayerDialog.Root open={open} onOpenChange={onOpenChange}>
      <LayerDialog.Content size="lg" verticalAlign="top">
        <LayerDialog.Title>What's new</LayerDialog.Title>
        <LayerDialog.Description>
          The latest Appflare releases. This manager runs Appflare {current}.
        </LayerDialog.Description>
        <LayerDialog.Body>
          {releases.length === 0 ? (
            <Empty
              size="sm"
              icon={<SparkleIcon size={32} className="text-kumo-inactive" />}
              title="No release notes yet"
              description="Appflare reads its releases every 30 minutes. Check back soon."
            />
          ) : (
            <div className="grid gap-8">
              {releases.map((note) => (
                <Release
                  key={note.tag}
                  note={note}
                  current={current}
                  unread={isUnread(note, seenBefore, current)}
                />
              ))}
            </div>
          )}
        </LayerDialog.Body>
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
}
