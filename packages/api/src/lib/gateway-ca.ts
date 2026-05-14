import { existsSync, readFileSync } from "fs";
import { GATEWAY_CA_CERT, GATEWAY_CA_PEM_FILE, HOME, IS_CLOUD } from "./env";

const CA_PEM_FILE_DOCKER = "/app/data/gateway/ca.pem";
const CA_PEM_FILE_LOCAL = `${HOME}/.onecli/gateway/ca.pem`;

const getCaPemFilePath = (): string => {
  if (GATEWAY_CA_PEM_FILE) return GATEWAY_CA_PEM_FILE;
  return existsSync("/app/data") ? CA_PEM_FILE_DOCKER : CA_PEM_FILE_LOCAL;
};

export const loadCaCertificate = (): string | null => {
  const envCert = GATEWAY_CA_CERT.trim();
  if (envCert) return envCert;

  if (GATEWAY_CA_PEM_FILE) {
    try {
      const pem = readFileSync(GATEWAY_CA_PEM_FILE, "utf-8").trim();
      return pem || null;
    } catch {
      return null;
    }
  }

  if (IS_CLOUD) return null;

  const path = getCaPemFilePath();
  try {
    const pem = readFileSync(path, "utf-8").trim();
    return pem || null;
  } catch {
    return null;
  }
};
