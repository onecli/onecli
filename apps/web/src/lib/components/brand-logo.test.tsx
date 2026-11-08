// @vitest-environment jsdom
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";

// ── The brand logo on the standalone screens ────────────────────────────────
//
// The invitation screens and the Slack-directory sign-in all open with the
// same logo block: the light and dark variants, each shown in one theme only,
// at 140×40 and loaded with priority. Every prop `next/image` receives is
// written out as an attribute, so a changed size, alt text, theme class or
// priority flag on any screen fails here.

vi.mock("next/image", () => ({
  default: ({
    src,
    alt,
    width,
    height,
    priority,
    className,
  }: {
    src: string;
    alt: string;
    width: number;
    height: number;
    priority?: boolean;
    className?: string;
  }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      width={width}
      height={height}
      data-priority={String(Boolean(priority))}
      className={className}
    />
  ),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/providers/auth-provider", () => ({
  useAuth: () => ({ signOut: vi.fn() }),
}));

vi.mock("@/hooks/use-invitations", () => ({
  useAcceptInvitation: () => ({ isPending: false, mutate: vi.fn() }),
}));

import { BrandLogo } from "./brand-logo";
import { JoinForm } from "@/lib/team/_components/join-form";
import { JoinSignIn } from "@/lib/team/_components/join-sign-in";
import { JoinUnavailable } from "@/lib/team/_components/join-unavailable";
import { JoinWrongAccount } from "@/lib/team/_components/join-wrong-account";
import { SlackInstalledSignIn } from "@/app/slack/installed/_components/slack-installed-sign-in";

// React writes `src` last on an <img>, whatever order the props come in.
const LOGO =
  '<div class="mb-8">' +
  '<img alt="OneCLI" width="140" height="40" data-priority="true" class="dark:hidden" src="/onecli-full-logo.png">' +
  '<img alt="OneCLI" width="140" height="40" data-priority="true" class="hidden dark:block" src="/onecli-full-logo-dark.png">' +
  "</div>";

afterEach(() => {
  cleanup();
});

describe("BrandLogo", () => {
  it("renders the light and dark logo, one per theme", () => {
    const { container } = render(<BrandLogo />);
    expect(container.innerHTML).toBe(LOGO);
  });
});

const screens: Array<[string, ReactElement]> = [
  ["JoinForm", <JoinForm key="form" token="tok-1" orgName="Acme" />],
  ["JoinSignIn", <JoinSignIn key="sign-in" callbackUrl="/join?token=tok-1" />],
  [
    "JoinUnavailable",
    <JoinUnavailable
      key="unavailable"
      reason="expired"
      signedIn={false}
      callbackUrl="/join?token=tok-1"
    />,
  ],
  [
    "JoinWrongAccount",
    <JoinWrongAccount
      key="wrong-account"
      orgName="Acme"
      invitedEmail="m***@acme.test"
      currentEmail="other@acme.test"
      callbackUrl="/join?token=tok-1"
    />,
  ],
  [
    "SlackInstalledSignIn",
    <SlackInstalledSignIn
      key="slack"
      callbackUrl="/slack/installed?code=c-1"
    />,
  ],
];

describe.each(screens)("%s", (_name, screen) => {
  it("opens with the brand logo, before the card", () => {
    const { container } = render(screen);
    const page = container.firstElementChild;
    expect(page?.className).toBe(
      "flex min-h-svh flex-col items-center justify-center px-4",
    );
    expect(page?.firstElementChild?.outerHTML).toBe(LOGO);
    expect(container.querySelectorAll("img")).toHaveLength(2);
  });
});
