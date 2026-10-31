// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConnectionTestError } from "@/lib/api/connection-test-error";
import { ConnectionTestResult } from "./connection-test-result";

describe("ConnectionTestResult", () => {
  it("links the SSL guide when the server does not accept SSL", () => {
    render(
      <ConnectionTestResult
        pending={false}
        error={new ConnectionTestError("does not accept SSL", "SERVER_NO_TLS")}
      />,
    );
    expect(
      screen.getByRole("link", { name: "How to turn on SSL in PostgreSQL" }),
    ).toHaveAttribute("href", expect.stringContaining("ssl-tcp.html"));
  });

  it("shows only the message for any other failure", () => {
    render(
      <ConnectionTestResult
        pending={false}
        error={new ConnectionTestError("refused the login", "LOGIN_REJECTED")}
      />,
    );
    expect(screen.getByText("refused the login")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("ConnectionTestResult emphasis", () => {
  it("bolds the option to pick in the SSL-off message", () => {
    render(
      <ConnectionTestResult
        pending={false}
        error={
          new ConnectionTestError(
            "Turn on SSL, or change TLS to No encryption (not recommended).",
            "SERVER_NO_TLS",
          )
        }
      />,
    );
    expect(screen.getByText("No encryption").tagName).toBe("STRONG");
  });
});
