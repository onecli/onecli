import { ServiceError } from "@/lib/services/errors";

export const normalizeBaseUrl = (input: string): string => {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new ServiceError("BAD_REQUEST", "Enterprise URL is required");
  }

  if (!trimmed.toLowerCase().startsWith("https://")) {
    throw new ServiceError(
      "BAD_REQUEST",
      "Enterprise URL must start with https://",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ServiceError("BAD_REQUEST", "Enterprise URL is not a valid URL");
  }

  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new ServiceError(
      "BAD_REQUEST",
      "Enterprise URL must not contain a path (e.g. https://github.example.com)",
    );
  }

  if (parsed.search || parsed.hash) {
    throw new ServiceError(
      "BAD_REQUEST",
      "Enterprise URL must not contain query or fragment",
    );
  }

  return `${parsed.protocol}//${parsed.host}`;
};
