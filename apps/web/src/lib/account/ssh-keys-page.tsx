import { PageHeader } from "@dashboard/page-header";
import { SshKeysCard } from "./_components/ssh-keys-card";

export default function SshKeysPage() {
  return (
    <div className="flex flex-1 flex-col gap-6">
      <PageHeader
        title="SSH Keys"
        description="Public keys that identify you when connecting to your agents over SSH. Register a key once, then mint certificates from it on any agent's SSH page."
      />
      <SshKeysCard />
    </div>
  );
}
