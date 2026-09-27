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
import { addGithubTokenInput, type GithubTokenView, newTokenUrl } from "../github/tokens";
import {
  addGithubToken,
  deleteGithubToken,
  type GithubAccessState,
  getGithubAccess,
} from "../github/tokens.functions";
import { ENABLE_SANDBOX_PLACE, UPDATE_SANDBOX_HINT } from "../sandbox/connect-copy";
import { ConfirmDialog } from "./confirm-dialog";
import { DocsLink } from "./docs-link";
import { ErrorMessageBanner, MessageText } from "./message-text";
import { Section, SectionBody, SectionEmpty, SectionTable } from "./section";
import { settingsSection } from "./settings-links";
import { Timestamp } from "./timestamp";

/**
 * The Building apps settings' GitHub access section: fine-grained, read-only
 * GitHub tokens for installing from private repositories (and, while
 * Appflare's own releases are private, reading them). Each token is stored
 * as a secret on the sandbox Worker and never shown again; the list shows
 * its label, the repositories the admin says it covers, and when it was
 * last used. The section loads its own data, so the page only places it.
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
      <AddTokenDialog hasReleaseToken={state.tokens.some((t) => t.forReleases)} onAdded={load} />
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
      description="Install from private GitHub repositories with fine-grained, read-only tokens. Each token is kept as a secret on the sandbox Worker and is never shown again."
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
          <Table.Head>Repositories</Table.Head>
          <Table.Head>Last used</Table.Head>
          <Table.Head>
            <span className="sr-only">Actions</span>
          </Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {tokens.map((token) => (
          <Table.Row key={token.id}>
            <Table.Cell>
              <span className="flex flex-wrap items-center gap-2">
                {token.label}
                {token.forReleases && <Badge variant="info">Release downloads</Badge>}
              </span>
            </Table.Cell>
            <Table.Cell>
              <span className="break-words">{token.repositories}</span>
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

/**
 * Label, repositories and the token itself, with a link to GitHub's page for
 * a new fine-grained token filled in with the permissions Appflare needs.
 */
function AddTokenDialog({
  hasReleaseToken,
  onAdded,
}: {
  hasReleaseToken: boolean;
  onAdded: () => Promise<void>;
}) {
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [repositories, setRepositories] = useState("");
  const [token, setToken] = useState("");
  const [forReleases, setForReleases] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setLabel("");
    setRepositories("");
    setToken("");
    setForReleases(false);
    setError(null);
  }

  function onOpenChange(next: boolean) {
    if (pending) return;
    setOpen(next);
    if (!next) reset();
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = addGithubTokenInput.safeParse({ label, repositories, token, forReleases });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the fields.");
      return;
    }
    setPending(true);
    setError(null);
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
          repositories to install (GitHub adds{" "}
          <strong className="font-medium text-kumo-default">Metadata: Read-only</strong> itself),
          and nothing else.{" "}
          <Link href={newTokenUrl(label, repositories)} target="_blank" rel="noopener noreferrer">
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
            <Input
              label="Repositories"
              description="The repositories it can read, as you chose them on GitHub: owner/repo, or owner/* for all of an owner's. Appflare tries the token that names a repository first."
              placeholder="acme/api, acme/*"
              value={repositories}
              onChange={(e) => setRepositories(e.currentTarget.value)}
              autoComplete="off"
              maxLength={500}
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
            <Checkbox
              checked={forReleases}
              onCheckedChange={(v: boolean) => setForReleases(v)}
              disabled={pending}
              label={
                hasReleaseToken
                  ? "Use for Appflare release downloads instead of the current one"
                  : "Use for Appflare release downloads"
              }
            />
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
      description={
        token.forReleases
          ? "Appflare deletes the token from the sandbox Worker. Apps already installed keep running, but they cannot be rebuilt from a private repository it covered, and release downloads fall back to the GITHUB_TOKEN secret, if Appflare has one. Revoke the token on GitHub as well."
          : "Appflare deletes the token from the sandbox Worker. Apps already installed keep running, but they cannot be rebuilt from a private repository only it covered. Revoke the token on GitHub as well."
      }
      actionLabel="Delete token"
      onConfirm={async () => {
        await deleteGithubToken({ data: { id: token.id } });
        await onDeleted();
      }}
    />
  );
}
