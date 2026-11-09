// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, renderHook, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMintSshCertificate } from "@/hooks/use-agents";

/**
 * The SSH key picker's "Manage keys": keys are the person's, kept in
 * Settings > Profile, so the link opens that page over the agent (and
 * closing it lands back on the agent), never the old account address, which
 * left the agent for a redirect.
 */

vi.mock("next/navigation", () => ({
  usePathname: () => "/w/ws1/agents/ag1/settings",
  useSearchParams: () => new URLSearchParams(""),
}));

const { SshKeyPicker } = await import("./ssh-key-picker");

afterEach(cleanup);

const KEY = {
  id: "k1",
  name: "laptop",
  fingerprint: "SHA256:x",
  createdAt: "2026-11-01T00:00:00Z",
  lastUsedAt: null,
};

describe("SshKeyPicker", () => {
  it("opens Settings > Profile over the agent from Manage keys", () => {
    const client = new QueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    // The real mint hook (nothing is minted: the test never clicks).
    const { result: mint } = renderHook(() => useMintSshCertificate(), {
      wrapper,
    });
    render(<SshKeyPicker agentId="ag1" keys={[KEY]} mint={mint.current} />, {
      wrapper,
    });
    expect(screen.getByRole("link", { name: "Manage keys" })).toHaveAttribute(
      "href",
      "/w/ws1/agents/ag1/settings?settings=profile",
    );
  });
});
