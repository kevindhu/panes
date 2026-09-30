import type { ReactNode } from "react";

export interface TranscriptRow {
  key: string;
  messageId: string;
  content: ReactNode;
  estimatedHeight: number;
  revision?: string | number;
}

export type PublishTranscriptRows = (messageId: string, rows: TranscriptRow[]) => void;
