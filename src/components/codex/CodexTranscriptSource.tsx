import { memo, useCallback, useMemo } from "react";
import type { ApprovalResponse, ContentBlock, Message } from "../../types";
import { CodexTurnTranscript } from "../chat/CodexTurnTranscript";
import type { PublishTranscriptRows } from "./transcriptRows";

// Mounted independently of the virtual rows: live updates and plan state keep
// running while the user reads history, and scrolling does not reload snapshots.
export const CodexTranscriptSource = memo(function CodexTranscriptSource({
  message, refreshSequence, workspaceRootPath, onRows, onApproval, onPlanText, hydrateActionOutput,
}: {
  message: Message;
  refreshSequence: number;
  workspaceRootPath: string;
  onRows: PublishTranscriptRows;
  onApproval: (id: string, response: ApprovalResponse) => void;
  onPlanText: (id: string, text: string | null) => void;
  hydrateActionOutput: (messageId: string, actionId: string) => Promise<void>;
}) {
  const blocks = useMemo<ContentBlock[]>(() => message.blocks ?? (message.content
    ? [{ type: "text", content: message.content }] : []), [message.blocks, message.content]);
  const loadOutput = useCallback((actionId: string) => hydrateActionOutput(message.id, actionId), [hydrateActionOutput, message.id]);
  return <CodexTurnTranscript messageId={message.id} blocks={blocks} status={message.status}
    tokenUsage={message.tokenUsage} refreshSequence={refreshSequence} workspaceRootPath={workspaceRootPath}
    onRows={onRows} onApproval={onApproval} onPlanText={onPlanText} onLoadActionOutput={loadOutput} />;
});
