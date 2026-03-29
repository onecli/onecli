import { Suspense } from "react";
import { SecretsContent } from "../../_components/secrets-content";

export default function ConnectionsSecretsPage() {
  return (
    <Suspense>
      <SecretsContent />
    </Suspense>
  );
}
