import { db } from "@onecli/db";
import { getCrypto } from "../../../../providers";
import { usersInfo } from "./slack-api";
import { createInvitation } from "../../../invitation-service";
import { ServiceError } from "../../../errors";
import { configuredAppUrl } from "../../../../lib/app-origin";
import { logger } from "../../../../lib/logger";

const log = logger.child({ component: "slack-onboarding" });

/**
 * The shared OneCLI app's ONE job: onboarding. Any workspace member who DMs
 * the bot gets a button that takes them to their OneCLI account — signing
 * them up by their Slack-verified email when they don't have one yet.
 *
 * The "magic link" is deliberately the EXISTING invitation token, not a new
 * auth surface: an Invitation is already an email-bound, expiring, single-use
 * credential whose accept path (`/join?token=…`) handles both signup and an
 * existing user joining the org — and it respects seat caps and the
 * accept-side email check (`acceptInvitation` refuses a mismatched account).
 * Minting anything stronger (a session-granting link) would be a second
 * identity system beside better-auth/Cognito, which the auth lock forbids.
 *
 * TRUST: the caller has verified the Slack request signature against the
 * DEPLOYMENT's signing secret. The speaker's email comes from `users.info`
 * with the installation's own bot token — Slack-verified, never claimed by
 * the payload.
 */

export type OnboardingReply = {
  /** Sent as the message text (notification fallback). */
  text: string;
  /** Block Kit button, when there is a link to offer. */
  button: { label: string; url: string } | null;
};

export const onboardingReplyForSlackUser = async (input: {
  installationId: string;
  externalUserId: string;
}): Promise<OnboardingReply | null> => {
  const appUrl = configuredAppUrl();
  if (!appUrl) return null;

  const installation = await db.channelInstallation.findUnique({
    where: { id: input.installationId },
    select: {
      credentials: true,
      createdByUserId: true,
      integration: {
        select: {
          organizationId: true,
          organization: { select: { name: true } },
        },
      },
    },
  });
  if (!installation) return null;
  const organizationId = installation.integration.organizationId;
  const orgName = installation.integration.organization.name;

  // The speaker's Slack-verified email, via the install's own bot token.
  let email: string | undefined;
  let guestOrVoid = false;
  try {
    const creds = JSON.parse(
      await getCrypto().decrypt(installation.credentials),
    ) as { botToken?: string };
    if (creds.botToken) {
      const profile = await usersInfo(creds.botToken, input.externalUserId);
      // Workspace GUESTS (multi-/single-channel — contractors, clients) and
      // Slack-Connect externals/deleted accounts are exactly who the
      // installing admin did NOT mean by "my team": they get pointed at an
      // admin instead of an auto-minted invitation. Full members already in
      // the org still get their "all set" answer below regardless.
      guestOrVoid = Boolean(
        profile.user.is_restricted ||
        profile.user.is_ultra_restricted ||
        profile.user.is_stranger ||
        profile.user.deleted,
      );
      // Lowercase once: Slack reports profile emails in whatever case the
      // user typed, while the accept path compares lowercased — case drift
      // here would fork one person into two invitation rows.
      email = profile.user.profile?.email?.toLowerCase();
    }
  } catch (err) {
    log.warn({ err }, "onboarding email lookup failed");
  }
  if (!email) {
    return {
      text: "I couldn't read your Slack email, so I can't link you to OneCLI. Ask a workspace admin to check the app's permissions.",
      button: null,
    };
  }

  const user = await db.user.findUnique({
    where: { email },
    select: { id: true },
  });

  if (user) {
    const membership = await db.organizationMember.findFirst({
      where: {
        organizationId,
        userId: user.id,
        NOT: { status: "suspended" },
      },
      select: { userId: true },
    });
    if (membership) {
      return {
        text: `You're all set. Your OneCLI account is ready.`,
        button: { label: "Open OneCLI", url: appUrl },
      };
    }
  }

  // No account, or an account outside this org: offer an invitation into
  // the INSTALLING org. The /join page signs a new person up with this
  // exact email and lands an existing one in the org — the same one door
  // every invited teammate walks through.

  // Guests never auto-mint (see above) — an admin can still invite them
  // deliberately from the dashboard.
  if (guestOrVoid) {
    return {
      text: `Ask an admin of ${orgName} to invite you to OneCLI. Guest accounts aren't onboarded automatically.`,
      button: null,
    };
  }

  // Reuse a LIVE pending invitation as-is. Re-minting would rotate the
  // token — killing every previously sent link, including one an org admin
  // deliberately emailed — and overwrite a deliberately chosen role with
  // "member" (the upsert underneath is seat-idempotent, not token- or
  // role-stable). An unauthenticated Slack event must never edit an admin's
  // configuration.
  const pending = await db.invitation.findUnique({
    where: { organizationId_email: { organizationId, email } },
    select: { token: true, status: true, expiresAt: true },
  });
  if (
    pending &&
    pending.status === "pending" &&
    pending.expiresAt > new Date()
  ) {
    return {
      text: `Welcome! Click below to set up your OneCLI account (${email}) and join ${orgName}.`,
      button: {
        label: "Set up my OneCLI account",
        url: `${appUrl}/join?token=${encodeURIComponent(pending.token)}`,
      },
    };
  }

  // A CANCELLED invitation is an admin's explicit revocation — the block
  // mark only an admin-initiated re-invite may clear. Minting fresh here
  // would resurrect it (createInvitation's upsert flips the row back to
  // pending with a new token), letting an unauthenticated Slack event
  // override an admin's decision.
  if (pending?.status === "cancelled") {
    return {
      text: `Ask an admin of ${orgName} to invite you to OneCLI.`,
      button: null,
    };
  }

  // A FRESH mint needs a live voucher: the installing admin. Their user row
  // surviving is not enough — suspension or org removal must cut their
  // provisioning power, the same law the install link itself obeys ("a
  // departed admin's link dies with them").
  const inviterId = installation.createdByUserId;
  const inviterMembership = inviterId
    ? await db.organizationMember.findFirst({
        where: {
          organizationId,
          userId: inviterId,
          NOT: { status: "suspended" },
        },
        select: { userId: true },
      })
    : null;
  if (!inviterId || !inviterMembership) {
    return {
      text: `Ask an admin of ${orgName} to invite you to OneCLI. The person who connected this app is no longer available to vouch for new members.`,
      button: null,
    };
  }
  const inviter = await db.user.findUnique({
    where: { id: inviterId },
    select: { email: true },
  });

  try {
    const invitation = await createInvitation({
      organizationId,
      email,
      role: "member",
      invitedById: inviterId,
      invitedByEmail: inviter?.email ?? "",
    });
    return {
      text: `Welcome! Click below to set up your OneCLI account (${email}) and join ${orgName}.`,
      button: {
        label: "Set up my OneCLI account",
        url: `${appUrl}/join?token=${encodeURIComponent(invitation.token)}`,
      },
    };
  } catch (err) {
    // Seat caps and similar refusals are ServiceErrors carrying a human
    // sentence — relay those. Anything else (a DB failure's internals) must
    // never reach a Slack workspace member.
    const message =
      err instanceof ServiceError
        ? err.message
        : "I couldn't create your invitation.";
    log.warn({ err, organizationId }, "onboarding invitation failed");
    return {
      text: `${message} Ask an admin of ${orgName} for an invite.`,
      button: null,
    };
  }
};
