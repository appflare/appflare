import type { CatalogSecret } from "@appflare/schema";
import { TooltipProvider } from "@cloudflare/kumo";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InstallVarField } from "../installs/install-vars";
import { fieldDescription } from "./field-label";
import { SecretFields } from "./secret-fields";
import { VarField } from "./var-field";

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

function render(node: ReactNode) {
  act(() => root.render(<TooltipProvider>{node}</TooltipProvider>));
}

const keyLink = { label: "Get a key", url: "https://openrouter.ai/settings/keys" };

function secret(fields: Partial<CatalogSecret>): CatalogSecret {
  return {
    name: "OPENROUTER_API_KEY",
    label: "OpenRouter API key",
    optional: false,
    seedOnly: false,
    multiline: false,
    cloudflareToken: false,
    ...fields,
  };
}

/** The links in the rendered form, as their text and attributes. */
function links() {
  return [...container.querySelectorAll("a")].map((a) => ({
    text: a.textContent,
    href: a.getAttribute("href"),
    target: a.getAttribute("target"),
    rel: a.getAttribute("rel"),
  }));
}

const opened = {
  text: "Get a key",
  href: keyLink.url,
  target: "_blank",
  rel: "noopener noreferrer",
};

describe("a catalog field's link", () => {
  it("follows a secret's help and opens in a new tab without a referrer", () => {
    render(
      <SecretFields
        secrets={[secret({ help: "Your OpenRouter key.", link: keyLink })]}
        values={{ OPENROUTER_API_KEY: "" }}
        onChange={() => {}}
        after="the install"
      />,
    );
    expect(links()).toEqual([opened]);
    expect(container.textContent).toContain("Your OpenRouter key.");
  });

  it("shows beside an optional secret before it is set, once", () => {
    render(
      <SecretFields
        secrets={[secret({ optional: true, link: keyLink })]}
        values={{}}
        onChange={() => {}}
        after="the install"
      />,
    );
    expect(links()).toEqual([opened]);
    render(
      <SecretFields
        secrets={[secret({ optional: true, link: keyLink })]}
        values={{ OPENROUTER_API_KEY: "" }}
        onChange={() => {}}
        after="the install"
      />,
    );
    expect(links()).toEqual([opened]);
  });

  it("follows a setting's help, and stands alone without help", () => {
    const field: InstallVarField = {
      name: "DATAFORSEO_LOGIN",
      label: "DataForSEO login",
      link: { label: "Find your login", url: "https://app.dataforseo.com/api-access" },
      required: true,
      kind: "text",
      shownDefault: "",
      options: null,
    };
    render(<VarField field={field} value="" onChange={() => {}} />);
    expect(links()).toEqual([
      {
        text: "Find your login",
        href: "https://app.dataforseo.com/api-access",
        target: "_blank",
        rel: "noopener noreferrer",
      },
    ]);
    render(
      <VarField
        field={{ ...field, help: "The login of your API access." }}
        value=""
        onChange={() => {}}
      />,
    );
    expect(container.textContent).toContain("The login of your API access.");
    expect(links()).toHaveLength(1);
  });

  it("shows on a setting Appflare works out itself", () => {
    const field: InstallVarField = {
      name: "VAPID_PUBLIC_KEY",
      label: "Push public key",
      link: { label: "About push keys", url: "https://example.com/push" },
      required: true,
      kind: "text",
      shownDefault: "",
      options: null,
      derivedFrom: "VAPID_PRIVATE_KEY",
    };
    render(<VarField field={field} value="" onChange={() => {}} />);
    expect(container.textContent).toContain("Appflare sets it for you.");
    expect(links()).toEqual([
      {
        text: "About push keys",
        href: "https://example.com/push",
        target: "_blank",
        rel: "noopener noreferrer",
      },
    ]);
  });

  it("keeps a field without a link as it was", () => {
    render(<p>{fieldDescription({ help: "Plain help, [not](https://a.example) a link." })}</p>);
    expect(links()).toEqual([]);
    expect(fieldDescription({})).toBeUndefined();
    expect(fieldDescription({ note: "A note." })).toBe("A note.");
  });
});
