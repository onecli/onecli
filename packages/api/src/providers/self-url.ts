import { APP_URL } from "../lib/env";

let _selfUrl: string = APP_URL;

export const initSelfUrl = (url: string) => {
  _selfUrl = url;
};

export const getSelfUrl = (): string => _selfUrl;
