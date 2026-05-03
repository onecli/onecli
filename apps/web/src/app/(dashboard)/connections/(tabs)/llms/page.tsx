import { Suspense } from "react";
import { SecretsContent } from "../../_components/secrets-content";

export default function ConnectionsLlmsPage() {
  return (
    <Suspense>
      <SecretsContent typeFilter="llm" />
    </Suspense>
  );
}
