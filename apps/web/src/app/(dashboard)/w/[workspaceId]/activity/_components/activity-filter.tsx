"use client";

import type { ActivityFilter } from "@onecli/api/validations/request-logs";
import { SegmentedFilter, type SegmentOption } from "./segmented-filter";

const OPTIONS: readonly SegmentOption<ActivityFilter>[] = [
  { value: "all", label: "All" },
  { value: "hide-llm", label: "Hide AI" },
  { value: "blocked", label: "Blocked" },
];

export const ActivityFilterControl = ({
  value,
  onChange,
}: {
  value: ActivityFilter;
  onChange: (value: ActivityFilter) => void;
}) => (
  <SegmentedFilter
    options={OPTIONS}
    value={value}
    onChange={onChange}
    label="Filter activity"
  />
);
