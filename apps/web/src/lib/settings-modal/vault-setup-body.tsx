import { BitwardenVaultPage } from "@/app/(dashboard)/w/[workspaceId]/connections/_components/bitwarden-vault-page";
import { OnePasswordVaultPage } from "@/app/(dashboard)/w/[workspaceId]/connections/_components/onepassword-vault-page";
import { KeeperSecurityVaultPage } from "@/app/(dashboard)/w/[workspaceId]/connections/_components/keepersecurity-vault-page";

/**
 * A vault's setup inside the Settings modal (`?settings=apps&vault=<p>`):
 * the vault route pages' own component, frame included (its "Vaults"
 * link finds the modal on its own).
 */

const VAULTS = {
  bitwarden: BitwardenVaultPage,
  onepassword: OnePasswordVaultPage,
  keepersecurity: KeeperSecurityVaultPage,
} as const;

type VaultProvider = keyof typeof VAULTS;

export const isVaultProvider = (value: string): value is VaultProvider =>
  Object.hasOwn(VAULTS, value);

export const VaultSetupBody = ({ provider }: { provider: VaultProvider }) => {
  const Page = VAULTS[provider];
  return <Page />;
};
