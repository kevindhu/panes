const PLAN_IMPLEMENTATION_PROMPT_STORAGE_KEY =
  "panes:pendingPlanImplementationPrompts:v1";

interface PendingPlanImplementationPromptRecord {
  threadId: string;
  createdAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizePendingPlanImplementationPromptRecord(
  value: unknown,
): PendingPlanImplementationPromptRecord | null {
  if (!isRecord(value)) {
    return null;
  }

  const threadId = typeof value.threadId === "string" ? value.threadId.trim() : "";
  if (!threadId) {
    return null;
  }

  return {
    threadId,
    createdAt:
      typeof value.createdAt === "string" && value.createdAt
        ? value.createdAt
        : new Date(0).toISOString(),
  };
}

export function planImplementationPromptLogOperationId(threadId: string): string {
  return `plan-prompt:${threadId}`;
}

export function readPendingPlanImplementationPromptRecords(): Record<
  string,
  PendingPlanImplementationPromptRecord
> {
  try {
    const raw = globalThis.localStorage?.getItem(PLAN_IMPLEMENTATION_PROMPT_STORAGE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return {};
    }

    const records: Record<string, PendingPlanImplementationPromptRecord> = {};
    for (const value of Object.values(parsed)) {
      const record = normalizePendingPlanImplementationPromptRecord(value);
      if (record) {
        records[record.threadId] = record;
      }
    }
    return records;
  } catch {
    return {};
  }
}

function persistPendingPlanImplementationPromptRecords(
  records: Record<string, PendingPlanImplementationPromptRecord>,
): void {
  try {
    globalThis.localStorage?.setItem(
      PLAN_IMPLEMENTATION_PROMPT_STORAGE_KEY,
      JSON.stringify(records),
    );
  } catch {
    // Ignore storage failures in non-browser/test environments.
  }
}

export function armPlanImplementationPrompt(threadId: string | null | undefined): void {
  const normalizedThreadId = threadId?.trim();
  if (!normalizedThreadId) {
    return;
  }

  const records = readPendingPlanImplementationPromptRecords();
  records[normalizedThreadId] = {
    threadId: normalizedThreadId,
    createdAt: records[normalizedThreadId]?.createdAt ?? new Date().toISOString(),
  };
  persistPendingPlanImplementationPromptRecords(records);
}

export function disarmPlanImplementationPrompt(threadId: string | null | undefined): void {
  const normalizedThreadId = threadId?.trim();
  if (!normalizedThreadId) {
    return;
  }

  const records = readPendingPlanImplementationPromptRecords();
  if (!(normalizedThreadId in records)) {
    return;
  }

  const { [normalizedThreadId]: _removed, ...nextRecords } = records;
  persistPendingPlanImplementationPromptRecords(nextRecords);
}

export function isPlanImplementationPromptArmed(
  threadId: string | null | undefined,
): boolean {
  const normalizedThreadId = threadId?.trim();
  if (!normalizedThreadId) {
    return false;
  }

  return normalizedThreadId in readPendingPlanImplementationPromptRecords();
}

export function listPendingPlanImplementationPromptThreadIds(): string[] {
  return Object.keys(readPendingPlanImplementationPromptRecords());
}
