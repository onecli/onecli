/**
 * The default Entra/Okta claim URIs our SAML attribute mapping expects.
 * DEPENDENCY-FREE ON PURPOSE: the web IT-instructions panel imports these
 * client-side, so nothing here may pull the AWS SDK or env. Server mapping:
 * cognito-idp-service.ts; client display: sso-it-panel.tsx.
 */
export const SAML_EMAIL_CLAIM =
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress";
export const SAML_NAME_CLAIM =
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name";
