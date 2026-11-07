"use client";

import { BitwardenSetup } from "../../_components/bitwarden-setup";
import { VaultPageFrame } from "../../_components/vault-page-frame";

export default function BitwardenPage() {
  return (
    <VaultPageFrame
      title="Bitwarden"
      description="Fetch credentials on-demand from your Bitwarden vault. Nothing is stored on the server."
    >
      <BitwardenSetup />
    </VaultPageFrame>
  );
}
