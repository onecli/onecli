// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The one behavior worth pinning here is the federated callback: an invited
 * signup passes its token-bearing page URL through `signIn`, and everyone
 * else keeps landing on the dashboard origin. Reverting the pass-through to
 * a hardcoded origin would leave every screen test green while silently
 * breaking the invited-Google join.
 */

const social = vi.fn();

vi.mock("@/lib/auth/auth-client", () => ({
  createOnpremAuthClient: () => ({
    useSession: () => ({ data: null, isPending: false }),
    signIn: { social, email: vi.fn() },
    signUp: { email: vi.fn() },
    signOut: vi.fn(),
  }),
}));

import { useAuth } from "@/providers/auth-provider";
import { OnpremAuthProvider } from "./auth-provider-onprem";

const Probe = () => {
  const { signIn } = useAuth();
  return (
    <>
      <button
        onClick={() =>
          signIn({ callbackURL: "http://localhost/auth/signup?token=tok-1" })
        }
      >
        invited
      </button>
      <button onClick={() => signIn()}>plain</button>
    </>
  );
};

beforeEach(() => {
  social.mockReset().mockResolvedValue(undefined);
});

afterEach(cleanup);

describe("self-hosted auth provider — federated callback", () => {
  it("passes an invited signup's token-bearing URL through to the provider", async () => {
    const user = userEvent.setup();
    render(
      <OnpremAuthProvider>
        <Probe />
      </OnpremAuthProvider>,
    );

    await user.click(screen.getByRole("button", { name: "invited" }));

    expect(social).toHaveBeenCalledWith({
      provider: "google",
      callbackURL: "http://localhost/auth/signup?token=tok-1",
    });
  });

  it("defaults everyone else to the dashboard origin", async () => {
    const user = userEvent.setup();
    render(
      <OnpremAuthProvider>
        <Probe />
      </OnpremAuthProvider>,
    );

    await user.click(screen.getByRole("button", { name: "plain" }));

    expect(social).toHaveBeenCalledWith({
      provider: "google",
      callbackURL: window.location.origin,
    });
  });
});
