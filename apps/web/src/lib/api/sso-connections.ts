import { apiGet, apiPost, apiPatch, apiDelete } from "./client";
import type {
  CreateSsoConnectionInput,
  OrgSsoConnection,
  SsoTestResult,
  UpdateSsoConnectionInput,
} from "./types";

// SSO connections are organization-scoped only — no project variant.
const base = "/v1/org/sso/connections";

export const list = () => apiGet<OrgSsoConnection[]>(base);

export const create = (input: CreateSsoConnectionInput) =>
  apiPost<OrgSsoConnection>(base, input);

export const update = (connectionId: string, input: UpdateSsoConnectionInput) =>
  apiPatch<OrgSsoConnection>(`${base}/${connectionId}`, input);

export const remove = (connectionId: string) =>
  apiDelete(`${base}/${connectionId}`);

export const test = (connectionId: string) =>
  apiPost<SsoTestResult>(`${base}/${connectionId}/test`, {});
