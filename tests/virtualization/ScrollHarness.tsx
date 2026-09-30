import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useMemo, useRef, useState } from "react";
import { VirtualMessageTranscript, type VirtualMessageTranscriptHandle } from "../../src/components/codex/VirtualMessageTranscript";
import type { TranscriptRow } from "../../src/components/codex/transcriptRows";
import type { ChatScrollPosition } from "../../src/lib/chatScrollPosition";
import { useTranscriptSelection } from "../../src/lib/transcriptSelection";
import { useTranscriptDisclosure } from "../../src/lib/transcriptViewState";
import "../../src/codex.css";

const frames = async (count = 5) => { for (let i = 0; i < count; i++) await new Promise(requestAnimationFrame); };
function Disclosure({ id }: { id: string }) {
  const [open, setOpen] = useTranscriptDisclosure(`harness:${id}`, false);
  return <><button onClick={() => setOpen(value => !value)} aria-expanded={open}>Inspect {id}</button>
    {open && <div style={{ height: 180 }}>Expanded details for {id}</div>}</>;
}

function Harness() {
  const viewport = useRef<HTMLDivElement>(null);
  const transcript = useRef<VirtualMessageTranscriptHandle>(null);
  const saved = useRef<ChatScrollPosition | null>(null);
  const { selectedMessageRange } = useTranscriptSelection({ rootRef: viewport, onActiveChange: active => { if (active) transcript.current?.cancelRestore(); } });
  const [restore, setRestore] = useState<ChatScrollPosition | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [hydrating, setHydrating] = useState(false);
  const [start, setStart] = useState(0);
  const [count, setCount] = useState(1200);
  const [grown, setGrown] = useState<Record<string, number>>({});
  const [width, setWidth] = useState(760);
  const [following, setFollowing] = useState(true);
  const [results, setResults] = useState<Array<{ name: string; outcome: string }>>([]);
  const [running, setRunning] = useState(false);
  const rows = useMemo<TranscriptRow[]>(() => Array.from({ length: count }, (_, i) => {
    const n = start + i;
    const id = `row-${n}`;
    return { key: id, messageId: `turn-${Math.floor(n / 200)}`, estimatedHeight: 100,
      content: <div style={{ padding: 10, borderBottom: "1px solid #888", background: n % 2 ? "#eee" : "white" }}>
        <strong>{id}</strong><p data-transcript-selection-scope={id} style={{ margin: "8px 0", lineHeight: "22px" }}>{("Transcript text with variable height and wrapping. ").repeat(Math.abs(n % 7) + 1)}</p>
        <Disclosure id={id} />
        {grown[id] ? <div style={{ height: grown[id], background: "#cbdcff" }}>Late image / streaming content</div> : null}
      </div> };
  }), [start, count, grown]);
  const readAnchor = () => {
    const v = viewport.current!;
    const top = v.getBoundingClientRect().top;
    const nodes = [...v.querySelectorAll<HTMLElement>("[data-transcript-row]")];
    const row = nodes.find(node => node.getBoundingClientRect().bottom > top + 1)!;
    return { key: row.dataset.transcriptRow!, offset: row.getBoundingClientRect().top - top };
  };
  const displacement = (before: ReturnType<typeof readAnchor>) => {
    const node = viewport.current!.querySelector<HTMLElement>(`[data-transcript-row="${before.key}"]`);
    return node ? Math.abs(node.getBoundingClientRect().top - viewport.current!.getBoundingClientRect().top - before.offset) : Infinity;
  };
  const browse = async (top: number) => {
    const v = viewport.current!;
    v.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
    v.scrollTop = top;
    v.dispatchEvent(new Event("scroll"));
    await frames();
  };
  async function run() {
    setRunning(true); setResults([]);
    const log: Array<{ name: string; outcome: string }> = [];
    const check = async (name: string, test: () => Promise<string>) => {
      try { log.push({ name, outcome: "PASS " + await test() }); }
      catch (error) { log.push({ name, outcome: "FAIL " + String(error) }); }
      setResults([...log]);
    };
    const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
    await check("Initial latest position and bounded DOM", async () => {
      transcript.current!.scrollToEnd(); await frames(12);
      const v = viewport.current!;
      const gap = v.scrollHeight - v.clientHeight - v.scrollTop;
      const mounted = v.querySelectorAll("[data-transcript-row]").length;
      assert(gap <= 2 && mounted < 50, `gap=${gap}, mounted=${mounted}`);
      return `gap=${gap}px, ${mounted}/${count} rows mounted`;
    });
    await check("Upward intent within the old 160px threshold", async () => {
      const v = viewport.current!;
      await browse(v.scrollTop - 70);
      const before = readAnchor();
      flushSync(() => setGrown(current => ({ ...current, [`row-${start + count - 1}`]: 430 })));
      await frames();
      const drift = displacement(before);
      assert(drift <= 2, `drift=${drift}`);
      return `anchor drift ${drift}px`;
    });
    await check("Late height growth above the reading anchor", async () => {
      await browse(viewport.current!.scrollHeight * 0.45);
      const before = readAnchor();
      const above = `row-${Number(before.key.slice(4)) - 2}`;
      flushSync(() => setGrown(current => ({ ...current, [above]: 600 })));
      await frames();
      const drift = displacement(before);
      assert(drift <= 2, `drift=${drift}`);
      return `anchor drift ${drift}px`;
    });
    await check("Prepending older history", async () => {
      const before = readAnchor();
      flushSync(() => { setStart(-80); setCount(1280); });
      await frames();
      const drift = displacement(before);
      assert(drift <= 2, `drift=${drift}`);
      return `anchor drift ${drift}px`;
    });
    await check("Width reflow preserves the logical row", async () => {
      const before = readAnchor();
      flushSync(() => setWidth(430)); await frames(10);
      const drift = displacement(before);
      assert(drift <= 2, `drift=${drift}, before=${JSON.stringify(before)}, after=${JSON.stringify(readAnchor())}, saved=${JSON.stringify(saved.current)}`);
      return `anchor drift ${drift}px`;
    });
    await check("Session remount restores row and offset", async () => {
      await browse(viewport.current!.scrollTop + 80);
      const before = readAnchor();
      const position = saved.current;
      flushSync(() => { setRestore(position); setEpoch(value => value + 1); });
      await frames(12);
      const drift = displacement(before);
      assert(drift <= 2, `drift=${drift}`);
      return `anchor drift ${drift}px`;
    });
    await check("Restoration waits for native rows to hydrate", async () => {
      const before = readAnchor(); const position = saved.current;
      flushSync(() => { setRestore(position); setHydrating(true); setEpoch(value => value + 1); });
      await frames();
      flushSync(() => setHydrating(false)); await frames(12);
      const drift = displacement(before);
      assert(drift <= 2, `drift=${drift}, saved=${JSON.stringify(saved.current)}`);
      return `anchor drift ${drift}px`;
    });
    await check("Expansion survives virtual unmount", async () => {
      const before = readAnchor();
      const button = viewport.current!.querySelector<HTMLButtonElement>(`[data-transcript-row="${before.key}"] button`)!;
      button.click(); await frames();
      const position = saved.current;
      await browse(0);
      flushSync(() => { setRestore(position); setEpoch(value => value + 1); });
      await frames(12);
      const restored = viewport.current!.querySelector<HTMLButtonElement>(`[data-transcript-row="${before.key}"] button`);
      assert(restored?.getAttribute("aria-expanded") === "true", `Expansion lost: key=${before.key}, saved=${JSON.stringify(position)}, restored=${restored?.getAttribute("aria-expanded")}, anchor=${JSON.stringify(readAnchor())}`);
      return "expanded details retained";
    });
    await check("Selection survives scrolling within one giant turn", async () => {
      const before = readAnchor();
      const paragraph = viewport.current!.querySelector(`[data-transcript-row="${before.key}"] p`)!;
      const selection = window.getSelection()!;
      const range = document.createRange(); range.selectNodeContents(paragraph);
      selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange")); await frames();
      const text = selection.toString();
      await browse(viewport.current!.scrollTop + 4000);
      assert(selection.toString() === text && text.length > 0, "Selected text was lost");
      const mounted = viewport.current!.querySelectorAll("[data-transcript-row]").length;
      assert(mounted < 60, `Selection mounted ${mounted} rows`);
      selection.removeAllRanges(); document.dispatchEvent(new Event("selectionchange"));
      return `selected text retained; ${mounted} rows mounted`;
    });
    await check("Keyboard focus survives virtual scrolling", async () => {
      const before = readAnchor();
      const button = viewport.current!.querySelector<HTMLButtonElement>(`[data-transcript-row="${before.key}"] button`)!;
      button.focus({ preventScroll: true });
      await browse(viewport.current!.scrollTop + 4000);
      assert(document.activeElement === button && button.isConnected, "Focused control was unmounted");
      button.blur(); return "focused control retained";
    });
    await check("Explicit latest follows subsequent growth", async () => {
      transcript.current!.scrollToEnd(); await frames(12);
      flushSync(() => setGrown(current => ({ ...current, "row-1199": 900 })));
      await frames();
      const v = viewport.current!;
      const gap = v.scrollHeight - v.clientHeight - v.scrollTop;
      assert(gap <= 2, `gap=${gap}`);
      return `gap=${gap}px`;
    });
    setRunning(false);
  }
  return <main style={{ font: "14px system-ui", color: "#222", padding: 20 }}>
    <h1>Panes scroll regression checks</h1>
    <p>Production virtualizer with 1,200 variable-height rows; no model or production data access.</p>
    <button disabled={running} onClick={() => void run()}>Run scroll checks</button>
    <button onClick={() => transcript.current!.scrollToEnd()}>Jump to latest</button>
    <span> {following ? "Following output" : "Reading history"}</span>
    <table><tbody>{results.map(result => <tr key={result.name}><td>{result.name}</td><td>{result.outcome}</td></tr>)}</tbody></table>
    <div ref={viewport} tabIndex={0} aria-label="Transcript" style={{ width, height: 540, overflow: "auto", overflowAnchor: "none", border: "1px solid #444", marginTop: 16 }}>
      <VirtualMessageTranscript key={epoch} ref={transcript} rows={hydrating ? [...new Set(rows.map(row => row.messageId))].map(id => ({ key: id, messageId: id, estimatedHeight: 100, content: <div style={{ height: 100 }}>Loading turn</div> })) : rows} messages={[]} viewportRef={viewport}
        restorePosition={restore} selectedMessageRange={selectedMessageRange} layoutRevision="harness"
        renderMessage={() => null} onFollowChange={setFollowing} onPositionChange={position => { saved.current = position; }} />
    </div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
