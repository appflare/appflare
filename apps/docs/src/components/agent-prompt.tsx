import { useEffect, useState } from "react";
import { track } from "../analytics/analytics.ts";
import { type AgentPromptKind, agentPrompt } from "../lib/agent-prompts.ts";

/** How long the button says "Copied" after a copy. */
const COPIED_MS = 2000;

type CopyState = "idle" | "copied" | "failed";

/**
 * One quiet line: a lead-in and a button that copies a short prompt for a
 * coding agent. The prompt points the agent at the full instructions on this
 * site, so nothing long is pasted. Where the clipboard is refused, the prompt
 * is shown to be selected by hand.
 */
export function AgentPrompt({
  kind,
  label = "Or set it up with an agent:",
  align = "start",
}: {
  kind: AgentPromptKind;
  label?: string;
  align?: "start" | "center";
}) {
  const prompt = agentPrompt(kind);
  const [state, setState] = useState<CopyState>("idle");

  useEffect(() => {
    if (state !== "copied") return;
    const timer = setTimeout(() => setState("idle"), COPIED_MS);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt);
      setState("copied");
      track("agent_prompt_copied", { page: window.location.pathname });
    } catch {
      setState("failed");
    }
  }

  return (
    // In a docs page (`start`) it keeps the space of a paragraph; centred, it sits in the hero's own gaps.
    <div
      className={`not-prose grid gap-2 text-fd-muted-foreground text-sm ${align === "center" ? "justify-items-center" : "my-4"}`}
    >
      <p
        className={`m-0 flex flex-wrap items-center gap-x-2 gap-y-1 ${align === "center" ? "justify-center" : ""}`}
      >
        <span>{label}</span>
        <button
          type="button"
          onClick={() => void copy()}
          title={prompt}
          className="inline-flex items-center gap-1.5 rounded-md border border-fd-border bg-fd-background px-2 py-0.5 font-medium text-fd-foreground transition-colors hover:bg-fd-accent focus-visible:outline-2 focus-visible:outline-fd-ring focus-visible:outline-offset-2"
        >
          {state === "copied" ? <CheckIcon /> : <CopyIcon />}
          {state === "copied" ? "Copied" : "Copy prompt"}
        </button>
        <span role="status" className="sr-only">
          {state === "copied" ? "Prompt copied" : ""}
        </span>
      </p>
      {state === "failed" && (
        <p className="m-0 select-all rounded-md border border-fd-border bg-fd-secondary px-3 py-2 text-left font-mono text-fd-foreground text-xs">
          {prompt}
        </p>
      )}
    </div>
  );
}

function CopyIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
    >
      <rect x="5.25" y="5.25" width="8" height="8" rx="1.5" />
      <path d="M10.75 5.25v-1.5a1.5 1.5 0 0 0-1.5-1.5h-5a1.5 1.5 0 0 0-1.5 1.5v5a1.5 1.5 0 0 0 1.5 1.5h1.5" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m3.5 8.5 3 3 6-7" />
    </svg>
  );
}
