import type { NextRequest } from "next/server";

export type SessionUser = {
  email: string;
  name: string | null;
};

/** Extra attributes to spread into the user upsert (create + update). */
export type SessionAttributes = Record<string, unknown>;

export type GetSessionAttributes = (request: NextRequest) => SessionAttributes;

export type OnUserCreated = (user: SessionUser) => void;
