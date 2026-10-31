// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseCredentialsFlow } from "./database-credentials-flow";
import { apiFetch } from "@/lib/api-fetch";
import { testConnection } from "@/lib/api/connection-test";

vi.mock("@/lib/api-fetch", () => ({
  apiFetch: vi.fn(),
  getWorkspaceId: () => undefined,
  getOrganizationId: () => undefined,
}));
vi.mock("@/lib/api/connection-test", () => ({ testConnection: vi.fn() }));
const save = vi.mocked(apiFetch);
const test = vi.mocked(testConnection);
const response = (id = "saved", fresh = true) =>
  new Response(
    JSON.stringify({
      success: true,
      connectionId: id,
      ...(fresh ? { connection: { id, label: "DB" } } : {}),
    }),
  );
beforeEach(() => {
  save.mockReset();
  test.mockReset();
});
const setup = (connectionId?: string, orgId?: string, stalled = false) => {
  const onSuccess = vi.fn();
  const onError = vi.fn();
  const client = new QueryClient();
  if (stalled)
    vi.spyOn(client, "invalidateQueries").mockImplementation(
      () => new Promise(() => {}),
    );
  render(
    <QueryClientProvider client={client}>
      <DatabaseCredentialsFlow
        app={{
          id: "postgres",
          name: "PostgreSQL",
          icon: "/icons/postgres.svg",
          connectionType: "api_key",
        }}
        fields={[
          {
            name: "host",
            label: "Host",
            placeholder: "db.example.com",
            secret: false,
            description: "Database hostname",
          },
          {
            name: "password",
            label: "Password",
            placeholder: "Password",
            secret: true,
          },
          {
            name: "sslrootcert",
            label: "CA certificate",
            placeholder: "Certificate",
            optional: true,
            secret: false,
          },
        ]}
        connectionId={connectionId}
        workspaceId="w"
        orgId={orgId}
        onSuccess={onSuccess}
        onError={onError}
      />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByLabelText(/Host/), {
    target: { value: "db.example.com" },
  });
  fireEvent.change(screen.getByLabelText(/Password/), {
    target: { value: "secret" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
  fireEvent.change(screen.getByLabelText("CA certificate"), {
    target: { value: "certificate" },
  });
  return {
    onSuccess,
    onError,
    client,
    submit: () =>
      fireEvent.click(
        screen.getByRole("button", {
          name: /Connect PostgreSQL|Save and retry/,
        }),
      ),
  };
};
describe("verified database credentials", () => {
  it.each([undefined, "", " "])(
    "fails closed before saving when the database has no nonempty explicit scope %j",
    async (workspaceId) => {
      render(
        <QueryClientProvider client={new QueryClient()}>
          <DatabaseCredentialsFlow
            app={{
              id: "postgres",
              name: "PostgreSQL",
              icon: "/icons/postgresql.svg",
              connectionType: "api_key",
            }}
            fields={[
              {
                name: "password",
                label: "Password",
                placeholder: "Password",
                secret: true,
              },
            ]}
            workspaceId={workspaceId}
            onSuccess={vi.fn()}
            onError={vi.fn()}
          />
        </QueryClientProvider>,
      );
      fireEvent.change(screen.getByLabelText(/Password/), {
        target: { value: "secret" },
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Connect PostgreSQL" }),
      );
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "explicit connection scope",
      );
      expect(save).not.toHaveBeenCalled();
      expect(test).not.toHaveBeenCalled();
    },
  );
  it("presents PostgreSQL host database username password without changing registry storage order", async () => {
    const { postgres } = await import("@onecli/api/apps/postgres");
    if (postgres.connectionMethod.type !== "api_key")
      throw new Error("Expected credentials");
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <DatabaseCredentialsFlow
          app={{
            id: "postgres",
            name: "PostgreSQL",
            icon: "/icons/postgresql.svg",
            connectionType: "api_key",
          }}
          fields={postgres.connectionMethod.fields}
          workspaceId="w"
          onSuccess={() => {}}
          onError={() => {}}
        />
      </QueryClientProvider>,
    );
    expect(
      [...container.querySelectorAll("input")].map((input) => input.id),
    ).toEqual([
      "connect-host",
      "connect-database",
      "connect-username",
      "connect-password",
    ]);
    expect(postgres.connectionMethod.fields[0]?.name).toBe("password");
    // The mounted-form wrapper is itself a flex item. It must shrink at
    // narrow widths/large root fonts instead of inheriting min-width:auto.
    expect(container.firstElementChild).toHaveClass(
      "min-w-0",
      "w-full",
      "max-w-md",
    );
  });
  it.each([undefined, "existing"])(
    "retries workspace duplicate/reconnect %s against the returned record without creating an attach marker",
    async (connectionId) => {
      save
        .mockResolvedValueOnce(response("stored", false))
        .mockResolvedValueOnce(response("stored", false));
      test
        .mockRejectedValueOnce(new Error("Could not connect"))
        .mockResolvedValueOnce({ ok: true, superuser: false });
      const { submit, onSuccess } = setup(connectionId);
      submit();
      await screen.findByRole("alert");
      submit();
      await screen.findByText("Connection verified");
      expect(
        JSON.parse(String(save.mock.calls[1]?.[1]?.body)).connectionId,
      ).toBe("stored");
      expect(test.mock.calls[1]?.[0].scope).toEqual({
        kind: "workspace",
        workspaceId: "w",
      });
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      expect(onSuccess).toHaveBeenCalledWith(undefined);
    },
  );
  it("rejects malformed verification and focuses inline feedback without disrupting later edits", async () => {
    save.mockResolvedValue(response());
    test.mockResolvedValue(JSON.parse('{"ok":false}'));
    const { submit, onSuccess } = setup();
    submit();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveFocus();
    expect(alert).toHaveClass("dark:text-destructive-foreground");
    expect(alert).toHaveTextContent("invalid connection test result");
    const host = screen.getByLabelText(/Host/);
    await userEvent.type(host, "-corrected");
    expect(host).toHaveFocus();
    expect(host).toHaveValue("db.example.com-corrected");
    expect(onSuccess).not.toHaveBeenCalled();
  });
  it("keeps fields and Advanced mounted after failure, edits and updates saved ID on retry, retaining fresh marker", async () => {
    save
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response("saved", false));
    test
      .mockRejectedValueOnce(new Error("Network unavailable"))
      .mockResolvedValueOnce({ ok: true, superuser: false });
    const { submit, onSuccess } = setup(undefined, undefined, true);
    const password = screen.getByLabelText(/Password/);
    submit();
    await screen.findByRole("alert");
    expect(screen.getByLabelText(/Password/)).toBe(password);
    expect(password).toHaveValue("secret");
    expect(screen.getByLabelText("CA certificate")).toHaveValue("certificate");
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(onSuccess).not.toHaveBeenCalled();
    fireEvent.change(password, { target: { value: "corrected" } });
    submit();
    await screen.findByText("Connection verified");
    expect(JSON.parse(String(save.mock.calls[1]?.[1]?.body))).toMatchObject({
      connectionId: "saved",
      fields: { password: "corrected" },
    });
    expect(test.mock.calls.map(([input]) => input.connectionId)).toEqual([
      "saved",
      "saved",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onSuccess).toHaveBeenCalledWith({ id: "saved", label: "DB" });
  });
  it.each([undefined, "existing"])(
    "uses org scope and returned ID for create/reconnect %s without attach marker",
    async (id) => {
      save.mockResolvedValue(response(id ?? "org-created", false));
      test.mockResolvedValue({ ok: true, superuser: true });
      const { submit, onSuccess } = setup(id, "org");
      submit();
      await screen.findByText("Connection verified");
      expect(save.mock.calls[0]?.[0]).toBe("/v1/org/apps/postgres/connect");
      expect(test.mock.calls[0]?.[0]).toEqual({
        connectionId: id ?? "org-created",
        scope: { kind: "organization", organizationId: "org" },
      });
      expect(
        screen.getByRole("note", { name: "Elevated database access" }),
      ).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      expect(onSuccess).toHaveBeenCalledWith(undefined);
    },
  );
  it("guards rapid clicks and Enter, disables editing and shows specific save/check progress", async () => {
    let finish: (value: Response) => void = () => {};
    save.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    let checked: (value: { ok: true; superuser: boolean }) => void = () => {};
    test.mockImplementation(
      () =>
        new Promise((resolve) => {
          checked = resolve;
        }),
    );
    const { submit } = setup();
    act(() => {
      submit();
      submit();
    });
    await screen.findByRole("button", { name: "Saving connection…" });
    expect(save).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText(/Password/)).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Host/), "{Enter}");
    expect(save).toHaveBeenCalledTimes(1);
    finish(response());
    await screen.findByRole("button", { name: "Checking connection…" });
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    checked({ ok: true, superuser: false });
    await screen.findByText("Connection verified");
  });
  it.each(["refused", "malformed", "timeout"])(
    "does not verify or finish on %s save",
    async (failure) => {
      if (failure === "refused")
        save.mockResolvedValue(
          new Response(JSON.stringify({ error: { message: "Save refused" } }), {
            status: 403,
          }),
        );
      if (failure === "malformed")
        save.mockResolvedValue(new Response(JSON.stringify({ success: true })));
      if (failure === "timeout")
        save.mockRejectedValue(new Error("Saving timed out. Try again."));
      const { submit, onSuccess, onError } = setup();
      submit();
      await screen.findByRole("alert");
      expect(screen.getByLabelText(/Password/)).toHaveValue("secret");
      expect(test).not.toHaveBeenCalled();
      expect(onSuccess).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    },
  );
  it("clears previous verification before a later failed check", async () => {
    save.mockImplementation(async () => response());
    test
      .mockResolvedValueOnce({ ok: true, superuser: false })
      .mockRejectedValueOnce(
        new Error("The connection check timed out. Try again."),
      );
    const { submit, onSuccess } = setup();
    submit();
    await screen.findByText("Connection verified");
    expect(screen.getByRole("button", { name: "Continue" })).toHaveClass(
      "min-h-11",
    );
    expect(screen.getByRole("button", { name: "Check again" })).toHaveClass(
      "min-h-11",
    );
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await screen.findByRole("alert");
    expect(screen.queryByText("Connection verified")).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(onSuccess).not.toHaveBeenCalled();
  });
  it("submits with Enter and does not submit Advanced/password toggles, clears secret mutation variables", async () => {
    save.mockResolvedValue(response());
    test.mockRejectedValue(new Error("Unavailable"));
    const { client } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Show secret" }));
    expect(save).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText(/Password/), "{Enter}");
    await screen.findByRole("alert");
    await waitFor(() =>
      expect(
        client
          .getMutationCache()
          .getAll()
          .some((m) => JSON.stringify(m.state.variables)?.includes("secret")),
      ).toBe(false),
    );
  });
});

describe("reconnect prefill", () => {
  it("starts from the previous non-secret values and leads with a Name", async () => {
    save.mockResolvedValueOnce(response("pg-1", false));
    test.mockResolvedValueOnce({ ok: true, superuser: false });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <DatabaseCredentialsFlow
          app={{
            id: "postgres",
            name: "PostgreSQL",
            icon: "/icons/postgres.svg",
            connectionType: "api_key",
            database: { engine: "postgres" },
          }}
          fields={[
            { name: "host", label: "Host", placeholder: "h", secret: false },
            {
              name: "password",
              label: "Password",
              placeholder: "p",
              secret: true,
            },
          ]}
          connectionId="pg-1"
          prefill={{
            fields: { host: "db.example.com", password: "leaked" },
            label: "Orders",
          }}
          workspaceId="w"
          onSuccess={vi.fn()}
          onError={vi.fn()}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByLabelText("Name")).toHaveProperty("value", "Orders");
    expect(screen.getByLabelText(/Host/)).toHaveProperty(
      "value",
      "db.example.com",
    );
    // A secret is never prefilled, even if one were handed in.
    expect(screen.getByLabelText(/Password/)).toHaveProperty("value", "");
    fireEvent.change(screen.getByLabelText(/Password/), {
      target: { value: "new" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect PostgreSQL" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    const body = JSON.parse(String(save.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      connectionId: "pg-1",
      label: "Orders",
      fields: { host: "db.example.com", password: "new" },
    });
  });
});

describe("SSL-off message", () => {
  it("clears once the user changes TLS, the fix it names", async () => {
    const { ConnectionTestError } =
      await import("@/lib/api/connection-test-error");
    save.mockResolvedValueOnce(response("pg-ssl", false));
    test.mockRejectedValueOnce(
      new ConnectionTestError(
        "This server doesn't accept SSL. Change TLS to No encryption.",
        "SERVER_NO_TLS",
      ),
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <DatabaseCredentialsFlow
          app={{
            id: "postgres",
            name: "PostgreSQL",
            icon: "/icons/postgres.svg",
            connectionType: "api_key",
          }}
          fields={[
            { name: "host", label: "Host", placeholder: "h", secret: false },
            {
              name: "password",
              label: "Password",
              placeholder: "p",
              secret: true,
            },
            {
              name: "sslmode",
              label: "TLS",
              placeholder: "",
              optional: true,
              options: [
                { value: "require", label: "Encrypt only" },
                { value: "disable", label: "No encryption" },
              ],
              defaultValue: "require",
            },
          ]}
          workspaceId="w"
          onSuccess={vi.fn()}
          onError={vi.fn()}
        />
      </QueryClientProvider>,
    );
    fireEvent.change(screen.getByLabelText(/Host/), {
      target: { value: "db.example.com" },
    });
    fireEvent.change(screen.getByLabelText(/Password/), {
      target: { value: "pw" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect PostgreSQL" }));
    await screen.findByText(/doesn't accept SSL/);
    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    fireEvent.change(document.querySelector('select[name="sslmode"]')!, {
      target: { value: "disable" },
    });
    await waitFor(() =>
      expect(screen.queryByText(/doesn't accept SSL/)).toBeNull(),
    );
  });
});
