import type {
  GetSessionAttributes,
  OnUserCreated,
  ShouldBootstrapOrg,
  AugmentSessionResponse,
} from "@/lib/auth/session-types";

export type { SessionUser, SessionAttributes } from "@/lib/auth/session-types";

export const getSessionAttributes: GetSessionAttributes = () => ({});

export const onUserCreated: OnUserCreated = () => {};

export const shouldBootstrapOrg: ShouldBootstrapOrg = () => true;

export const augmentSessionResponse: AugmentSessionResponse = async () => ({});
