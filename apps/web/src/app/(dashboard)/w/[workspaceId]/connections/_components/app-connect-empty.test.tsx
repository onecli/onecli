// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppConnectEmpty } from "./app-connect-empty";

const renderEmpty = (
  props: Partial<React.ComponentProps<typeof AppConnectEmpty>> = {},
) => {
  const onConnect = vi.fn();
  render(
    <AppConnectEmpty
      appName="Resend"
      pageScope="workspace"
      onConnect={onConnect}
      {...props}
    />,
  );
  return { onConnect };
};

describe("AppConnectEmpty", () => {
  it("says nothing is connected and connects from its action", () => {
    const { onConnect } = renderEmpty();
    expect(
      screen.getByRole("region", { name: "No Resend account connected yet" }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Connect your Resend account" }),
    );
    expect(onConnect).toHaveBeenCalledOnce();
  });

  it("explains agent access on a workspace page", () => {
    renderEmpty();
    expect(
      screen.getByText(/choose which agents can use it/),
    ).toBeInTheDocument();
  });

  it("explains workspace sharing on the organization page", () => {
    renderEmpty({ pageScope: "organization" });
    expect(
      screen.getByText(/every workspace can turn it on/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/choose which agents can use it/)).toBeNull();
  });
});
