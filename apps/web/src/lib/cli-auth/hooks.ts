"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { getCliConnectOptions, confirmCliSession } from "./api";

export const useCliConnectOptions = () =>
  useQuery({
    queryKey: ["cli-connect-options"],
    queryFn: getCliConnectOptions,
  });

export const useConfirmCliSession = () =>
  useMutation({
    mutationFn: ({
      code,
      workspaceId,
    }: {
      code: string;
      workspaceId: string;
    }) => confirmCliSession(code, workspaceId),
  });
