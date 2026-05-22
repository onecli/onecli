import type { OAuthOrgHandlers } from "./types";
import * as defaultOAuthOrg from "../apps/oauth-org";

let _oauthOrg: OAuthOrgHandlers = defaultOAuthOrg;

export const initOAuthOrg = (handlers: OAuthOrgHandlers) => {
  _oauthOrg = handlers;
};

export const getOAuthOrg = (): OAuthOrgHandlers => _oauthOrg;
