import { db } from "@onecli/db";
import { ServiceError } from "@/lib/services/errors";

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
