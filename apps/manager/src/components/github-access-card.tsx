import {
  Badge,
  Banner,
  Button,
  Checkbox,
  Input,
  LayerDialog,
  Link,
  Loader,
  SensitiveInput,
  Table,
  Text,
} from "@cloudflare/kumo";
import {
  ArrowSquareOutIcon,
  GithubLogoIcon,
  PlusIcon,
  TrashIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useState } from "react";
import {
  addGithubTokenInput,
  deleteTokenDescription,
  type GithubTokenView,
  githubTokenUses,
  newTokenUrl,
  RELEASE_DOWNLOADS_HELP,
  REPOSITORIES_HELP,
  releaseTakeoverNote,
} from "../github/tokens";
import {
  addGithubToken,
  deleteGithubToken,
  type GithubAccessState,
  getGithubAccess,
} from "../github/tokens.functions";
import { ENABLE_SANDBOX_PLACE, UPDATE_SANDBOX_HINT } from "../sandbox/connect-copy";
import { ConfirmDialog } from "./confirm-dialog";
import { DocsLink } from "./docs-link";
import { FieldHelp } from "./field-label";
import { ErrorMessageBanner, MessageText } from "./message-text";
import { Section, SectionBody, SectionEmpty, SectionTable } from "./section";
import { settingsSection } from "./settings-links";
import { Timestamp } from "./timestamp";

/**
 * The Building apps settings' GitHub access section: fine-grained, read-only
 * GitHub tokens for building private repositories and, while Appflare's own
 * releases are private, downloading them. Each token is stored as a secret
 * on the sandbox Worker and never shown again; the list shows its label,
 * what it is used for, and when it was last used. The section loads its own
 * data, so the page only places it.
 */
export function GithubAccessCard({ isAdmin }: { isAdmin: boolean }) {
  // undefined: loading; null: the server says this user is not an admin.
  const [access, setAccess] = useState<GithubAccessState | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setAccess(await getGithubAccess());
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load the tokens.");
    }
  }, []);

  useEffect(() => {
    if (isAdmin) void load();
  }, [isAdmin, load]);

  if (!isAdmin || access === null) return null;
  const state = access ?? null;
  const canAdd = state?.sandboxConnected === true && state.sandboxSupportsTokens === true;

  const addToken =
    state !== null && canAdd ? (
      <AddTokenDialog
        releaseToken={state.tokens.find((t) => t.forReleases) ?? null}
        onAdded={load}
      />
    ) : null;
  const hasTokens = state !== null && state.tokens.length > 0;
  const notice = state === null ? null : accessNotice(state);
  return (
    <Section
      {...settingsSection("building", "github-access")}
      titleAction={<DocsLink topic="githubAccess" />}
      badge={
        state !== null && (
          <Badge variant={hasTokens ? "primary" : "neutral"}>
            {state.tokens.length === 1 ? "1 token" : `${state.tokens.length} tokens`}
          </Badge>
        )
      }
      description="Read-only GitHub tokens for installing from private repositories and for downloading Appflare's own releases. Each token is kept as a secret on the sandbox Worker and is never shown again."
      // With no token yet, the empty state offers it instead.
      action={hasTokens ? addToken : null}
      error={loadError}
    >
      {state === null && loadError === null && (
        <SectionBody>
          <div className="flex items-center gap-2">
            <Loader size="sm" />
            <Text variant="secondary">Loading the tokens…</Text>
          </div>
        </SectionBody>
      )}
      {notice !== null && <SectionBody>{notice}</SectionBody>}
      {state !== null && hasTokens && <TokenTable tokens={state.tokens} onChanged={load} />}
      {state !== null && !hasTokens && state.sandboxConnected && (
        <SectionBody>
          <SectionEmpty
            icon={<GithubLogoIcon size={48} className="text-kumo-inactive" />}
            title="No GitHub access tokens"
            description="Public repositories need none. Add a token to install from a private one."
            contents={addToken ?? undefined}
          />
        </SectionBody>
      )}
    </Section>
  );
}

/** Why tokens cannot be added right now, when that is so; null when they can. */
function accessNotice(state: GithubAccessState): ReactNode {
  if (!state.sandboxConnected) {
    return (
      <Banner
        variant="secondary"
        title="Sandbox builds are off"
        description={
          <MessageText
            message={`Tokens are kept on the sandbox Worker, which also clones the repositories. Enable sandbox builds in ${ENABLE_SANDBOX_PLACE} to add one. Disabling sandbox builds removes every token.`}
          />
        }
      />
    );
  }
  if (state.sandboxSupportsTokens === false) {
    return (
      <Banner
        variant="alert"
        icon={<WarningCircleIcon weight="fill" />}
        title="The sandbox Worker cannot use tokens yet"
        description={<MessageText message={`To update it, ${UPDATE_SANDBOX_HINT}.`} />}
      />
    );
  }
  if (state.sandboxSupportsTokens === null) {
    return (
      <Banner
        variant="alert"
        icon={<WarningCircleIcon weight="fill" />}
        title="The sandbox Worker did not answer"
        description="Tokens can be added once it answers again. Reload the page in a minute."
      />
    );
  }
  return null;
}

function TokenTable({
  tokens,
  onChanged,
}: {
  tokens: readonly GithubTokenView[];
  onChanged: () => Promise<void>;
}) {
  return (
    <SectionTable label="GitHub tokens" stickyFirstColumn>
      <Table.Header>
        <Table.Row>
          <Table.Head>Label</Table.Head>
          <Table.Head>Used for</Table.Head>
          <Table.Head>Last used</Table.Head>
          <Table.Head>
            <span className="sr-only">Actions</span>
          </Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {tokens.map((token) => (
          <Table.Row key={token.id}>
            <Table.Cell>{token.label}</Table.Cell>
            <Table.Cell>
              {/* Narrow enough to wrap beside the label on a phone. */}
              <ul className="grid max-w-44 gap-1 whitespace-normal md:max-w-xs">
                {githubTokenUses(token).map((use) => (
                  <li key={use} className="break-words">
                    {use}
                  </li>
                ))}
              </ul>
            </Table.Cell>
            <Table.Cell>
              <Timestamp iso={token.lastUsedAt} fallback="Never" />
            </Table.Cell>
            <Table.Cell>
              <div className="flex justify-end">
                <DeleteTokenDialog token={token} onDeleted={onChanged} />
              </div>
            </Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </SectionTable>
  );
}

/** The form's two uses of a token, as `Checkbox.Group` values. */
const BUILDS = "builds";
const RELEASES = "releases";

/**
 * Label, the token itself, and what Appflare uses it for: builds of private
 * repositories (optionally naming them) and Appflare release downloads. A
 * link opens GitHub's page for a new fine-grained token filled in with the
 * permissions Appflare needs.
 */
function AddTokenDialog({
  releaseToken,
  onAdded,
}: {
  /** The token now used for release downloads, if there is one. */
  releaseToken: GithubTokenView | null;
  onAdded: () => Promise<void>;
}) {
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [repositories, setRepositories] = useState("");
  const [token, setToken] = useState("");
  const [uses, setUses] = useState<string[]>([BUILDS]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repositoriesError, setRepositoriesError] = useState<string | null>(null);
  const forBuilds = uses.includes(BUILDS);
  const forReleases = uses.includes(RELEASES);

  function reset() {
    setLabel("");
    setRepositories("");
    setToken("");
    setUses([BUILDS]);
    setError(null);
    setRepositoriesError(null);
  }

  function onOpenChange(next: boolean) {
    if (pending) return;
    setOpen(next);
    if (!next) reset();
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = addGithubTokenInput.safeParse({
      label,
      // A description left in the field while builds are unticked is not sent.
      repositories: forBuilds ? repositories : "",
      token,
      forBuilds,
      forReleases,
    });
    if (!parsed.success) {
      // The repositories field shows its own problem; the banner any other.
      const issues = parsed.error.issues;
      const onRepositories = issues.find((issue) => issue.path[0] === "repositories");
      const other = issues.find((issue) => issue !== onRepositories);
      setRepositoriesError(onRepositories?.message ?? null);
      setError(other?.message ?? null);
      return;
    }
    setPending(true);
    setError(null);
    setRepositoriesError(null);
    try {
      await addGithubToken({ data: parsed.data });
      // The value leaves the browser's memory with the form.
      setOpen(false);
      reset();
      await onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add the token.");
    } finally {
      setPending(false);
    }
  }

  return (
    <LayerDialog.Root open={open} onOpenChange={onOpenChange} dismissDisabled={pending}>
      <LayerDialog.Trigger
        render={(p) => (
          <Button {...p} variant="primary" icon={<PlusIcon />}>
            Add token
          </Button>
        )}
      />
      <LayerDialog.Content size="lg">
        <LayerDialog.Title>Add a GitHub access token</LayerDialog.Title>
        <LayerDialog.Description>
          Create a fine-grained personal access token on GitHub with{" "}
          <strong className="font-medium text-kumo-default">Contents: Read-only</strong> on the
          repositories it is for (GitHub adds{" "}
          <strong className="font-medium text-kumo-default">Metadata: Read-only</strong> itself),
          and nothing else.{" "}
          <Link
            href={newTokenUrl(label, repositories, { forBuilds, forReleases })}
            target="_blank"
            rel="noopener noreferrer"
          >
            Create it on GitHub
            <ArrowSquareOutIcon className="ml-1 inline" aria-hidden />
          </Link>
        </LayerDialog.Description>
        <LayerDialog.Body>
          <form id={formId} className="grid gap-4" onSubmit={onSubmit}>
            <Input
              label="Label"
              placeholder="Acme private apps"
              value={label}
              onChange={(e) => setLabel(e.currentTarget.value)}
              autoComplete="off"
              maxLength={100}
              required
              disabled={pending}
            />
            <SensitiveInput
              label="Token"
              description="Stored on the sandbox Worker as a secret. Appflare cannot show it again."
              value={token}
              onValueChange={(next: string) => setToken(next)}
              autoComplete="off"
              disabled={pending}
            />
            <Checkbox.Group
              legend="Use it for"
              value={uses}
              onValueChange={(next: string[]) => setUses(next)}
              disabled={pending}
            >
              <div className="grid gap-3">
                <Checkbox.Item value={BUILDS} label="Builds of private repositories" />
                {forBuilds && (
                  <div className="pl-6">
                    <Input
                      label="Repositories"
                      required={false}
                      description={<FieldHelp text={REPOSITORIES_HELP} />}
                      placeholder="acme/api, acme/*"
                      value={repositories}
                      onChange={(e) => {
                        setRepositories(e.currentTarget.value);
                        setRepositoriesError(null);
                      }}
                      error={repositoriesError ?? undefined}
                      autoComplete="off"
                      maxLength={500}
                      disabled={pending}
                    />
                  </div>
                )}
              </div>
              <div className="grid gap-1">
                <Checkbox.Item value={RELEASES} label="Appflare release downloads" />
                <div className="grid gap-1 pl-6">
                  <Text as="p" variant="secondary" size="sm">
                    <FieldHelp text={RELEASE_DOWNLOADS_HELP} />
                  </Text>
                  {forReleases && releaseToken !== null && (
                    <Text as="p" variant="secondary" size="sm">
                      {releaseTakeoverNote(releaseToken)}
                    </Text>
                  )}
                </div>
              </div>
            </Checkbox.Group>
            {error !== null && <ErrorMessageBanner message={error} newTab />}
          </form>
        </LayerDialog.Body>
        <LayerDialog.Actions dismissLabel="Cancel">
          <LayerDialog.Actions.Primary type="submit" form={formId} loading={pending}>
            Add token
          </LayerDialog.Actions.Primary>
        </LayerDialog.Actions>
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
}

function DeleteTokenDialog({
  token,
  onDeleted,
}: {
  token: GithubTokenView;
  onDeleted: () => Promise<void>;
}) {
  return (
    <ConfirmDialog
      trigger={(p) => (
        <Button
          {...p}
          variant="secondary-destructive"
          size="sm"
          icon={<TrashIcon />}
          aria-label={`Delete ${token.label}`}
        >
          Delete
        </Button>
      )}
      title={`Delete ${token.label}`}
      description={deleteTokenDescription(token)}
      actionLabel="Delete token"
      onConfirm={async () => {
        await deleteGithubToken({ data: { id: token.id } });
        await onDeleted();
      }}
    />
  );
}
