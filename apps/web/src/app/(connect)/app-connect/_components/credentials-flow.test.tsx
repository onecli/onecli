// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CredentialsFlow } from "./credentials-flow";

vi.mock("@/lib/api-fetch", () => ({
  apiFetch: vi.fn(),
}));

const app = {
  id: "circleback",
  name: "Circleback",
  icon: "/icons/circleback.svg",
  connectionType: "api_key",
};

const field = {
  name: "apiKey",
  label: "API key",
  description: "Create one in Circleback under Settings → API keys.",
  placeholder: "cb_...",
  secret: true,
  helpUrl: "https://circleback.ai/settings?tab=api-access",
  helpLabel: "Get your API key",
};

const renderFlow = (overrides: Partial<typeof app & { docsUrl: string }>) =>
  render(
    <CredentialsFlow
      app={{ ...app, ...overrides }}
      fields={[field]}
      onSuccess={vi.fn()}
      onError={vi.fn()}
    />,
  );

describe("CredentialsFlow setup guide", () => {
  it("links OneCLI's setup guide above the fields, in a new tab", () => {
    const url = "https://onecli.sh/docs/integrations/circleback";
    renderFlow({ docsUrl: url });
    const guide = screen.getByRole("link", { name: /View guide/ });
    expect(guide.getAttribute("href")).toBe(url);
    expect(guide.getAttribute("target")).toBe("_blank");
    expect(guide.getAttribute("rel")).toBe("noopener noreferrer");
    expect(guide.textContent).toContain(
      "Step-by-step guide to connect Circleback",
    );
    // Above the field: the guide comes before the API key input in the DOM.
    const input = screen.getByPlaceholderText("cb_...");
    expect(
      guide.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  // The banner is the only bare <a> in the form that is not inline text, so
  // it carries the shared keyboard focus ring itself, and its "opens
  // elsewhere" cue is the same lucide icon the connect dialog's setup-guide
  // link uses, hidden from assistive tech, not a glyph in the label.
  it("marks the guide as external with an icon and keeps a focus ring", () => {
    renderFlow({ docsUrl: "https://onecli.sh/docs/integrations/circleback" });
    const guide = screen.getByRole("link", { name: /View guide/ });
    const icon = guide.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(guide.textContent).not.toContain("→");
    expect(guide.className).toMatch(/focus-visible:ring-/);
  });

  it("shows no guide when the app has no docs page", () => {
    renderFlow({});
    expect(screen.queryByRole("link", { name: /View guide/ })).toBeNull();
  });

  // The hint and the provider's help link read as one line, not two.
  it("puts the field hint and its help link on one line", () => {
    renderFlow({});
    const help = screen.getByRole("link", { name: "Get your API key" });
    expect(help.getAttribute("href")).toBe(field.helpUrl);
    expect(help.parentElement?.textContent).toBe(
      `${field.description} ${field.helpLabel}`,
    );
  });
});
