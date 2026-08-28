"use client";

import type { OrgSsoConnection } from "@/lib/api";
import {
  SAML_EMAIL_CLAIM,
  SAML_NAME_CLAIM,
} from "@onecli/api/ee/sso/saml-claims";
import { COGNITO_DOMAIN, COGNITO_USER_POOL_ID } from "@/lib/env";
import { CopyableValue } from "./copyable-value";

export const SsoItPanel = ({
  connection,
}: {
  connection: OrgSsoConnection;
}) => {
  const rows: { label: string; value: string; required?: boolean }[] =
    connection.type === "saml"
      ? [
          {
            label: "ACS URL (reply URL)",
            value: `https://${COGNITO_DOMAIN}/saml2/idpresponse`,
          },
          {
            label: "SP Entity ID (audience)",
            value: `urn:amazon:cognito:sp:${COGNITO_USER_POOL_ID}`,
          },
          { label: "Email claim", value: SAML_EMAIL_CLAIM, required: true },
          { label: "Name claim", value: SAML_NAME_CLAIM },
        ]
      : [
          {
            label: "Redirect URI",
            value: `https://${COGNITO_DOMAIN}/oauth2/idpresponse`,
          },
          { label: "Scopes", value: "openid email profile" },
          { label: "Client authentication", value: "client_secret_post" },
        ];

  return (
    <div className="bg-muted/50 space-y-2 rounded-md p-3 text-xs">
      <p className="text-muted-foreground">
        Give these values to whoever manages your identity provider
        {connection.type === "saml"
          ? ". The email claim is required. Sign-in fails without it."
          : "."}
      </p>
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1.5">
        {rows.map((row) => (
          <div key={row.label} className="contents">
            <span className="text-muted-foreground">
              {row.label}
              {row.required ? " *" : ""}
            </span>
            <CopyableValue value={row.value} copyLabel={`Copy ${row.label}`} />
          </div>
        ))}
      </div>
    </div>
  );
};
