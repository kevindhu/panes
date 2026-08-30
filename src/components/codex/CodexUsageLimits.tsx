import { ChevronDown, RefreshCw } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import type { ContextUsage } from "../../types";

interface CodexUsageLimitsProps {
  usage: ContextUsage | null;
  threadId: string | null;
  planType?: string | null;
  onRefresh: (threadId: string) => Promise<unknown>;
}

interface UsageWindowRowProps {
  label: string;
  remainingPercent: number | null | undefined;
  resetsAt: string | null | undefined;
}

const POPOVER_WIDTH = 318;
const POPOVER_MARGIN = 10;

export function remainingToUsedPercent(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return 100 - Math.max(0, Math.min(100, Math.round(value)));
}

export function contextWindowUsedPercent(
  usage: ContextUsage | null | undefined,
): number | null {
  const currentTokens = usage?.currentTokens;
  const maxContextTokens = usage?.maxContextTokens;

  if (
    typeof currentTokens === "number" &&
    Number.isFinite(currentTokens) &&
    typeof maxContextTokens === "number" &&
    Number.isFinite(maxContextTokens) &&
    maxContextTokens > 0
  ) {
    return Math.max(
      0,
      Math.min(100, Math.round((Math.max(0, currentTokens) / maxContextTokens) * 100)),
    );
  }

  return remainingToUsedPercent(usage?.contextPercent);
}

export function formatTokenCount(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;

  const tokens = Math.max(0, Math.round(value));
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return String(tokens);
}

type ContextWindowSegmentKey =
  | "input"
  | "cache-write"
  | "cached"
  | "output"
  | "reasoning"
  | "other"
  | "used"
  | "free";

export interface ContextWindowSegment {
  key: ContextWindowSegmentKey;
  label: string;
  tokens: number;
  percent: number | null;
}

function finiteTokens(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : null;
}

function formatSegmentPercent(value: number | null): string {
  if (value === null) return "\u2014";
  return `${value.toFixed(1).replace(/\.0$/, "")}%`;
}

export function contextWindowSegments(
  usage: ContextUsage | null | undefined,
): ContextWindowSegment[] {
  const currentTokens = finiteTokens(usage?.currentTokens);
  const maxContextTokens = finiteTokens(usage?.maxContextTokens);
  if (currentTokens === null) return [];

  const usedTokens = maxContextTokens === null
    ? currentTokens
    : Math.min(currentTokens, maxContextTokens);
  const toSegment = (
    key: ContextWindowSegmentKey,
    label: string,
    tokens: number,
  ): ContextWindowSegment => ({
    key,
    label,
    tokens,
    percent: maxContextTokens !== null && maxContextTokens > 0
      ? (tokens / maxContextTokens) * 100
      : null,
  });

  const breakdown = usage?.breakdown;
  const occupied: ContextWindowSegment[] = [];
  if (breakdown) {
    const inputTokens = Math.min(finiteTokens(breakdown.inputTokens) ?? 0, usedTokens);
    const outputTokens = Math.min(
      finiteTokens(breakdown.outputTokens) ?? 0,
      Math.max(0, usedTokens - inputTokens),
    );
    const cachedInputTokens = Math.min(
      finiteTokens(breakdown.cachedInputTokens) ?? 0,
      inputTokens,
    );
    const cacheWriteInputTokens = Math.min(
      finiteTokens(breakdown.cacheWriteInputTokens) ?? 0,
      Math.max(0, inputTokens - cachedInputTokens),
    );
    const uncachedInputTokens = Math.max(
      0,
      inputTokens - cachedInputTokens - cacheWriteInputTokens,
    );
    const reasoningOutputTokens = Math.min(
      finiteTokens(breakdown.reasoningOutputTokens) ?? 0,
      outputTokens,
    );
    const regularOutputTokens = Math.max(0, outputTokens - reasoningOutputTokens);
    const otherTokens = Math.max(0, usedTokens - inputTokens - outputTokens);

    for (const [key, label, tokens] of [
      ["input", "Input context", uncachedInputTokens],
      ["cache-write", "Cache-write input", cacheWriteInputTokens],
      ["cached", "Cached input", cachedInputTokens],
      ["output", "Output", regularOutputTokens],
      ["reasoning", "Reasoning output", reasoningOutputTokens],
      ["other", "Other context", otherTokens],
    ] as const) {
      if (tokens > 0) occupied.push(toSegment(key, label, tokens));
    }
  } else if (usedTokens > 0) {
    occupied.push(toSegment("used", "Used context", usedTokens));
  }

  if (maxContextTokens !== null && maxContextTokens > 0) {
    occupied.push(toSegment("free", "Free space", Math.max(0, maxContextTokens - usedTokens)));
  }

  return occupied;
}

function usageTone(usedPercent: number | null): "normal" | "warning" | "danger" {
  if (usedPercent !== null && usedPercent >= 90) return "danger";
  if (usedPercent !== null && usedPercent >= 75) return "warning";
  return "normal";
}

function formatPlanType(planType: string | null | undefined): string | null {
  const normalized = planType?.trim();
  if (!normalized) return null;
  return normalized
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatResetTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const reset = new Date(value);
  if (!Number.isFinite(reset.getTime())) return null;

  const remainingMs = reset.getTime() - Date.now();
  if (remainingMs <= 0) return "Resetting soon";

  const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  if (remainingMinutes < 60) {
    return `Resets in ${remainingMinutes}m`;
  }
  if (remainingMinutes < 24 * 60) {
    const hours = Math.floor(remainingMinutes / 60);
    const minutes = remainingMinutes % 60;
    return `Resets in ${hours}h${minutes > 0 ? ` ${minutes}m` : ""}`;
  }

  return `Resets ${new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(reset)}`;
}

function UsageWindowRow({ label, remainingPercent, resetsAt }: UsageWindowRowProps) {
  const usedPercent = remainingToUsedPercent(remainingPercent);
  const tone = usageTone(usedPercent);
  const resetLabel = formatResetTime(resetsAt);

  return (
    <section className={`codex-usage-window ${tone}`}>
      <div className="codex-usage-window-copy">
        <span>{label}</span>
        {resetLabel && <small>{resetLabel}</small>}
        <strong>{usedPercent === null ? "—" : `${usedPercent}%`}</strong>
      </div>
      <div
        className="codex-usage-progress"
        role="progressbar"
        aria-label={`${label} usage`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={usedPercent ?? undefined}
      >
        <span style={{ width: `${usedPercent ?? 0}%` }} />
      </div>
    </section>
  );
}

function ContextWindowRow({ usage }: { usage: ContextUsage | null }) {
  const breakdownId = useId();
  const [expanded, setExpanded] = useState(false);
  const usedPercent = contextWindowUsedPercent(usage);
  const currentTokens = formatTokenCount(usage?.currentTokens);
  const maxContextTokens = formatTokenCount(usage?.maxContextTokens);
  const segments = contextWindowSegments(usage);
  const occupiedSegments = segments.filter((segment) => segment.key !== "free");
  const summary = currentTokens !== null && maxContextTokens !== null && usedPercent !== null
    ? `${currentTokens} / ${maxContextTokens} (${usedPercent}%)`
    : usedPercent !== null
      ? `${usedPercent}%`
      : "\u2014";

  return (
    <section className={`codex-context-window ${expanded ? "expanded" : ""}`}>
      <button
        className="codex-context-window-toggle"
        type="button"
        aria-expanded={expanded}
        aria-controls={breakdownId}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="codex-context-window-label">Context window</span>
        <strong>{summary}</strong>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      <div
        className="codex-context-progress"
        role="progressbar"
        aria-label="Context window usage"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={usedPercent ?? undefined}
        aria-valuetext={usedPercent === null ? undefined : summary}
      >
        {occupiedSegments.map((segment) => (
          <span
            key={segment.key}
            className={`codex-context-segment ${segment.key}`}
            data-context-segment={segment.key}
            style={{ width: `${segment.percent ?? 0}%` }}
            title={`${segment.label}: ${formatTokenCount(segment.tokens) ?? "0"} (${formatSegmentPercent(segment.percent)})`}
          />
        ))}
      </div>
      {expanded && (
        <div id={breakdownId} className="codex-context-breakdown">
          {segments.map((segment) => (
            <div className="codex-context-breakdown-row" key={segment.key}>
              <span className={`codex-context-swatch ${segment.key}`} aria-hidden="true" />
              <span>{segment.label}</span>
              <small>{formatTokenCount(segment.tokens) ?? "0"}</small>
              <strong>{formatSegmentPercent(segment.percent)}</strong>
            </div>
          ))}
          {usage?.breakdown && (
            <p>
              Codex groups system prompts, tools, skills, and messages inside input context.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

export function CodexUsageLimits({
  usage,
  threadId,
  planType,
  onRefresh,
}: CodexUsageLimitsProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const refreshRequestRef = useRef(0);
  const popoverId = useId();
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({});

  const fiveHourUsed = remainingToUsedPercent(usage?.windowFiveHourPercent);
  const weeklyUsed = remainingToUsedPercent(usage?.windowWeeklyPercent);
  const contextUsed = contextWindowUsedPercent(usage);
  const visiblePercentages = [contextUsed, fiveHourUsed, weeklyUsed].filter(
    (value): value is number => value !== null,
  );
  const wheelUsedPercent = visiblePercentages.length > 0
    ? Math.max(...visiblePercentages)
    : 22;
  const wheelTone = usageTone(visiblePercentages.length > 0 ? wheelUsedPercent : null);
  const formattedPlanType = formatPlanType(planType);
  const hasUsage = contextUsed !== null || fiveHourUsed !== null || weeklyUsed !== null;

  const updatePopoverPosition = useCallback(() => {
    const button = buttonRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const width = Math.min(POPOVER_WIDTH, window.innerWidth - POPOVER_MARGIN * 2);
    const left = Math.max(
      POPOVER_MARGIN,
      Math.min(rect.right - width, window.innerWidth - width - POPOVER_MARGIN),
    );
    setPopoverStyle({
      left,
      bottom: Math.max(POPOVER_MARGIN, window.innerHeight - rect.top + 8),
      width,
    });
  }, []);

  const refresh = useCallback(async () => {
    if (!threadId) return;
    const requestId = refreshRequestRef.current + 1;
    refreshRequestRef.current = requestId;
    setRefreshing(true);
    setRefreshError(false);
    try {
      await onRefresh(threadId);
    } catch (error) {
      console.warn("Failed to refresh Codex usage limits:", error);
      if (refreshRequestRef.current === requestId) {
        setRefreshError(true);
      }
    } finally {
      if (refreshRequestRef.current === requestId) {
        setRefreshing(false);
      }
    }
  }, [onRefresh, threadId]);

  useEffect(() => {
    setOpen(false);
  }, [threadId]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePopoverPosition();
    const update = () => updatePopoverPosition();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, updatePopoverPosition]);

  useEffect(() => {
    if (!open) return;
    const closeFromOutsideClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (buttonRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const closeFromEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("mousedown", closeFromOutsideClick);
    window.addEventListener("keydown", closeFromEscape);
    return () => {
      document.removeEventListener("mousedown", closeFromOutsideClick);
      window.removeEventListener("keydown", closeFromEscape);
    };
  }, [open]);

  const wheelStyle = {
    "--codex-usage-wheel-used": `${wheelUsedPercent}%`,
  } as CSSProperties;

  return (
    <div className="codex-usage-control">
      <button
        ref={buttonRef}
        className={`codex-usage-trigger ${wheelTone} ${refreshing ? "refreshing" : ""}`}
        type="button"
        aria-label="Show Codex usage limits"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        title="Usage limits"
        onClick={() => {
          if (!open) updatePopoverPosition();
          setOpen((current) => !current);
        }}
      >
        <span className="codex-usage-wheel" style={wheelStyle} aria-hidden="true" />
      </button>

      {open && typeof document !== "undefined" && createPortal(
        <div
          ref={popoverRef}
          id={popoverId}
          className="codex-usage-popover"
          role="dialog"
          aria-label="Codex usage limits"
          style={popoverStyle}
        >
          <ContextWindowRow usage={usage} />

          <header>
            <span>Plan usage limits{formattedPlanType ? ` · ${formattedPlanType}` : ""}</span>
            {refreshing && <small>Updating…</small>}
          </header>

          <div className="codex-usage-windows">
            <UsageWindowRow
              label="5-hour limit"
              remainingPercent={usage?.windowFiveHourPercent}
              resetsAt={usage?.windowFiveHourResetsAt}
            />
            <UsageWindowRow
              label="Weekly limit"
              remainingPercent={usage?.windowWeeklyPercent}
              resetsAt={usage?.windowWeeklyResetsAt}
            />
          </div>

          <footer>
            <button type="button" disabled={!threadId || refreshing} onClick={() => void refresh()}>
              <RefreshCw size={12} className={refreshing ? "codex-spin" : undefined} />
              {refreshError
                ? "Couldn’t refresh — try again"
                : !threadId
                  ? "Open a conversation to refresh"
                  : hasUsage
                    ? "Refresh usage"
                    : "Usage unavailable · Refresh"}
            </button>
          </footer>
        </div>,
        document.body,
      )}
    </div>
  );
}
