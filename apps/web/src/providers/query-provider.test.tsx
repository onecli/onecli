// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useMutation, useQuery } from "@tanstack/react-query";

const notifyIfStaleBuild = vi.hoisted(() => vi.fn());
vi.mock("@/lib/stale-build", () => ({ notifyIfStaleBuild }));

import { QueryProvider } from "./query-provider";

const readFailure = new Error("read failed");
const writeFailure = new Error("write failed");

const FailingCalls = () => {
  useQuery({
    queryKey: ["failing-read"],
    queryFn: () => Promise.reject(readFailure),
    retry: false,
  });
  const write = useMutation({
    mutationFn: () => Promise.reject(writeFailure),
  });
  return <button onClick={() => write.mutate()}>Save</button>;
};

const handedErrors = () => notifyIfStaleBuild.mock.calls.map(([e]) => e);

describe("QueryProvider", () => {
  it("hands every failed read and write to the stale-build check", async () => {
    render(
      <QueryProvider>
        <FailingCalls />
      </QueryProvider>,
    );
    await waitFor(() => expect(handedErrors()).toContain(readFailure));

    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(handedErrors()).toContain(writeFailure));
  });
});
