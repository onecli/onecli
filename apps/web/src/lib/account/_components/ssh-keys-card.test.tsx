// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SshKey } from "@/lib/api";

/**
 * Deleting a key is instant: confirming fires the delete and closes the
 * confirm in the same click, never holding the dialog open on a spinner
 * while the request runs. The hook (tested with the toolkit) owns the
 * optimistic remove and the rollback.
 */

const state = vi.hoisted(() => ({
  keys: [] as SshKey[],
  remove: vi.fn(),
}));

vi.mock("@/hooks/use-instance", () => ({
  useInstance: () => ({ ssh: { host: "localhost", port: 10257 } }),
}));

vi.mock("@/hooks/use-ssh-keys", () => ({
  useSshKeys: () => ({ data: state.keys, isPending: false, isError: false }),
  // Pending on purpose: the confirm must not wait on it.
  useDeleteSshKey: () => ({ mutate: state.remove, isPending: true }),
  useCreateSshKey: () => ({ mutate: vi.fn(), isPending: false }),
}));

const { SshKeysCard } = await import("./ssh-keys-card");

afterEach(() => {
  cleanup();
  state.remove.mockReset();
});

describe("SshKeysCard delete", () => {
  it("fires the delete and closes the confirm in one click", async () => {
    state.keys = [
      {
        id: "key-1",
        name: "laptop",
        fingerprint: "SHA256:abc",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastUsedAt: null,
      },
    ];
    render(<SshKeysCard />);

    await userEvent.click(
      screen.getByRole("button", { name: "Delete key laptop" }),
    );
    const confirm = screen.getByRole("button", { name: "Delete key" });
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);

    expect(state.remove).toHaveBeenCalledWith("key-1");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
