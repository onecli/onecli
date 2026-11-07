import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ServiceError } from "../services/errors";
import { parseBody, parsed } from "./request-body";

const post = (body?: string) =>
  new Request("http://localhost/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

describe("parseBody", () => {
  it("returns the parsed JSON body", async () => {
    expect(await parseBody(post('{"a":1,"b":["c"]}'))).toEqual({
      a: 1,
      b: ["c"],
    });
  });

  it("returns null for a malformed body", async () => {
    expect(await parseBody(post("not json"))).toBeNull();
  });

  it("returns null for an empty body", async () => {
    expect(await parseBody(post())).toBeNull();
  });

  it("leaves the original body readable", async () => {
    const req = post('{"a":1}');
    await parseBody(req);
    expect(req.bodyUsed).toBe(false);
    expect(await req.json()).toEqual({ a: 1 });
  });
});

describe("parsed", () => {
  const schema = z.object({ name: z.string().min(1, "name is required") });

  it("returns the data of a successful parse", () => {
    expect(parsed(schema.safeParse({ name: "x" }), "fallback")).toEqual({
      name: "x",
    });
  });

  it("throws UNPROCESSABLE with the first issue's message", () => {
    let error: unknown;
    try {
      parsed(schema.safeParse({ name: "" }), "fallback");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ServiceError);
    expect(error).toMatchObject({
      code: "UNPROCESSABLE",
      message: "name is required",
    });
  });

  it("names only the first of several issues", () => {
    expect(() =>
      parsed(
        {
          success: false,
          error: { issues: [{ message: "first" }, { message: "second" }] },
        },
        "fallback",
      ),
    ).toThrow(new ServiceError("UNPROCESSABLE", "first"));
  });

  it("falls back when the first issue has no message", () => {
    expect(() =>
      parsed({ success: false, error: { issues: [{}] } }, "fallback"),
    ).toThrow(new ServiceError("UNPROCESSABLE", "fallback"));
  });

  it("falls back when there are no issues", () => {
    expect(() =>
      parsed({ success: false, error: { issues: [] } }, "fallback"),
    ).toThrow(new ServiceError("UNPROCESSABLE", "fallback"));
  });

  it("refuses a failure even when it carries data", () => {
    expect(() =>
      parsed(
        { success: false, data: 1, error: { issues: [{ message: "bad" }] } },
        "fallback",
      ),
    ).toThrow(new ServiceError("UNPROCESSABLE", "bad"));
  });

  it("refuses a success that carries no data", () => {
    expect(() => parsed({ success: true }, "fallback")).toThrow(
      new ServiceError("UNPROCESSABLE", "fallback"),
    );
  });
});
