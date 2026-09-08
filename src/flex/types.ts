/** Date overrides for a saved Activity Flex Query. */
export interface FlexReportRequest {
  readonly queryId: string;
  /** Inclusive report day, YYYYMMDD. */
  readonly fromDate: string;
  /** Inclusive report day, YYYYMMDD. */
  readonly toDate: string;
}

/** Raw attributes. Currency, timestamps, and amounts are never inferred. */
export interface FlexStatementEvidence {
  readonly statementAttributes: Readonly<Record<string, string>>;
  /** Null means absent; an explicit empty section is an empty array. */
  readonly cashTransactions: readonly Readonly<Record<string, string>>[] | null;
  readonly transfers: readonly Readonly<Record<string, string>>[] | null;
}

export type FlexStatementResult =
  | { readonly status: "pending"; readonly code: "1019" }
  | {
      readonly status: "ready";
      readonly observedAtEpochMillis: number;
      readonly statements: readonly FlexStatementEvidence[];
    };
