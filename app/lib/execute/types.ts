/**
 * Types for the execution engine (Phase 2, Section 3).
 *
 * The engine takes a diff (from Section 2) plus an explicit approval and applies
 * it — serially by default, re-reading by id after each mutation to confirm the
 * change actually took effect rather than trusting the mutation response.
 */

import type { DiffEntry } from "../diff/types";

/**
 * Explicit approval gate. The engine refuses to run without `approved: true`.
 * `approvedBy` is a free-text note carried into the audit log (Section 4).
 */
export interface ExecutionApproval {
  approved: boolean;
  approvedBy?: string;
}

export type LineItemStatus = "succeeded" | "failed" | "skipped";

/**
 * Outcome of one diff entry. `verified` means an independent re-read by id
 * confirmed the new value is actually in place — a mutation that returned
 * success but didn't take effect is `failed`, not `succeeded`.
 */
export interface LineItemResult {
  entry: DiffEntry;
  status: LineItemStatus;
  verified: boolean;
  error?: string;
}

export interface ExecutionResult {
  results: LineItemResult[];
  summary: {
    total: number;
    succeeded: number;
    failed: number;
    skipped: number;
  };
  durationMs: number;
}
