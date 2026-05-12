/* eslint-disable @typescript-eslint/no-unused-vars */
import type { NextRequest, NextResponse } from "next/server";

export const tryHandleOrgAuthorize = async (
  _request: NextRequest,
  _provider: string,
): Promise<NextResponse | null> => null;

export const tryHandleOrgCallback = async (
  _request: NextRequest,
  _provider: string,
): Promise<NextResponse | null> => null;

export const tryHandleOrgConnect = async (
  _provider: string,
  _credentials: Record<string, unknown>,
  _options?: { scopes?: string[]; metadata?: Record<string, unknown> },
  _connectionId?: string,
  _fields?: Record<string, string>,
): Promise<NextResponse | null> => null;
