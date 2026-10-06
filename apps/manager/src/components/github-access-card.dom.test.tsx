import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GithubAccessState } from "../github/tokens.functions";
import { ENABLE_SANDBOX_PLACE } from "../sandbox/connect-copy";
import { plainMessage } from "./message-links";

/**
 * Settings, Building apps, the GitHub access section, with the server
 * functions standing in: nothing here touches an account.
 */
const calls = vi.hoisted(() => ({
  getGithubAccess: vi.fn(async (): Promise<GithubAccessState | null> => null),
}));
vi.mock("../github/tokens.functions", () => ({
  getGithubAccess: calls.getGithubAccess,
  addGithubToken: vi.fn(),
  deleteGithubToken: vi.fn(),
}));

const { GithubAccessCard } = await import("./github-access-card");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  calls.getGithubAccess.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

async function show(state: GithubAccessState) {
  calls.getGithubAccess.mockResolvedValue(state);
  await act(async () => root.render(<GithubAccessCard isAdmin={true} />));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
}

function page(): string {
  return document.body.textContent ?? "";
}

/** Links to the Building apps settings, the page this section is on. */
function linksToItsOwnPage(): string[] {
  return [...document.querySelectorAll("a")]
    .map((a) => a.getAttribute("href") ?? "")
    .filter((href) => href.startsWith("/settings/building"));
}

describe("GithubAccessCard", () => {
  it("points up at the sandbox builds section when they are off, without linking to its own page", async () => {
    await show({ tokens: [], sandboxConnected: false, sandboxSupportsTokens: null });
    expect(page()).toContain("Sandbox builds are off");
    expect(page()).toContain(
      "Tokens are kept on the sandbox Worker, which also clones the repositories. Enable sandbox builds above to add one.",
    );
    expect(page()).not.toContain("the Building apps settings");
    expect(linksToItsOwnPage()).toEqual([]);
  });

  it("points up at Update sandbox when the sandbox Worker cannot use tokens", async () => {
    await show({ tokens: [], sandboxConnected: true, sandboxSupportsTokens: false });
    expect(page()).toContain("To update it, choose Update sandbox above.");
    expect(linksToItsOwnPage()).toEqual([]);
  });

  it("leaves the link in the same message shown on other pages", () => {
    expect(ENABLE_SANDBOX_PLACE).toBe("[the Building apps settings](/settings/building#sandbox)");
    expect(plainMessage(`Enable sandbox builds in ${ENABLE_SANDBOX_PLACE} first.`)).toBe(
      "Enable sandbox builds in the Building apps settings first.",
    );
  });
});
