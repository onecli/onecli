import type {
  GetSessionAttributes,
  OnUserCreated,
} from "@/lib/auth/session-types";

export type { SessionUser, SessionAttributes } from "@/lib/auth/session-types";

export const getSessionAttributes: GetSessionAttributes = () => ({});

export const onUserCreated: OnUserCreated = () => {};
