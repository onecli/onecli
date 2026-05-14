import type { AuthContext } from "./providers";

export type ApiEnv = {
  Variables: {
    auth: AuthContext;
  };
};
