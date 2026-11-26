"use client";

import { useRef, useState } from "react";
import type { ConnectResponse } from "@onecli/api/apps/connect-credentials";
import { Button } from "@onecli/ui/components/button";
import { useTestConnection } from "@/hooks/use-test-connection";
import type {
  ConnectionTestResponse,
  ConnectionTestScope,
} from "@/lib/api/connection-test";
import { ConnectionTestResult } from "@/lib/connections/connection-test-result";
import { CredentialsFlow, type CredentialsFlowProps } from "./credentials-flow";
import { ConnectLayout } from "./connect-layout";

const focusFeedback = (node: HTMLDivElement | null) => node?.focus();

/** Saving is not verification. Corrections update the same stored record. */
export const DatabaseCredentialsFlow = (props: CredentialsFlowProps) => {
  const test = useTestConnection();
  const [savedId, setSavedId] = useState(props.connectionId);
  const freshConnection = useRef<ConnectResponse["connection"]>(undefined);
  const [verified, setVerified] = useState<ConnectionTestResponse>();
  const [checking, setChecking] = useState(false);
  const checkingRef = useRef(false);
  const [checkError, setCheckError] = useState<Error | null>(null);
  const scope: ConnectionTestScope = props.orgId
    ? { kind: "organization", organizationId: props.orgId }
    : { kind: "workspace", workspaceId: props.workspaceId };

  const check = async (id: string) => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setVerified(undefined);
    setCheckError(null);
    setChecking(true);
    test.reset();
    try {
      if (!id.trim()) throw new Error("A saved connection is required.");
      const result = await test.mutateAsync({ connectionId: id, scope });
      if (result?.ok !== true || typeof result.superuser !== "boolean")
        throw new Error(
          "The gateway returned an invalid connection test result.",
        );
      setVerified(result);
    } finally {
      setChecking(false);
      checkingRef.current = false;
    }
  };
  const onSaved = async (response: ConnectResponse) => {
    setSavedId(response.connectionId);
    // Reconnect replies intentionally omit the attach marker. Do not lose the
    // original create marker when correcting a freshly-created connection.
    if (response.connection && !props.orgId)
      freshConnection.current = response.connection;
    await check(response.connectionId);
  };
  const formFields = [
    ...props.fields.filter((field) => !field.secret),
    ...props.fields.filter((field) => field.secret),
  ];

  return (
    <>
      <div hidden={!!verified} className="min-w-0 w-full max-w-md">
        <CredentialsFlow
          {...props}
          fields={formFields}
          connectionId={savedId}
          inlineErrors
          beforeSave={() => {
            const scopeId =
              scope.kind === "organization"
                ? scope.organizationId
                : scope.workspaceId;
            if (!scopeId?.trim())
              throw new Error("An explicit connection scope is required.");
          }}
          onSaved={onSaved}
          progressLabel={checking ? "Checking connection…" : undefined}
          preContent={
            <>
              {props.preContent}
              {checking && (
                <div tabIndex={-1} ref={focusFeedback}>
                  <ConnectionTestResult pending error={null} />
                </div>
              )}
              {checkError && (
                <div tabIndex={-1} ref={focusFeedback}>
                  <ConnectionTestResult pending={false} error={checkError} />
                  <p className="mt-1 text-xs text-muted-foreground dark:text-foreground/70">
                    Review the connection details below, then save and retry.
                  </p>
                </div>
              )}
            </>
          }
        />
      </div>
      {verified && (
        <ConnectLayout
          appName={props.app.name}
          appIcon={props.app.icon}
          appDarkIcon={props.app.darkIcon}
        >
          <div className="space-y-4 py-2">
            <div tabIndex={-1} ref={focusFeedback}>
              <ConnectionTestResult
                pending={false}
                result={verified}
                error={null}
              />
            </div>
            <Button
              type="button"
              className="min-h-11 w-full"
              onClick={() => {
                if (verified?.ok === true && !checkingRef.current)
                  props.onSuccess(freshConnection.current);
              }}
            >
              Continue
            </Button>
            <div className="flex justify-center">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="min-h-11 text-muted-foreground dark:text-foreground/70"
                onClick={() => {
                  if (savedId)
                    void check(savedId).catch((err) =>
                      setCheckError(
                        err instanceof Error
                          ? err
                          : new Error(
                              "Could not check the connection. Try again.",
                            ),
                      ),
                    );
                }}
              >
                Check again
              </Button>
            </div>
          </div>
        </ConnectLayout>
      )}
    </>
  );
};
