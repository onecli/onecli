import { Suspense } from "react";
import { SecretsContent } from "../../_components/secrets-content";

export default function ConnectionsCustomPage() {
  return (
    <Suspense>
      <SecretsContent typeFilter="generic" />
    </Suspense>
  );
}
