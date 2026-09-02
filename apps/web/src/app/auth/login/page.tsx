import { redirect } from "next/navigation";
import { registrationState } from "@onecli/api/lib/registration";
import { isEmailConfigured } from "@onecli/api/services/email-service";
import { logger } from "@onecli/api/lib/logger";
import { GOOGLE_CLIENT_ID, IS_CLOUD } from "@/lib/env";
import { LoginContent } from "./_components/login-content";

/**
 * Whether this deployment is still waiting for its first account decides which
 * screen a visitor should be on: until then there is nothing to log in TO, so
 * everyone is sent to the signup form. Once an account exists, both screens
 * are offered and cross-link each other.
 *
 * Resolved on the server rather than fetched by the browser: a client-side
 * answer would render "Log in" and then swap it out, on the very first screen
 * an operator ever sees.
 *
 * A database that cannot answer resolves to "established" — the safe
 * direction. It shows the sign-in form (which will fail with its own message)
 * instead of turning a transient blip into an error page where the login used
 * to be.
 */
const awaitingFirstAccount = async (): Promise<boolean> => {
  // Cloud runs Cognito, which owns its own sign-up flow inside the login
  // screen; the self-hosted first-account question does not apply there.
  if (IS_CLOUD) return false;
  try {
    return (await registrationState()).firstAccount;
  } catch (err) {
    logger.error(
      { err },
      "could not read the deployment's account state — showing sign-in",
    );
    return false;
  }
};

export default async function LoginPage() {
  if (await awaitingFirstAccount()) {
    redirect("/auth/signup");
  }

  return (
    <LoginContent
      googleConfigured={!IS_CLOUD && Boolean(GOOGLE_CLIENT_ID)}
      // No mail provider means a reset link can never arrive, so the offer is
      // hidden rather than made and silently broken.
      emailConfigured={!IS_CLOUD && isEmailConfigured()}
    />
  );
}
