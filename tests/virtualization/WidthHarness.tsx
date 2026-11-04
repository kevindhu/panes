import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useCallback, useMemo, useRef, useState } from "react";
import { CodexTranscriptRenderer } from "../../src/components/chat/CodexTurnTranscript";
import { VirtualMessageTranscript } from "../../src/components/codex/VirtualMessageTranscript";
import type { TranscriptRow } from "../../src/components/codex/transcriptRows";
import type { ChatScrollPosition } from "../../src/lib/chatScrollPosition";
import type { CodexTurnSnapshot } from "../../src/types";
import { initializeCodexI18n } from "../../src/i18n/codex";
import "../../src/codex-base.css";
import "../../src/codex.css";

const longToken = "unbroken_payload_".repeat(140) + "END-SENTINEL";
const longPath = "C:\\workspace\\" + "long-directory-name\\".repeat(35);
const powershell = '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command \'pnpm typecheck\npnpm exec vitest run src/components/codex/VirtualMessageTranscript.test.tsx src/components/chat/CodexTurnTranscript.test.tsx --reporter=dot\'';
const payloads = [
  { id: "short", type: "commandExecution", command: "pwd", cwd: "C:\\workspace", aggregatedOutput: "C:\\workspace", exitCode: 0 },
  { id: "powershell", type: "commandExecution", command: powershell, cwd: "C:\\Users\\tester\\PROJECTS\\panes", commandActions: [{ command: powershell, type: "unknown" }], aggregatedOutput: "200", exitCode: 0 },
  { id: "web-request", type: "commandExecution", command: '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command \'(Invoke-WebRequest -Uri http://localhost:1430/tests/virtualization/ -UseBasicParsing).StatusCode\'', cwd: "C:\\Users\\tester\\PROJECTS\\panes", aggregatedOutput: "200", exitCode: 0 },
  { id: "encoded", type: "commandExecution", command: `pwsh -EncodedCommand ${longToken}`, cwd: longPath, commandActions: [{ command: longToken, type: "unknown" }], aggregatedOutput: longToken, exitCode: 0 },
  { id: "bash", type: "commandExecution", command: `/bin/bash -lc 'printf "%s" "${longToken}"'`, cwd: "/workspace/" + "directory/".repeat(40), aggregatedOutput: "stdout\n" + longToken, exitCode: 0 },
  { id: "tool", type: "mcpToolCall", server: "node_repl", tool: "js_" + longToken, arguments: { code: longToken }, result: { content: [{ type: "text", text: longToken }] } },
  { id: "search", type: "webSearch", query: longToken, action: { type: "search", queries: [longToken] } },
  { id: "reasoning", type: "reasoning", summary: [{ type: "summary_text", text: "Inspecting " + longToken }], content: [] },
  { id: "file", type: "fileChange", changes: [{ path: longPath + "file.ts", kind: "update", diff: "@@ -1 +1 @@\n-previous\n+" + longToken }] },
  { id: "unknown", type: "futureActivity", value: longToken },
];
const snapshot: CodexTurnSnapshot = {
  turn: { id: "width-turn", messageId: "width-turn", threadId: "width-thread", nativeThreadId: "width-thread", nativeTurnId: "width-turn",
    status: "completed", startedAtMs: 1000, completedAtMs: 6000, firstEventAtMs: 1000, lastEventAtMs: 6000,
    lastSourceSequence: 20, startedJson: null, completedJson: null, usageJson: null, planJson: null },
  items: payloads.map((payload, i) => ({ itemId: payload.id, itemType: payload.type, status: "completed", phase: null,
    firstSourceSequence: i + 1, lastSourceSequence: i + 1, startedAtMs: 1000, completedAtMs: 1234,
    startedJson: null, completedJson: JSON.stringify({ ...payload, status: "completed" }) })),
  chunks: [], events: [],
};
const frames = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise(requestAnimationFrame); };
const noApproval = () => {};
function WidthHarness() {
  const [native, setNative] = useState<TranscriptRow[]>([]);
  const [width, setWidth] = useState(900);
  const [virtual, setVirtual] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [restore, setRestore] = useState<ChatScrollPosition | null>(null);
  const [results, setResults] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const saved = useRef<ChatScrollPosition | null>(null);
  const publish = useCallback((_id: string, rows: TranscriptRow[]) => setNative(rows), []);
  const rows = useMemo<TranscriptRow[]>(() => [
    ...Array.from({ length: 300 }, (_, i) => ({ key: `before-${i}`, messageId: `before-${i}`, estimatedHeight: 40, content: <p>Earlier transcript row {i}</p> })),
    ...native.map(row => ({ ...row, content: <article className="codex-message assistant codex-message-part">{row.content}</article> })),
    ...Array.from({ length: 100 }, (_, i) => ({ key: `after-${i}`, messageId: `after-${i}`, estimatedHeight: 40, content: <p>Later transcript row {i}</p> })),
  ], [native]);
  const assert = (value: boolean, text: string) => { if (!value) throw new Error(text); };
  const widths = () => {
    const v = viewport.current!;
    const failures: string[] = [];
    for (const row of v.querySelectorAll<HTMLElement>(".codex-native-activity-row")) {
      const boundary = row.closest(".codex-native-transcript")!.getBoundingClientRect();
      const kind = row.dataset.itemType;
      for (const node of [row, ...row.querySelectorAll<HTMLElement>(".codex-native-activity-header,.codex-native-activity-details,.codex-native-detail-section,.codex-native-text-wrap,.codex-native-pre,.codex-native-diff-wrap,.codex-native-copy,.codex-native-duration")]) {
        const rect = node.getBoundingClientRect();
        const overflow = Math.max(rect.right - boundary.right, boundary.left - rect.left);
        if (overflow > 1) failures.push(`${kind}/${node.className}: ${Math.round(overflow)}px`);
      }
    }
    assert(failures.length === 0, failures.slice(0, 9).join("; "));
    assert(v.scrollWidth <= v.clientWidth + 1, `viewport overflow ${v.scrollWidth - v.clientWidth}px`);
  };
  async function run() {
    setRunning(true); setResults([]); const log: string[] = [];
    const check = async (name: string, action: () => Promise<string>) => {
      try { log.push(`PASS ${name}: ${await action()}`); } catch (error) { log.push(`FAIL ${name}: ${error}`); }
      setResults([...log]);
    };
    flushSync(() => { setVirtual(false); setWidth(900); setEpoch(n => n + 1); }); await frames();
    for (const expanded of [false, true]) {
      for (const button of viewport.current!.querySelectorAll<HTMLButtonElement>(".codex-native-activity-header")) {
        if (button.getAttribute("aria-expanded") !== String(expanded)) button.click();
      }
      await frames();
      if (expanded) {
        for (const summary of viewport.current!.querySelectorAll<HTMLElement>(".codex-native-raw-item:not([open]) > summary")) summary.click();
        await frames();
      }
      for (const size of [900, 520, 320, 220]) await check(`${expanded ? "Expanded with raw JSON" : "Collapsed"} at ${size}px`, async () => {
        flushSync(() => setWidth(size)); await frames(); widths(); return "all row bounds and controls contained";
      });
    }
    await check("Complete text and local JSON/diff scrolling", async () => {
      const v = viewport.current!;
      const commands = [...v.querySelectorAll<HTMLElement>(".codex-native-pre.command")];
      assert(commands.some(node => node.textContent === powershell), "PowerShell command was truncated or rewritten");
      assert(commands.some(node => node.textContent?.endsWith("END-SENTINEL")), "Long command content lost");
      assert(commands.every(node => node.scrollWidth <= node.clientWidth + 1), "Command does not wrap to its own box");
      const scrollable = [...v.querySelectorAll<HTMLElement>(".codex-native-pre.json,.codex-native-diff")].filter(node => node.scrollWidth > node.clientWidth + 1);
      assert(scrollable.length > 0, "No wide raw content exercised");
      for (const node of scrollable) { node.scrollLeft = node.scrollWidth; assert(node.scrollLeft > 0, "Local horizontal scrolling blocked"); }
      return `${scrollable.length} independently scrollable raw/diff blocks; exact command retained`;
    });
    for (const button of viewport.current!.querySelectorAll<HTMLButtonElement>('.codex-native-activity-header[aria-expanded="true"]')) button.click();
    await frames();
    const key = native.find(row => row.key.includes("/item:powershell"))!.key;
    const position = { scrollTop: 12000, nearBottom: false, distanceFromBottom: 4000, anchorMessageId: "width-turn", anchorRowId: key, anchorOffset: -8 };
    flushSync(() => { setWidth(900); setRestore(position); setVirtual(true); setEpoch(n => n + 1); }); await frames(10);
    const drift = () => {
      const node = [...viewport.current!.querySelectorAll<HTMLElement>("[data-transcript-row]")].find(node => node.dataset.transcriptRow === key);
      return node ? Math.abs(node.getBoundingClientRect().top - viewport.current!.getBoundingClientRect().top + 8) : Infinity;
    };
    await check("Virtual command expansion and narrower pane", async () => {
      const row = [...viewport.current!.querySelectorAll<HTMLElement>("[data-transcript-row]")].find(node => node.dataset.transcriptRow === key)!;
      row.querySelector<HTMLButtonElement>(".codex-native-activity-header")!.click(); await frames();
      flushSync(() => setWidth(320)); await frames(10); widths();
      assert(drift() <= 2, `anchor drift ${drift()}px`);
      const next = row.nextElementSibling as HTMLElement;
      assert(Math.abs(next.getBoundingClientRect().top - row.getBoundingClientRect().bottom) <= 2, "Reflowed command overlaps the next virtual row");
      return `anchor drift ${drift()}px; measured rows do not overlap`;
    });
    await check("Expanded command survives virtual unmount and restore", async () => {
      const position = saved.current;
      viewport.current!.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
      viewport.current!.scrollTop = 0; viewport.current!.dispatchEvent(new Event("scroll")); await frames();
      assert(![...viewport.current!.querySelectorAll<HTMLElement>("[data-transcript-row]")].some(row => row.dataset.transcriptRow === key), "Command never unmounted");
      flushSync(() => { setRestore(position); setEpoch(n => n + 1); }); await frames(10); widths();
      const row = [...viewport.current!.querySelectorAll<HTMLElement>("[data-transcript-row]")].find(node => node.dataset.transcriptRow === key)!;
      assert(row.querySelector(".codex-native-activity-header")?.getAttribute("aria-expanded") === "true" && drift() <= 2, `Expansion lost or anchor drift ${drift()}px`);
      return `expansion retained; anchor drift ${drift()}px`;
    });
    setRunning(false);
  }
  return <main style={{ padding: 20 }}><h1>Transcript width regression checks</h1>
    <p>Production native rows with PowerShell, Bash, long paths, tool calls, JSON, reasoning and diffs. Fixture strings are never executed.</p>
    <button disabled={running || !native.length} onClick={() => void run()}>Run width checks</button>
    <ul>{results.map(result => <li key={result}>{result}</li>)}</ul>
    <CodexTranscriptRenderer snapshot={snapshot} status="completed" onApproval={noApproval} onRows={publish} />
    <div style={{ width }}><div ref={viewport} className="codex-message-viewport is-virtualized" style={{ width: "100%", height: 560, flex: "none", border: "1px solid #888" }}>
      <VirtualMessageTranscript key={epoch} messages={[]} rows={rows} viewportRef={viewport} restorePosition={restore} virtualizationEnabled={virtual}
        selectedMessageRange={null} layoutRevision="width" renderMessage={() => null} onPositionChange={position => { saved.current = position; }} />
    </div></div>
  </main>;
}
void initializeCodexI18n().then(() => createRoot(document.getElementById("root")!).render(<WidthHarness />));
