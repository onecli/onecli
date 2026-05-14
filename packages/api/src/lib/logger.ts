import pino from "pino";
import { LOG_LEVEL, NODE_ENV } from "./env";

export const logger = pino({
  level: LOG_LEVEL,
  ...(NODE_ENV === "production"
    ? {
        formatters: {
          level: (label: string) => ({ level: label }),
        },
        timestamp: pino.stdTimeFunctions.isoTime,
      }
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
