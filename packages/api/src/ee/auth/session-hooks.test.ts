import { beforeEach, describe, expect, it, vi } from "vitest";

// onUserCreated gating: the signup ping and welcome email fire for organic
// signups (org bootstrapped)
// ONLY — invitation and SSO-JIT first logins stay silent.

const mocks = vi.hoisted(() => ({
  notifyDiscord: vi.fn(),
  sendWelcomeEmail: vi.fn(),
}));

vi.mock("@onecli/db", () => ({ db: {} }));
vi.mock("../../services/organization-service", () => ({
  activeMembershipWhere: {},
}));
vi.mock("../notifications/discord", () => ({
  notifyDiscord: mocks.notifyDiscord,
}));
vi.mock("../notifications/welcome-email", () => ({
  sendWelcomeEmail: mocks.sendWelcomeEmail,
}));
vi.mock("../sso/jit-service", () => ({
  ensureSsoJitMembership: async () => {},
}));
vi.mock("../../lib/identity-conflict", () => ({
  resolveIdentityConflict: async () => "link",
}));

import { eeSessionHooks } from "./session-hooks";

const USER = { email: "owner@acme.com", name: "Owner" };
const ATTRS = { countryCode: "US", country: "United States" };
const SESSION_URL = "https://app.onecli.sh/v1/auth/session";

const created = (url: string, bootstrappedOrg: boolean) =>
  eeSessionHooks.onUserCreated(USER, ATTRS, {
    request: new Request(url),
    bootstrappedOrg,
  });

beforeEach(() => {
  mocks.notifyDiscord.mockClear();
  mocks.sendWelcomeEmail.mockClear();
});

describe("eeSessionHooks.onUserCreated", () => {
  it("organic signup: pings without a source and sends the welcome email", () => {
    created(SESSION_URL, true);

    expect(mocks.notifyDiscord).toHaveBeenCalledWith("user_signup", {
      email: "owner@acme.com",
      name: "Owner",
      countryCode: "US",
      country: "United States",
      source: undefined,
    });
    expect(mocks.sendWelcomeEmail).toHaveBeenCalledWith(
      "owner@acme.com",
      "Owner",
    );
  });

  it("provision claim: pings with the source label and sends the welcome email", () => {
    created(`${SESSION_URL}?fromInvitation=1&fromClaim=1`, false);

    expect(mocks.notifyDiscord).toHaveBeenCalledWith("user_signup", {
      email: "owner@acme.com",
      name: "Owner",
      countryCode: "US",
      country: "United States",
      source: "provision claim",
    });
    expect(mocks.sendWelcomeEmail).toHaveBeenCalledWith(
      "owner@acme.com",
      "Owner",
    );
  });

  it("invitation (fromInvitation only): silent", () => {
    created(`${SESSION_URL}?fromInvitation=1`, false);

    expect(mocks.notifyDiscord).not.toHaveBeenCalled();
    expect(mocks.sendWelcomeEmail).not.toHaveBeenCalled();
  });

  it("no marker, no bootstrap (SSO-JIT shape): silent", () => {
    created(SESSION_URL, false);

    expect(mocks.notifyDiscord).not.toHaveBeenCalled();
    expect(mocks.sendWelcomeEmail).not.toHaveBeenCalled();
  });
});

describe("eeSessionHooks.shouldBootstrapOrg", () => {
  // Cloud's rule is unchanged by the self-hosted identity work: only a user
  // THIS request created, and never one arriving through an invitation (they
  // join an existing organization). The `isNewUser` term is what keeps the
  // self-host repair path — which bootstraps any user without one — from
  // handing a second organization to an established cloud account.
  const request = (url = "https://api.onecli.sh/v1/auth/session") =>
    new Request(url);

  it("bootstraps an organic signup", () => {
    expect(
      eeSessionHooks.shouldBootstrapOrg(request(), { isNewUser: true }),
    ).toBe(true);
  });

  it("does not bootstrap a user this request did not create", () => {
    expect(
      eeSessionHooks.shouldBootstrapOrg(request(), { isNewUser: false }),
    ).toBe(false);
  });

  it("does not bootstrap an invited signup", () => {
    expect(
      eeSessionHooks.shouldBootstrapOrg(
        request("https://api.onecli.sh/v1/auth/session?fromInvitation=1"),
        { isNewUser: true },
      ),
    ).toBe(false);
  });
});
