import { db } from "@onecli/db";
import { IS_CLOUD } from "../lib/env";
import { getSelfUrl } from "../providers/self-url";

export const getProjectPublicUrl = async (
  projectId: string,
): Promise<string> => {
  if (IS_CLOUD) return getSelfUrl();

  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { publicUrl: true },
  });

  return project?.publicUrl || getSelfUrl();
};

export const updateProjectPublicUrl = async (
  projectId: string,
  publicUrl: string | null,
): Promise<void> => {
  if (IS_CLOUD) {
    throw new Error("Public URL override is not available in Cloud edition");
  }

  if (publicUrl !== null) {
    const parsed = new URL(publicUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("URL must use http or https protocol");
    }
    publicUrl = parsed.origin;
  }

  await db.project.update({
    where: { id: projectId },
    data: { publicUrl },
  });
};
