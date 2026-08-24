import { afterEach, describe, expect, it } from "vitest";
import { initSelfUrl } from "../../providers/self-url";
import { ServiceError } from "../errors";
import {
  availableTransports,
  defaultTransport,
  resolveTransport,
} from "./posture";

/**
 * The transport posture table: edition × API-origin scheme. Edition is read
 * call-time (`isOnpremEdition`), so mutating process.env per test is safe —
 * as long as every mutation is restored (worker processes are reused).
 */

const ORIGINAL_EDITION = process.env.EDITION;
const ORIGINAL_PUBLIC_EDITION = process.env.NEXT_PUBLIC_EDITION;

const setEdition = (edition: "cloud" | "onprem") => {
  process.env.EDITION = edition;
  process.env.NEXT_PUBLIC_EDITION = edition;
};

afterEach(() => {
  if (ORIGINAL_EDITION === undefined) delete process.env.EDITION;
  else process.env.EDITION = ORIGINAL_EDITION;
  if (ORIGINAL_PUBLIC_EDITION === undefined)
    delete process.env.NEXT_PUBLIC_EDITION;
  else process.env.NEXT_PUBLIC_EDITION = ORIGINAL_PUBLIC_EDITION;
});

describe("availableTransports / defaultTransport", () => {
  it("cloud with a public https origin offers events only", () => {
    setEdition("cloud");
    initSelfUrl("https://api.example.test");
    expect(availableTransports()).toEqual(["events"]);
    expect(defaultTransport()).toBe("events");
  });

  it("onprem with a public https origin offers both, events first", () => {
    setEdition("onprem");
    initSelfUrl("https://api.example.test");
    expect(availableTransports()).toEqual(["events", "socket"]);
    expect(defaultTransport()).toBe("events");
  });

  it("onprem on localhost offers socket only", () => {
    setEdition("onprem");
    initSelfUrl("http://localhost:10256");
    expect(availableTransports()).toEqual(["socket"]);
    expect(defaultTransport()).toBe("socket");
  });

  it("cloud without https offers nothing — misconfiguration, not socket", () => {
    setEdition("cloud");
    initSelfUrl("http://localhost:10256");
    expect(availableTransports()).toEqual([]);
  });
});

describe("resolveTransport", () => {
  it("an omitted request keeps the deployment default", () => {
    setEdition("onprem");
    initSelfUrl("https://api.example.test");
    expect(resolveTransport(undefined)).toBe("events");
  });

  it("an explicit available request is honored", () => {
    setEdition("onprem");
    initSelfUrl("https://api.example.test");
    expect(resolveTransport("socket")).toBe("socket");
    expect(resolveTransport("events")).toBe("events");
  });

  it("refuses socket on cloud — the product clamp, not the URL scheme", () => {
    setEdition("cloud");
    initSelfUrl("https://api.example.test");
    expect(() => resolveTransport("socket")).toThrowError(ServiceError);
    expect(() => resolveTransport("socket")).toThrowError(/Socket Mode/);
  });

  it("refuses events without a public https origin", () => {
    setEdition("onprem");
    initSelfUrl("http://localhost:10256");
    expect(() => resolveTransport("events")).toThrowError(ServiceError);
    expect(() => resolveTransport("events")).toThrowError(/HTTPS/);
  });

  it("fails loudly on the degenerate cloud+http config instead of stamping socket", () => {
    setEdition("cloud");
    initSelfUrl("http://localhost:10256");
    expect(() => resolveTransport(undefined)).toThrowError(ServiceError);
  });
});
