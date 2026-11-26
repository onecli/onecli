/**
 * The robot pictures a new agent can start with, served from
 * `public/agent-faces/` as robot-01.jpg … robot-50.jpg (512px; the
 * originals were 1024px PNGs, about 1.2MB each, which no avatar needs).
 *
 * `AGENT_FACE_COUNT` is how many are shipped. At 0 the New agent dialog
 * shows no picture and creates the agent with none.
 */
export const AGENT_FACE_COUNT: number = 50;

export const agentFaceUrl = (index: number): string =>
  `/agent-faces/robot-${String(index + 1).padStart(2, "0")}.jpg`;

/** A random picture index, never `current`, so shuffle always changes it.
 * Null when no pictures are shipped. */
export const randomAgentFace = (current?: number | null): number | null => {
  if (AGENT_FACE_COUNT === 0) return null;
  if (AGENT_FACE_COUNT === 1 || current == null) {
    return Math.floor(Math.random() * AGENT_FACE_COUNT);
  }
  const step = 1 + Math.floor(Math.random() * (AGENT_FACE_COUNT - 1));
  return (current + step) % AGENT_FACE_COUNT;
};

/** The picture as a File, for the agent's avatar upload. */
export const agentFaceFile = async (index: number): Promise<File> => {
  const res = await fetch(agentFaceUrl(index));
  if (!res.ok) throw new Error("Could not load the agent's picture");
  const blob = await res.blob();
  return new File([blob], "avatar.jpg", { type: blob.type || "image/jpeg" });
};
