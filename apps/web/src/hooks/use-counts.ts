"use client";

import { useQuery } from "@tanstack/react-query";
import { counts } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";

export const useCounts = () =>
  useQuery({ queryKey: queryKeys.counts.all(), queryFn: counts.get });
