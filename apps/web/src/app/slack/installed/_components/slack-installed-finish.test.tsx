// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ── /slack/installed, the finish step — a SECURITY pin ──────────────────────
//
// Binding on mount would be OAuth login CSRF: the authorization code rides the
// URL, so an attacker who installs OneCLI into THEIR OWN Slack workspace can
// mail an admin `/slack/installed?code=<their code>` and, if the page spends
// it automatically, silently bind the attacker's workspace to the victim's
// organization. The onboarding bot would then mint invitations into that org
// for anyone DMing it from the attacker's workspace.
//
// The dashboard flow is immune (its signed `state` names the org); this path
// has no state by construction, so the explicit click IS the control — and a
// click is only informed consent if it can name BOTH ends. Hence two steps:
// mount INSPECTS (exchanges the code, binds nothing, names the workspace),
// and only the confirmed claim binds. These tests fail if anyone
// reintroduces auto-binding or drops the workspace naming.

const state = vi.hoisted(() => ({
  inspectCalls: [] as {
    provider: string;
    code: string;
    organizationId: string;
  }[],
  inspectFail: null as string | null,
  finishCalls: [] as {
    provider: string;
    claim: string;
    organizationId: string;
  }[],
  fail: null as string | null,
  replaced: [] as string[],
}));

vi.mock("@/hooks/use-org-channels", async () => {
  const { useState } = await import("react");
  return {
    useInspectSharedInstall: () => {
      const [result, setResult] = useState<
        | { team: { externalId: string; name: string | null }; claim: string }
        | Error
        | null
      >(null);
      return {
        mutate: (vars: {
          provider: string;
          code: string;
          organizationId: string;
        }) => {
          state.inspectCalls.push(vars);
          setResult(
            state.inspectFail
              ? new Error(state.inspectFail)
              : {
                  team: { externalId: "T123", name: "Attacker Space" },
                  claim: "sealed-claim-1",
                },
          );
        },
        data: result instanceof Error || result === null ? undefined : result,
        isError: result instanceof Error,
        error: result instanceof Error ? result : null,
        isPending: false,
      };
    },
    useFinishSharedInstall: () => ({
      isPending: false,
      mutate: (
        vars: { provider: string; claim: string; organizationId: string },
        opts: {
          onSuccess: (r: { organizationId: string }) => void;
          onError: (e: Error) => void;
        },
      ) => {
        state.finishCalls.push(vars);
        if (state.fail) opts.onError(new Error(state.fail));
        else opts.onSuccess({ organizationId: vars.organizationId });
      },
    }),
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: (u: string) => state.replaced.push(u) }),
}));

import { SlackInstalledFinish } from "./slack-installed-finish";

const ORG = { id: "org-1", name: "Acme Corp" };

afterEach(() => {
  state.inspectCalls = [];
  state.inspectFail = null;
  state.finishCalls = [];
  state.fail = null;
  state.replaced = [];
  cleanup();
});

describe("SlackInstalledFinish (login-CSRF control)", () => {
  it("BINDS NOTHING on mount — inspect fires exactly once and only names the workspace", async () => {
    render(<SlackInstalledFinish code="attacker-code" organization={ORG} />);
    // Give any stray effect a chance to fire before asserting the negative.
    await new Promise((r) => setTimeout(r, 50));
    // The inspect exchanged the code (it must: the workspace name lives
    // inside it) — but the BIND never ran, and the single-use code was
    // spent exactly once even across re-renders.
    expect(state.inspectCalls).toEqual([
      { provider: "slack", code: "attacker-code", organizationId: "org-1" },
    ]);
    expect(state.finishCalls).toHaveLength(0);
    expect(state.replaced).toHaveLength(0);
    // The user is actually asked — and BOTH ends are NAMED, so the consent
    // is informed: the source workspace and the destination org.
    expect(
      screen.getByRole("button", { name: "Connect Slack" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Attacker Space")).toBeInTheDocument();
    expect(screen.getByText("Acme Corp")).toBeInTheDocument();
  });

  it("binds only on the explicit click — with the inspected CLAIM, never the raw code", async () => {
    const user = userEvent.setup();
    render(<SlackInstalledFinish code="real-code" organization={ORG} />);

    await user.click(
      await screen.findByRole("button", { name: "Connect Slack" }),
    );

    // The org travels explicitly: /slack/installed carries no org in its URL
    // for the API client to derive a scope header from.
    expect(state.finishCalls).toEqual([
      { provider: "slack", claim: "sealed-claim-1", organizationId: "org-1" },
    ]);
    await waitFor(() =>
      expect(state.replaced).toEqual(["/org/org-1/channels?connected=slack"]),
    );
  });

  it("Cancel binds nothing and leaves the page", async () => {
    const user = userEvent.setup();
    render(
      <SlackInstalledFinish
        code="unwanted"
        organization={{ id: "org-9", name: "Elsewhere" }}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(state.finishCalls).toHaveLength(0);
    expect(state.replaced).toEqual(["/org/org-9/channels"]);
  });

  it("an org-less account gets guidance — and the code is NOT burned", async () => {
    render(<SlackInstalledFinish code="unspendable" organization={null} />);
    await new Promise((r) => setTimeout(r, 50));
    // No org to scope the inspect to: the single-use code must survive for
    // the retry after onboarding.
    expect(state.inspectCalls).toHaveLength(0);
    expect(state.finishCalls).toHaveLength(0);
    expect(
      screen.queryByRole("button", { name: "Connect Slack" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/no organization yet/)).toBeInTheDocument();
  });

  it("surfaces the server's refusal instead of swallowing it", async () => {
    const user = userEvent.setup();
    state.fail =
      "This Slack workspace is already connected to another organization.";
    render(<SlackInstalledFinish code="taken" organization={ORG} />);

    await user.click(
      await screen.findByRole("button", { name: "Connect Slack" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "already connected to another organization",
    );
    // A failed bind must not navigate anywhere.
    expect(state.replaced).toHaveLength(0);
  });

  it("an expired/invalid code shows the inspect refusal, not a Connect button", async () => {
    state.inspectFail =
      "This Slack install link has expired (Slack codes last ten minutes).";
    render(<SlackInstalledFinish code="expired" organization={ORG} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("expired");
    expect(
      screen.queryByRole("button", { name: "Connect Slack" }),
    ).not.toBeInTheDocument();
    expect(state.finishCalls).toHaveLength(0);
  });
});
