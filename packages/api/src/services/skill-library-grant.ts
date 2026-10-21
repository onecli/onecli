import { ServiceError } from "./errors";
import {
  generateNonce,
  signOAuthState,
  verifyOAuthState,
  type OAuthStatePayload,
} from "../lib/oauth-state";

/**
 * "Install GitHub for skills only": the org's skill library gets GitHub
 * access WITHOUT an org connection appearing under Connections.
 *
 * The popup runs the normal org GitHub App install (same ownership proof:
 * GitHub itself confirms the signed-in user can access the installation). A
 * state marked `purpose: skills` then stores NOTHING; instead the callback
 * hands the popup a server-signed grant: "this org and this user proved
 * access to installation X". The library's connect accepts that grant, for
 * the same org and user, for ten minutes, and copies the access into the
 * library itself (the signing key is resolved server-side; the grant never
 * carries a credential).
 */

/** The `purpose` an org authorize is started with for the skill library. */
export const SKILLS_PURPOSE = "skills";

/** Why a skills-only install is refused: the GitHub App in use can't prove
 * the user's access to an installation (see `githubInstallsAreProven`). */
export const SKILLS_ONLY_UNAVAILABLE =
  "Installing GitHub for skills only isn't available here. Connect GitHub to the organization, then pick it for the library.";

/** The `provider` of a signed grant: no OAuth route accepts it as a state. */
const GRANT_KIND = "github-app:library-grant";
/** A second, explicit marker: the grant is told apart from an OAuth state by
 * what it says it is, not only by checks elsewhere refusing its provider. */
const GRANT_TYPE = "library-grant";
const GRANT_TTL_MS = 10 * 60 * 1000;
const INSTALLATION_ID = /^\d+$/;

export interface LibraryInstallationGrant {
  installationId: string;
  account: string | null;
  accountType: string | null;
}

/** Whether a verified org OAuth state was started for the skill library. */
export const isSkillsOnlyState = (state: OAuthStatePayload | null) =>
  state?.purpose === SKILLS_PURPOSE;

/** Sign the grant the callback hands back (after the ownership proof). */
export const signLibraryGrant = (args: {
  organizationId: string;
  userId: string;
  grant: LibraryInstallationGrant;
}): string => {
  if (!INSTALLATION_ID.test(args.grant.installationId)) {
    throw new ServiceError("BAD_REQUEST", "Invalid GitHub installation");
  }
  return signOAuthState({
    provider: GRANT_KIND,
    kind: GRANT_TYPE,
    nonce: generateNonce(),
    organizationId: args.organizationId,
    userId: args.userId,
    expiresAt: Date.now() + GRANT_TTL_MS,
    ...args.grant,
  });
};

const GRANT_REFUSED =
  "This GitHub sign-in has expired or belongs to someone else. Install GitHub for skills again.";

/** The installation a grant proves, if it is THIS org's and user's and still
 * fresh. Anything else (tampered, expired, another org, another user, an
 * OAuth state) is refused whole. */
export const readLibraryGrant = (
  raw: string,
  caller: { organizationId: string; userId: string },
): LibraryInstallationGrant => {
  const payload = verifyOAuthState(raw);
  if (
    !payload ||
    payload.provider !== GRANT_KIND ||
    payload.kind !== GRANT_TYPE ||
    payload.organizationId !== caller.organizationId ||
    payload.userId !== caller.userId ||
    typeof payload.expiresAt !== "number" ||
    payload.expiresAt < Date.now() ||
    typeof payload.installationId !== "string" ||
    !INSTALLATION_ID.test(payload.installationId)
  ) {
    throw new ServiceError("FORBIDDEN", GRANT_REFUSED);
  }
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    installationId: payload.installationId,
    account: str(payload.account),
    accountType: str(payload.accountType),
  };
};
