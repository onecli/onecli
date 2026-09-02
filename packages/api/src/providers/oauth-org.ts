import type { OAuthOrgHandlers } from "./types";
import { createEditionSlot } from "./edition-state";

// Org-scoped OAuth interception (authorize / callback / connect). The real
// handlers are shared across editions and are injected at boot by
// `ensureEditionDefaults()` — they ride the DB client and the connection
// services, which must never enter a browser bundle, so this slot's static
// default stays a client-safe no-op. A process that skipped boot injection
// (a mis-wired host) degrades per entry point: the `?_org=` /
// `X-Organization-Id` interceptors fail loud with a 400, the shared OAuth
// CALLBACK falls through to its workspace arm (no org state ever gets
// signed, because /authorize already refused), and the canonical /org/apps
// routes import the handlers directly and keep working. `initOAuthOrg`
// remains as a test seam (null resets to the no-op default).
const noopOAuthOrg: OAuthOrgHandlers = {
  tryHandleOrgAuthorize: async () => null,
  tryHandleOrgCallback: async () => null,
  tryHandleOrgConnect: async () => null,
};

const slot = createEditionSlot<OAuthOrgHandlers>("oauthOrg", noopOAuthOrg);

export const initOAuthOrg = (handlers: OAuthOrgHandlers | null) =>
  slot.init(handlers);

/** Package-internal: the edition-defaults injector. Not exported from the barrel. */
export const setDefaultOAuthOrg = (handlers: OAuthOrgHandlers) =>
  slot.setCloudDefault(handlers);

export const getOAuthOrg = (): OAuthOrgHandlers => slot.get();
