import { randomBytes } from "crypto";
import { db } from "@onecli/db";
import { ServiceError } from "@/lib/services/errors";

export const generateApiKey = () => `oc_${randomBytes(32).toString("hex")}`;

export const getApiKey = async (userId: string) => {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { apiKey: true },
  });

  if (!user) throw new ServiceError("NOT_FOUND", "User not found");

  return { apiKey: user.apiKey };
};

export const regenerateApiKey = async (userId: string) => {
  const apiKey = generateApiKey();

  await db.user.update({
    where: { id: userId },
    data: { apiKey },
  });

  return { apiKey };
};
