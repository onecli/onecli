export const API_ORIGIN = "";

export const getAuthToken = async (): Promise<string | undefined> => undefined;

export const getProjectId = (): string | undefined => undefined;

export const apiFetch = (
  path: string,
  options?: RequestInit,
): Promise<Response> => fetch(path, options);
