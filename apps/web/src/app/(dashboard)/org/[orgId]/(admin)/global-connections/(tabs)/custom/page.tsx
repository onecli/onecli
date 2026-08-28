import { Suspense } from "react";
import { GlobalCustomSecretsPage } from "../../_components/global-secrets-page";

export default function OrgCustomSecretsPage() {
  return (
    <Suspense>
      <GlobalCustomSecretsPage />
    </Suspense>
  );
}
