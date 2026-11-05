"use client";

import { createContext, useContext } from "react";

/**
 * "Send this as the person's next chat message", offered by the agent chat
 * to anything rendered inside it. Null outside a chat (the agent's
 * Connections page), so a component that can hand work back to the agent
 * shows that door only where there is an agent to hand it to.
 */
export type ChatSend = (message: string) => void;

export const ChatSendContext = createContext<ChatSend | null>(null);

export const useChatSend = (): ChatSend | null => useContext(ChatSendContext);
