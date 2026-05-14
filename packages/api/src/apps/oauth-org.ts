/* eslint-disable @typescript-eslint/no-unused-vars */

export const tryHandleOrgAuthorize = async (
  _request: Request,
  _provider: string,
): Promise<Response | null> => null;

export const tryHandleOrgCallback = async (
  _request: Request,
  _provider: string,
): Promise<Response | null> => null;

export const tryHandleOrgConnect = async (
  _request: Request,
  _provider: string,
  _credentials: Record<string, unknown>,
  _options?: { scopes?: string[]; metadata?: Record<string, unknown> },
  _connectionId?: string,
  _fields?: Record<string, string>,
): Promise<Response | null> => null;
