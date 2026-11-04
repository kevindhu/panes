import type { ReactNode } from "react";

export interface TranscriptRow {
  key: string;
  messageId: string;
  content: ReactNode;
  estimatedHeight: number;
  revision?: string | number;
  /** Temporary compatibility row while its native snapshot is unresolved. */
  pending?: boolean;
}

export type PublishTranscriptRows = (messageId: string, rows: TranscriptRow[]) => void;
