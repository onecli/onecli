import type { SessionProvider } from "./types";

let _session: SessionProvider;

export const initSession = (s: SessionProvider) => {
  _session = s;
};

export const getSessionProvider = (): SessionProvider => {
  if (!_session) throw new Error("SessionProvider not initialized");
  return _session;
};
