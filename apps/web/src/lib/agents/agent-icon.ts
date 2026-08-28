import { Bot } from "lucide-react";

/**
 * The one mark for an agent, everywhere it appears: sidebar rows, the agent
 * page header, roster empty states, stat cards, policy reflections. Behind a
 * single export so those surfaces cannot drift apart, and so trying another
 * mark stays a one-line change.
 */
export const AgentIcon = Bot;
