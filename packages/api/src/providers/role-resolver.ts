import type { RoleResolver } from "./types";

let _roleResolver: RoleResolver | null = null;

export const initRoleResolver = (r: RoleResolver) => {
  _roleResolver = r;
};

export const getRoleResolver = (): RoleResolver | null => _roleResolver;
