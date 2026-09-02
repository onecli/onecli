import { apiOrigin } from "../lib/public-origins";

// Lazy on purpose: the un-initialized default is this process's own API
// origin (resolver-derived), read at first use rather than module load. The
// old module-load default was the *dashboard* URL constant — an embedded
// consumer that never called initSelfUrl got the wrong origin entirely.
let _selfUrl: string | undefined;

export const initSelfUrl = (url: string) => {
  _selfUrl = url;
};

export const getSelfUrl = (): string => _selfUrl ?? apiOrigin();
