import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACCOUNT_PLAN_COPY } from "../account/plan";
import { externalDomainsInUse } from "../gateway/gateway";
import { MessageText } from "./message-text";
import { WorkersPaidConfirmation } from "./workers-paid-confirmation";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function links(): Array<{ text: string; href: string | null; target: string | null }> {
  return [...container.querySelectorAll("a")].map((a) => ({
    text: a.textContent ?? "",
    href: a.getAttribute("href"),
    target: a.getAttribute("target"),
  }));
}

describe("messages that name a place render it as a link", () => {
  it("links each external domain that keeps the gateway on to its app's external domains", () => {
    const message = externalDomainsInUse([
      { hostname: "shop.example.com", installId: "01J9ZQ7K3M" },
      { hostname: "blog.example.com", installId: "01J9ZQ7K4N" },
    ]);
    act(() => root.render(<MessageText message={message} />));
    expect(container.textContent).toBe(
      "Apps still use external domains (shop.example.com, blog.example.com). Remove them from each app's page first.",
    );
    expect(links()).toEqual([
      { text: "shop.example.com", href: "/apps/01J9ZQ7K3M#external-domains", target: null },
      { text: "blog.example.com", href: "/apps/01J9ZQ7K4N#external-domains", target: null },
    ]);
  });

  it("links “Remember this for the account” to the plan's row on Your account, in a new tab", () => {
    act(() =>
      root.render(
        <WorkersPaidConfirmation
          state={{ checked: true, onChange: () => {}, remember: false, onRememberChange: () => {} }}
        />,
      ),
    );
    expect(container.textContent).toContain(ACCOUNT_PLAN_COPY.remember);
    expect(container.textContent).toContain(
      "Records Workers Paid as the Workers plan on Your account,",
    );
    expect(container.textContent).not.toContain("](");
    expect(links()).toEqual([
      {
        text: "Workers plan on Your account",
        href: "/settings/account#capability-workers-plan",
        target: "_blank",
      },
    ]);
  });
});
