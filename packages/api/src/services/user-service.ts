import { db } from "@onecli/db";
import { cleanLabel } from "../lib/format";
import { ServiceError } from "./errors";

/** A person's name as the agent says it (their name, else their email),
 * cleaned for prose; null when the user is gone or has neither. */
export const userDisplayName = async (
  userId: string,
): Promise<string | null> => {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { name: true, email: true },
  });
  return cleanLabel(user?.name || user?.email || "") || null;
};

export const getUser = async (userId: string) => {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      createdAt: true,
    },
  });

  if (!user) throw new ServiceError("NOT_FOUND", "User not found");

  return user;
};

export const updateProfile = async (userId: string, name: string) => {
  const trimmed = name.trim();

  if (trimmed.length === 0 || trimmed.length > 255) {
    throw new ServiceError(
      "BAD_REQUEST",
      "Name must be between 1 and 255 characters",
    );
  }

  const user = await db.user.update({
    where: { id: userId },
    data: { name: trimmed },
    select: {
      id: true,
      email: true,
      name: true,
    },
  });

  return user;
};
