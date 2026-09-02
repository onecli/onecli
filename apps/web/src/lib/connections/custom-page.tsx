"use client";

import { Suspense } from "react";
import { SecretsContent } from "@/app/(dashboard)/w/[workspaceId]/connections/_components/secrets-content";
import { CreateSecretButton } from "./_components/create-secret-button";

export default function CloudCustomPage() {
  return (
    <Suspense>
      <SecretsContent
        typeFilter="generic"
        renderCreateButton={(onCreate) => (
          <CreateSecretButton onCreate={onCreate} label="Add Secret" />
        )}
      />
    </Suspense>
  );
}
