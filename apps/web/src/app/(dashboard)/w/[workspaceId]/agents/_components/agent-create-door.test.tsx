// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { AgentCreateDoor } from "./agent-create-door";
import type { CreateDoor } from "@/lib/agents/create-door";

// Radix's dropdown needs these in jsdom.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

const onCreateByo = vi.fn();
const onCreateHosted = vi.fn();

beforeEach(() => {
  onCreateByo.mockClear();
  onCreateHosted.mockClear();
});
afterEach(cleanup);

const renderDoor = (door: CreateDoor) =>
  render(
    <AgentCreateDoor
      door={door}
      onCreateByo={onCreateByo}
      onCreateHosted={onCreateHosted}
    />,
  );

describe("AgentCreateDoor", () => {
  it("gives a new user ONE button that creates a hosted agent", async () => {
    renderDoor("hosted");
    // No chevron at all: nothing to choose between, so nothing to open.
    expect(
      screen.queryByRole("button", { name: /more ways to create/i }),
    ).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /new agent/i }));
    expect(onCreateHosted).toHaveBeenCalledTimes(1);
    expect(onCreateByo).not.toHaveBeenCalled();
  });

  it("gives a BYO-only deployment exactly today's single button", async () => {
    renderDoor("byo");
    expect(
      screen.queryByRole("button", { name: /more ways to create/i }),
    ).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: /create agent/i }),
    );
    expect(onCreateByo).toHaveBeenCalledTimes(1);
    expect(onCreateHosted).not.toHaveBeenCalled();
  });

  it("keeps a legacy user's primary click on BYO", async () => {
    renderDoor("byo-with-hosted");
    await userEvent.click(
      screen.getByRole("button", { name: /create agent/i }),
    );
    expect(onCreateByo).toHaveBeenCalledTimes(1);
    expect(onCreateHosted).not.toHaveBeenCalled();
  });

  it("puts hosted one click away, in the chevron", async () => {
    renderDoor("byo-with-hosted");
    await userEvent.click(
      screen.getByRole("button", { name: /more ways to create/i }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /new hosted agent/i }),
    );
    expect(onCreateHosted).toHaveBeenCalledTimes(1);
    expect(onCreateByo).not.toHaveBeenCalled();
  });

  it("keeps the MIXED world's primary on hosted — 'New agent', like the hosted door", async () => {
    renderDoor("hosted-with-byo");
    await userEvent.click(screen.getByRole("button", { name: /new agent/i }));
    expect(onCreateHosted).toHaveBeenCalledTimes(1);
    expect(onCreateByo).not.toHaveBeenCalled();
  });

  it("puts BYO one click away in the MIXED world's chevron", async () => {
    renderDoor("hosted-with-byo");
    await userEvent.click(
      screen.getByRole("button", { name: /more ways to create/i }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /new byo agent/i }),
    );
    expect(onCreateByo).toHaveBeenCalledTimes(1);
    expect(onCreateHosted).not.toHaveBeenCalled();
    // And the OTHER world's menu item is not there — one menu, one path.
    expect(
      screen.queryByRole("menuitem", { name: /new hosted agent/i }),
    ).toBeNull();
  });

  it("lets the host render the primary button, label and shape included", () => {
    // The cloud quota gate composes in here; if the label or the flat edge
    // stopped being handed over, the split control would visibly break.
    const seen: { label: string; className?: string }[] = [];
    render(
      <AgentCreateDoor
        door="byo-with-hosted"
        onCreateByo={onCreateByo}
        onCreateHosted={onCreateHosted}
        renderPrimary={(primary) => {
          seen.push({ label: primary.label, className: primary.className });
          return <button onClick={primary.onClick}>{primary.label}</button>;
        }}
      />,
    );
    expect(seen[0]?.label).toBe("Create agent");
    expect(seen[0]?.className).toContain("rounded-r-none");
  });
});
