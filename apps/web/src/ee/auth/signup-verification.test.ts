import { describe, expect, it } from "vitest";
import { AuthError } from "aws-amplify/auth";
import {
  SIGNUP_BLOCKED_ERROR,
  isSignupVerificationError,
} from "./signup-verification";

/**
 * Amplify rethrows a Cognito error as an AuthError whose `name` is Cognito's
 * error type and whose `message` is Cognito's message. A PreSignUp denial
 * arrives as `UserLambdaValidationException` with the trigger's own message
 * wrapped inside.
 */
const cognitoError = (name: string, message: string) =>
  new AuthError({ name, message });

describe("isSignupVerificationError", () => {
  it("recognizes a signup denied by the verification trigger", () => {
    expect(
      isSignupVerificationError(
        cognitoError(
          "UserLambdaValidationException",
          `PreSignUp failed with error ${SIGNUP_BLOCKED_ERROR}.`,
        ),
      ),
    ).toBe(true);
  });

  it("does not mistake other signup failures for a verification denial", () => {
    for (const error of [
      // The email already has an account: the sign-in fallback handles it.
      cognitoError("UsernameExistsException", "User already exists"),
      // A different trigger failure (e.g. a timeout) is not this denial.
      cognitoError(
        "UserLambdaValidationException",
        "PreSignUp failed with error Task timed out.",
      ),
      cognitoError("UnexpectedLambdaException", SIGNUP_BLOCKED_ERROR),
      new Error(SIGNUP_BLOCKED_ERROR),
      SIGNUP_BLOCKED_ERROR,
      undefined,
    ]) {
      expect(isSignupVerificationError(error)).toBe(false);
    }
  });
});
