// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useConnectParam } from "./use-connect-param";

const nav = vi.hoisted(() => ({
  params: new URLSearchParams(),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace }),
  usePathname: () => "/w/ws-1/connections",
  useSearchParams: () => nav.params,
}));

const run = (query: string, envDefaults = ["gmail"]) => {
  nav.params = new URLSearchParams(query);
  const onConnect = vi.fn();
  const onConfigure = vi.fn();
  renderHook(() =>
    useConnectParam({
      loading: false,
      connectedProviders: new Set(),
      configuredProviders: new Set(),
      envDefaultProviders: new Set(envDefaults),
      onConnect,
      onConfigure,
      onRequestApp: vi.fn(),
    }),
  );
  return Object.assign(onConnect, { onConfigure });
};

describe("useConnectParam", () => {
  beforeEach(() => nav.replace.mockClear());

  it("passes the gateway link's agent on, id included, so the connect lands on for it", () => {
    const onConnect = run(
      "connect=gmail&source=agent&agent_name=Arik&agent_id=agent-7",
    );
    expect(onConnect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "gmail" }),
      { name: "Arik", id: "agent-7" },
    );
    // The action params are consumed, so a reload never replays the connect.
    expect(nav.replace).toHaveBeenCalledWith("/w/ws-1/connections");
  });

  it("keeps a link minted before the gateway carried the id working, by name alone", () => {
    const onConnect = run("connect=gmail&source=agent&agent_name=Arik");
    expect(onConnect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "gmail" }),
      { name: "Arik", id: undefined },
    );
  });

  it("keeps the agent through an app that needs its credentials set up first", () => {
    // gmail with no credentials anywhere: configure first, then connect.
    const { onConfigure } = run(
      "connect=gmail&source=agent&agent_name=Arik&agent_id=agent-7",
      [],
    );
    expect(onConfigure).toHaveBeenCalledWith(
      expect.objectContaining({ id: "gmail" }),
      { name: "Arik", id: "agent-7" },
    );
  });

  it("names no agent for a plain workspace connect link", () => {
    const onConnect = run("connect=gmail&agent_id=agent-7");
    expect(onConnect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "gmail" }),
      undefined,
    );
  });
});
