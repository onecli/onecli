// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { user } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import { WorkspaceApiKeyCard } from "./workspace-api-key-card";

/**
 * The personal key page reads and rotates through `/v1/user/api-key` (the
 * typed client, never a server action), and a rotation refreshes Install,
 * whose sign-in command embeds the same key.
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    user: {
      ...actual.user,
      apiKey: vi.fn(),
      regenerateApiKey: vi.fn(),
    },
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const OLD_KEY = "oc_old0000000000000000000000000000000000000000000000001111";
const NEW_KEY = "oc_new0000000000000000000000000000000000000000000000002222";

const renderCard = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  render(
    <QueryClientProvider client={queryClient}>
      <WorkspaceApiKeyCard />
    </QueryClientProvider>,
  );
  return { invalidate };
};

beforeEach(() => {
  vi.mocked(user.apiKey).mockReset().mockResolvedValue({ apiKey: OLD_KEY });
  vi.mocked(user.regenerateApiKey)
    .mockReset()
    .mockResolvedValue({ apiKey: NEW_KEY });
});
afterEach(cleanup);

describe("WorkspaceApiKeyCard", () => {
  it("shows the key masked, and reveals it on request", async () => {
    renderCard();
    expect(await screen.findByText(/^oc_old•+1111$/)).toBeInTheDocument();
    expect(screen.queryByText(OLD_KEY)).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Reveal API key" }),
    );
    expect(screen.getByText(OLD_KEY)).toBeInTheDocument();
  });

  it("says so when the key cannot be read, with every action disabled", async () => {
    vi.mocked(user.apiKey).mockRejectedValue(new Error("boom"));
    renderCard();
    expect(
      await screen.findByText(/Couldn.t load your API key/),
    ).toBeInTheDocument();
    for (const name of ["Reveal API key", "Copy API key", "Regenerate API key"])
      expect(screen.getByRole("button", { name })).toBeDisabled();
  });

  it("rotates through the API, shows the new key, and refreshes Install", async () => {
    const { invalidate } = renderCard();
    await screen.findByText(/^oc_old/);
    await userEvent.click(
      screen.getByRole("button", { name: "Regenerate API key" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    await waitFor(() => expect(screen.getByText(NEW_KEY)).toBeInTheDocument());
    expect(user.regenerateApiKey).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.installInfo.all(),
    });
  });
});
