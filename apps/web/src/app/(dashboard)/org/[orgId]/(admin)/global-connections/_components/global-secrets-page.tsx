"use client";

import { Suspense } from "react";
import { SecretsContent } from "@/app/(dashboard)/w/[workspaceId]/connections/_components/secrets-content";
import {
  createOrgSecretAction,
  deleteOrgSecretAction,
  getOrgSecrets,
  updateOrgSecretAction,
} from "@/lib/actions/org-secrets";

const orgSecretActions = {
  createSecret: createOrgSecretAction,
  deleteSecret: deleteOrgSecretAction,
  updateSecret: updateOrgSecretAction,
};

export const GlobalCustomSecretsPage = () => (
  <Suspense>
    <SecretsContent
      typeFilter="generic"
      getSecrets={getOrgSecrets}
      secretActions={orgSecretActions}
      pageScope="organization"
    />
  </Suspense>
);

export const GlobalLlmSecretsPage = () => (
  <Suspense>
    <SecretsContent
      typeFilter="llm"
      getSecrets={getOrgSecrets}
      secretActions={orgSecretActions}
      pageScope="organization"
    />
  </Suspense>
);
