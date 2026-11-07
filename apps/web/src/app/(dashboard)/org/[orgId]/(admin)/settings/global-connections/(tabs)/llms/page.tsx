import { Suspense } from "react";
import { GlobalLlmSecretsPage } from "../../_components/global-secrets-page";

export default function OrgLlmSecretsPage() {
  return (
    <Suspense>
      <GlobalLlmSecretsPage />
    </Suspense>
  );
}
