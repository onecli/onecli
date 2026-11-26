import { getProviderIcon } from "@onecli/api/apps/provider-icons";
import { ProviderIcon } from "./provider-icon";

/** A provider as Activity shows it: its icon and display name, or the raw id
 *  for a provider without one. Network's Provider column and Runs' Apps
 *  column use this one cell. */
export const ProviderLabel = ({ provider }: { provider: string }) => (
  <span className="flex min-w-0 items-center gap-1.5">
    <span className="shrink-0">
      <ProviderIcon provider={provider} size={14} />
    </span>
    <span className="truncate text-sm">
      {getProviderIcon(provider)?.name ?? provider}
    </span>
  </span>
);
