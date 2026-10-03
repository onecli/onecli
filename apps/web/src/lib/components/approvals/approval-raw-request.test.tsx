// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PendingApproval } from "@/lib/api/approvals";
import { ApprovalRawRequest, formatRawBody } from "./approval-raw-request";

const approval = (over: Partial<PendingApproval> = {}): PendingApproval => ({
  id: "ap-1",
  method: "POST",
  url: "https://acme.my.salesforce.com/services/data/v60.0/sobjects/Contact",
  host: "acme.my.salesforce.com",
  path: "/services/data/v60.0/sobjects/Contact",
  headers: {},
  agent: { id: "a", name: "Ofer" },
  createdAt: "2026-09-30T00:00:00Z",
  expiresAt: "2026-09-30T00:03:00Z",
  ...over,
});

describe("ApprovalRawRequest", () => {
  it("pretty-prints JSON and leaves other text as sent", () => {
    expect(formatRawBody('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(formatRawBody('{"a":1')).toBe('{"a":1');
  });

  it("shows the request line and body, pretty-printed", () => {
    render(
      <ApprovalRawRequest
        approval={approval({
          rawBody: {
            text: '{"FirstName":"Test"}',
            truncated: false,
            binary: false,
          },
        })}
      />,
    );
    expect(screen.getByText(/^POST https:\/\/acme/)).toBeTruthy();
    expect(screen.getByText(/"FirstName": "Test"/)).toBeTruthy();
    expect(screen.queryByText(/Truncated/)).toBeNull();
  });

  it("renders markup in a body as text, never as HTML", () => {
    const { container } = render(
      <ApprovalRawRequest
        approval={approval({
          rawBody: {
            text: "<img src=x onerror=alert(1)>",
            truncated: false,
            binary: false,
          },
        })}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
  });

  it("says when secret fields were masked", () => {
    render(
      <ApprovalRawRequest
        approval={approval({
          rawBody: {
            text: '{"password":"***"}',
            truncated: false,
            binary: false,
            redacted: true,
          },
        })}
      />,
    );
    expect(screen.getByText(/Secret fields are shown as \*\*\*/)).toBeTruthy();
  });

  it("flags truncated and binary bodies", () => {
    const { unmount } = render(
      <ApprovalRawRequest
        approval={approval({
          rawBody: { text: "abc", truncated: true, binary: false },
        })}
      />,
    );
    expect(screen.getByText(/Truncated/)).toBeTruthy();
    unmount();
    render(
      <ApprovalRawRequest
        approval={approval({
          rawBody: { text: "", truncated: false, binary: true },
        })}
      />,
    );
    expect(screen.getByText(/Binary body/)).toBeTruthy();
  });
});
