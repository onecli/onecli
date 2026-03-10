"use server";

import { db } from "@onecli/db";

interface EnsureUserInput {
  authId: string;
  email: string;
  name?: string;
}

export async function ensureUser(input: EnsureUserInput) {
  const user = await db.user.upsert({
    where: { cognitoId: input.authId },
    create: {
      cognitoId: input.authId,
      email: input.email,
      name: input.name,
    },
    update: {
      email: input.email,
      name: input.name,
    },
    select: { id: true },
  });

  return { id: user.id };
}
