import { MessageSquare, RefreshCw, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ipc } from "../../lib/codexIpc";
import { activateThreadContext } from "../../lib/threadActivation";
import { useCodexUiStore } from "../../stores/codexUiStore";
import { useEngineStore } from "../../stores/engineStore";
import { useThreadStore } from "../../stores/threadStore";
import { useUpdateStore } from "../../stores/updateStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import type { SearchResult } from "../../types";

function highlightSnippet(snippet: string): string {
  return snippet.replace(/<mark>/g, "").replace(/<\/mark>/g, "");
}

export function CodexSearchOverlay() {
  const open = useCodexUiStore((state) => state.searchOpen);
  const setOpen = useCodexUiStore((state) => state.setSearchOpen);
  const workspace = useWorkspaceStore((state) => state.workspaces.find((item) => item.id === state.activeWorkspaceId) ?? null);
  const threads = useThreadStore((state) => state.threads);
  const refreshThreads = useThreadStore((state) => state.refreshThreads);
  const [query, setQuery] = useState("");
  const [messageResults, setMessageResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) window.setTimeout(() => inputRef.current?.focus(), 30);
    else setQuery("");
  }, [open]);

  useEffect(() => {
    if (!open || !workspace || query.trim().length < 2) {
      setMessageResults([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      void ipc.searchMessages(workspace.id, query.trim()).then((messages) => {
        if (!cancelled) {
          setMessageResults(messages.slice(0, 40));
        }
      }).finally(() => { if (!cancelled) setLoading(false); });
    }, 160);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [open, query, workspace]);

  const localThreads = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized || !workspace) return [];
    return threads.filter((thread) => thread.workspaceId === workspace.id && thread.title.toLowerCase().includes(normalized)).slice(0, 20);
  }, [query, threads, workspace]);

  if (!open || !workspace) return null;

  async function selectThread(threadId: string) {
    let thread = useThreadStore.getState().threads.find((item) => item.id === threadId) ?? null;
    if (!thread && workspace) {
      await refreshThreads(workspace.id);
      thread = useThreadStore.getState().threads.find((item) => item.id === threadId) ?? null;
    }
    if (thread) {
      setOpen(false);
      await activateThreadContext(thread);
    }
  }

  return (
    <div className="codex-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
      <div className="codex-search-dialog">
        <div className="codex-search-input"><Search size={16} /><input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }} placeholder="Search conversations…" /><button type="button" onClick={() => setOpen(false)}><X size={15} /></button></div>
        <div className="codex-search-results">
          {query.trim().length < 2 && <div className="codex-search-hint">Type at least two characters.</div>}
          {localThreads.map((thread) => <button key={`thread-${thread.id}`} type="button" onClick={() => void selectThread(thread.id)}><MessageSquare size={14} /><span><strong>{thread.title}</strong><small>Conversation</small></span></button>)}
          {messageResults.map((result) => <button key={`message-${result.messageId}`} type="button" onClick={() => void selectThread(result.threadId)}><MessageSquare size={14} /><span><strong>{result.threadTitle}</strong><small>{highlightSnippet(result.snippet)}</small></span></button>)}
          {loading && <div className="codex-search-hint">Searching…</div>}
          {!loading && query.trim().length >= 2 && !localThreads.length && !messageResults.length && <div className="codex-search-hint">No matches.</div>}
        </div>
      </div>
    </div>
  );
}

export function CodexSetupOverlay() {
  const open = useCodexUiStore((state) => state.setupOpen);
  const setOpen = useCodexUiStore((state) => state.setSetupOpen);
  const health = useEngineStore((state) => state.health.codex);
  const loading = useEngineStore((state) => state.healthLoading.codex);
  const ensureHealth = useEngineStore((state) => state.ensureHealth);
  const updateStatus = useUpdateStore((state) => state.status);
  const updateVersion = useUpdateStore((state) => state.version);
  const checkForUpdate = useUpdateStore((state) => state.checkForUpdate);
  const downloadAndInstall = useUpdateStore((state) => state.downloadAndInstall);

  useEffect(() => { if (open) void ensureHealth("codex", { force: true }); }, [ensureHealth, open]);
  if (!open) return null;

  return (
    <div className="codex-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
      <div className="codex-setup-dialog">
        <header><div><h2>Codex runtime</h2><p>Only the Codex app-server is used by this client.</p></div><button type="button" onClick={() => setOpen(false)}><X size={16} /></button></header>
        <div className={`codex-health-card ${health?.available ? "available" : "unavailable"}`}>
          <div><strong>{health?.available ? "Ready" : loading ? "Checking…" : "Unavailable"}</strong><span>{health?.version || health?.details || "Codex CLI was not detected."}</span></div>
          <button type="button" disabled={loading} onClick={() => void ensureHealth("codex", { force: true })}><RefreshCw size={13} /> Check again</button>
        </div>
        {health?.warnings?.map((warning) => <p className="codex-setup-warning" key={warning}>{warning}</p>)}
        {health?.fixes && health.fixes.length > 0 && <section><h3>Suggested fixes</h3>{health.fixes.map((fix) => <code key={fix}>{fix}</code>)}</section>}
        <section><h3>Updates</h3><div className="codex-update-row"><span>{updateStatus === "available" ? `Version ${updateVersion} is available.` : updateStatus === "ready" ? "Restarting…" : "Check for a newer Panes release."}</span>{updateStatus === "available" ? <button type="button" onClick={() => void downloadAndInstall()}>Install update</button> : <button type="button" disabled={updateStatus === "checking" || updateStatus === "downloading"} onClick={() => void checkForUpdate()}>Check</button>}</div></section>
      </div>
    </div>
  );
}
