import { Hash, Lock, MessageCircle, Users } from "lucide-react";
import type { ConversationKind } from "./api";

export const KIND_ICON: Record<ConversationKind, typeof Hash> = {
  channel: Hash,
  private_channel: Lock,
  dm: MessageCircle,
  group_dm: Users,
};
