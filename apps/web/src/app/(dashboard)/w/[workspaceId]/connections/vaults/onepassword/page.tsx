"use client";

import { OnePasswordSetup } from "../../_components/onepassword-setup";
import { VaultPageFrame } from "../../_components/vault-page-frame";

export default function OnePasswordPage() {
  return (
    <VaultPageFrame
      title="1Password"
      description="Resolve secrets on-demand from 1Password using a service account. Nothing is stored on the server."
    >
      <OnePasswordSetup />
    </VaultPageFrame>
  );
}
