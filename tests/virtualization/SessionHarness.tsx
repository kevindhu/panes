import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useCallback, useMemo, useRef, useState } from "react";
import { CodexTranscriptRenderer } from "../../src/components/chat/CodexTurnTranscript";
import { MessageBlocks } from "../../src/components/chat/MessageBlocks";
import { VirtualMessageTranscript, type VirtualMessageTranscriptHandle } from "../../src/components/codex/VirtualMessageTranscript";
import type { TranscriptRow } from "../../src/components/codex/transcriptRows";
import type { CodexTurnSnapshot, Message } from "../../src/types";
import type { ChatScrollPosition } from "../../src/lib/chatScrollPosition";
import { initializeCodexI18n } from "../../src/i18n/codex";
import "../../src/codex-base.css";
import "../../src/codex.css";

type Fixture = { messages: Message[]; snapshots: CodexTurnSnapshot[] };
const noApproval = () => {};
const frames = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(requestAnimationFrame); };
function SessionHarness() {
  const [fixture, setFixture] = useState<Fixture | null>(null);
  const [native, setNative] = useState<Record<string, TranscriptRow[]>>({});
  const [results, setResults] = useState<string[]>([]);
  const [width, setWidth] = useState(900);
  const [epoch, setEpoch] = useState(0);
  const [restore, setRestore] = useState<ChatScrollPosition | null>(null);
  const [running, setRunning] = useState(false);
  const saved = useRef<ChatScrollPosition | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const handle = useRef<VirtualMessageTranscriptHandle>(null);
  const publish = useCallback((id: string, rows: TranscriptRow[]) => setNative(current => ({ ...current, [id]: rows })), []);
  const snapshots = useMemo(() => new Map(fixture?.snapshots.map(snapshot => [snapshot.turn.messageId, { ...snapshot, display: true }])), [fixture]);
  const rows = useMemo(() => fixture?.messages.flatMap(message => message.role === "assistant" && native[message.id]
    ? native[message.id]!.map(row => ({ ...row, content: <article className="codex-message assistant codex-message-part">{row.content}</article> }))
    : [{ key: message.id, messageId: message.id, estimatedHeight: 100, content: <article className={`codex-message ${message.role}`}><MessageBlocks blocks={message.blocks ?? [{ type: "text", content: message.content ?? "" }]} onApproval={noApproval} /></article> }]) ?? [], [fixture, native]);
  async function load() {
    setRunning(true);
    try {
      const response = await fetch("/.agent-workspace/virtualization-session.json");
      if (!response.ok) throw new Error("Export the local fixture first (see README).");
      const data = await response.json() as Fixture;
      setFixture(data);
      setResults([`Loaded ${data.messages.length} messages / ${data.snapshots.length} native turns from the local audit copy.`]);
    } catch (error) { setResults([String(error)]); }
    setRunning(false);
  }
  const anchor = () => {
    const v = viewport.current!; const top = v.getBoundingClientRect().top;
    const row = [...v.querySelectorAll<HTMLElement>("[data-transcript-row]")].find(row => row.getBoundingClientRect().bottom > top + 1)!;
    return { key: row.dataset.transcriptRow!, offset: row.getBoundingClientRect().top - top };
  };
  const drift = (before: ReturnType<typeof anchor>) => {
    const node = [...viewport.current!.querySelectorAll<HTMLElement>("[data-transcript-row]")].find(row => row.dataset.transcriptRow === before.key);
    return node ? Math.abs(node.getBoundingClientRect().top - viewport.current!.getBoundingClientRect().top - before.offset) : Infinity;
  };
  async function run() {
    setRunning(true); const log: string[] = [];
    const check = async (name: string, action: () => Promise<string>) => {
      try { log.push(`PASS ${name}: ${await action()}`); } catch (error) { log.push(`FAIL ${name}: ${error}`); }
      setResults([...log]);
    };
    const assert = (value: boolean, message: string) => { if (!value) throw new Error(message); };
    await check("Latest and bounded DOM", async () => {
      handle.current!.scrollToEnd(); await frames(12);
      const v = viewport.current!; const gap = v.scrollHeight - v.clientHeight - v.scrollTop;
      const mounted = v.querySelectorAll("[data-transcript-row]").length;
      assert(gap < 2 && mounted < 60, `gap=${gap}, mounted=${mounted}`);
      return `${mounted}/${rows.length} rows; bottom gap ${gap}px`;
    });
    await check("Browsing the complete large session", async () => {
      const v = viewport.current!;
      let maxMounted = 0;
      for (const ratio of [0.8, 0.6, 0.4, 0.2, 0, 0.45]) {
        v.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
        v.scrollTop = (v.scrollHeight - v.clientHeight) * ratio;
        v.dispatchEvent(new Event("scroll")); await frames();
        maxMounted = Math.max(maxMounted, v.querySelectorAll("[data-transcript-row]").length);
        assert(v.querySelectorAll("[data-transcript-row]").length < 60, "Unbounded mounted rows");
      }
      return `maximum ${maxMounted} mounted rows`;
    });
    await check("Narrower pane retains reading anchor", async () => {
      const before = anchor(); flushSync(() => setWidth(520)); await frames(12);
      const delta = drift(before); assert(delta < 2, `drift=${delta}px`); return `drift=${delta}px`;
    });
    await check("Session remount retains reading anchor", async () => {
      const before = anchor(); const position = saved.current;
      flushSync(() => { setRestore(position); setEpoch(value => value + 1); }); await frames(12);
      const delta = drift(before); assert(delta < 2, `drift=${delta}px`); return `drift=${delta}px`;
    });
    setRunning(false);
  }
  return <main style={{ padding: 20, color: "var(--text-1)" }}>
    <h1>Local large-session audit</h1>
    <p>Production transcript projection and virtual rows. Local fixture only; no model requests. Native image IPC requires the desktop app.</p>
    <button disabled={running} onClick={() => void load()}>Load local audit fixture</button>
    <button disabled={running || !fixture || Object.keys(native).length !== snapshots.size} onClick={() => void run()}>Run session checks</button>
    <button onClick={() => handle.current?.scrollToEnd()}>Jump to latest</button>
    <p>{rows.length} logical rows; {Object.keys(native).length} loaded native turns</p>
    <ul>{results.map(result => <li key={result}>{result}</li>)}</ul>
    {fixture?.messages.filter(message => snapshots.has(message.id)).map(message => <CodexTranscriptRenderer key={message.id}
      snapshot={snapshots.get(message.id)!} status={message.status} legacyBlocks={message.blocks} onApproval={noApproval} onRows={publish} />)}
    <div style={{ width }}><div ref={viewport} tabIndex={0} className="codex-message-viewport is-virtualized" style={{ width: "100%", height: 650, flex: "none", border: "1px solid #888" }}>
      <VirtualMessageTranscript key={epoch} ref={handle} messages={[]} rows={rows} viewportRef={viewport} restorePosition={restore}
        selectedMessageRange={null} layoutRevision="session" renderMessage={() => null} onPositionChange={position => { saved.current = position; }} />
    </div></div>
  </main>;
}
void initializeCodexI18n().then(() => createRoot(document.getElementById("root")!).render(<SessionHarness />));
