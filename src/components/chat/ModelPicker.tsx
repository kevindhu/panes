import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ChevronRight, Search } from "lucide-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useEngineStore } from "../../stores/engineStore";
import { getHarnessIcon } from "../shared/HarnessLogos";
import type { EngineHealth, EngineInfo, EngineModel } from "../../types";
import { resolveReasoningEffortForModel } from "./reasoningEffort";

/* ── Props ── */

interface ModelPickerProps {
  engines: EngineInfo[];
  health: Record<string, EngineHealth>;
  selectedEngineId: string;
  selectedModelId: string | null;
  selectedEffort: string;
  onEngineModelChange: (engineId: string, modelId: string) => void;
  onEffortChange: (effort: string) => void;
  disabled?: boolean;
}

/* ── Helpers ── */

export interface OpenCodeProviderModelGroup {
  providerId: string;
  providerLabel: string;
  activeModels: EngineModel[];
  legacyModels: EngineModel[];
  totalModelCount: number;
}

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  azure: "Azure",
  bedrock: "Bedrock",
  github: "GitHub",
  google: "Google",
  groq: "Groq",
  local: "Local",
  mistral: "Mistral",
  ollama: "Ollama",
  openai: "OpenAI",
  opencode: "OpenCode",
  openrouter: "OpenRouter",
  vertex: "Vertex",
};

function formatModelName(name: string): string {
  const tokens: Record<string, string> = {
    gpt: "GPT",
    codex: "Codex",
    opencode: "OpenCode",
    claude: "Claude",
    opus: "Opus",
    sonnet: "Sonnet",
    haiku: "Haiku",
    mini: "Mini",
  };
  const slashParts = name
    .split("/")
    .filter(Boolean)
    .map((part) => part.trim())
    .filter(Boolean);
  const displayParts =
    slashParts.length > 2 && slashParts[0]?.toLowerCase() === "openrouter"
      ? slashParts.slice(2)
      : slashParts.length > 1
        ? slashParts.slice(1)
        : slashParts;
  const source = displayParts.length > 0 ? displayParts : [name];
  return source
    .map((part) =>
      part
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((s) => {
          const lower = s.toLowerCase();
          if (tokens[lower]) return tokens[lower];
          if (/^\d+(\.\d+)*$/.test(s)) return s;
          if (/^[a-z]?\d+(\.\d+)*$/i.test(s)) return s.toUpperCase();
          return s.charAt(0).toUpperCase() + s.slice(1);
        })
        .join(" "),
    )
    .join(" / ");
}

export function getOpenCodeProviderId(modelId: string): string {
  const parts = modelId
    .trim()
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length <= 1) {
    return "local";
  }
  if (parts[0]?.toLowerCase() === "openrouter" && parts.length > 2) {
    return parts[1].toLowerCase();
  }
  return parts[0].toLowerCase();
}

export function formatOpenCodeProviderName(providerId: string): string {
  const normalized = providerId.trim().toLowerCase();
  if (PROVIDER_LABELS[normalized]) {
    return PROVIDER_LABELS[normalized];
  }
  return normalized
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => PROVIDER_LABELS[part] ?? formatModelName(part))
    .join(" ");
}

export function groupOpenCodeModels(models: EngineModel[]): OpenCodeProviderModelGroup[] {
  const groups = new Map<string, OpenCodeProviderModelGroup>();
  for (const model of models) {
    const providerId = getOpenCodeProviderId(model.id);
    let group = groups.get(providerId);
    if (!group) {
      group = {
        providerId,
        providerLabel: formatOpenCodeProviderName(providerId),
        activeModels: [],
        legacyModels: [],
        totalModelCount: 0,
      };
      groups.set(providerId, group);
    }

    group.totalModelCount += 1;
    if (model.hidden) {
      group.legacyModels.push(model);
    } else {
      group.activeModels.push(model);
    }
  }

  return Array.from(groups.values());
}

export function filterOpenCodeModelsForQuery(
  models: EngineModel[],
  query: string,
): EngineModel[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return models;
  }

  return models.filter((model) => {
    const searchable = [
      model.id,
      model.displayName,
      model.description,
      formatModelName(model.displayName),
    ]
      .join(" ")
      .toLowerCase();
    return searchable.includes(normalized);
  });
}

export function formatCompactTokenLimit(tokens?: number | null): string | null {
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) {
    return null;
  }
  if (tokens >= 1_000_000) {
    const value = tokens / 1_000_000;
    return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    const value = tokens / 1_000;
    return `${value.toFixed(0)}K`;
  }
  return tokens.toString();
}

interface ModelMetadataChip {
  label: string;
  title?: string;
}

export function modelMetadataChips(
  t: TFunction<"chat">,
  model: EngineModel,
): ModelMetadataChip[] {
  const chips: ModelMetadataChip[] = [];
  const attachmentModalities = new Set(
    (model.attachmentModalities ?? []).map((modality) => modality.toLowerCase()),
  );

  if (attachmentModalities.has("image")) {
    chips.push({ label: t("modelPicker.metadata.vision") });
  }
  if (attachmentModalities.has("pdf")) {
    chips.push({ label: t("modelPicker.metadata.pdf") });
  }
  if (attachmentModalities.has("text")) {
    chips.push({ label: t("modelPicker.metadata.files") });
  } else if ((model.attachmentModalities ?? []).length === 0) {
    chips.push({ label: t("modelPicker.metadata.noFiles") });
  }

  const contextLimit = formatCompactTokenLimit(model.limits?.contextTokens);
  const inputLimit = formatCompactTokenLimit(model.limits?.inputTokens);
  const outputLimit = formatCompactTokenLimit(model.limits?.outputTokens);
  if (contextLimit) {
    chips.push({
      label: t("modelPicker.metadata.contextLimit", { tokens: contextLimit }),
    });
  } else if (inputLimit) {
    chips.push({
      label: t("modelPicker.metadata.inputLimit", { tokens: inputLimit }),
    });
  }
  if (outputLimit) {
    chips.push({
      label: t("modelPicker.metadata.outputLimit", { tokens: outputLimit }),
    });
  }

  return chips;
}

function shouldShowModelDescription(engineId: string, model: EngineModel): boolean {
  if (!model.description) {
    return false;
  }

  return !(engineId === "opencode" && model.description.trim() === "OpenCode model");
}

function shortEffortLabel(t: TFunction<"chat">, effort: string): string {
  switch (effort) {
    case "none": return t("modelPicker.effort.noneShort");
    case "minimal": return t("modelPicker.effort.minimalShort");
    case "low": return t("modelPicker.effort.lowShort");
    case "medium": return t("modelPicker.effort.mediumShort");
    case "high": return t("modelPicker.effort.highShort");
    case "xhigh": return t("modelPicker.effort.xhighShort");
    case "max": return t("modelPicker.effort.maxShort");
    default: return effort.charAt(0).toUpperCase() + effort.slice(1);
  }
}

function effortDisplayLabel(t: TFunction<"chat">, effort: string): string {
  switch (effort) {
    case "none": return t("modelPicker.effort.none");
    case "minimal": return t("modelPicker.effort.minimal");
    case "low": return t("modelPicker.effort.low");
    case "medium": return t("modelPicker.effort.medium");
    case "high": return t("modelPicker.effort.high");
    case "xhigh": return t("modelPicker.effort.xhigh");
    case "max": return t("modelPicker.effort.max");
    default: return effort.charAt(0).toUpperCase() + effort.slice(1);
  }
}

/* ── Component ── */

export function ModelPicker({
  engines,
  health,
  selectedEngineId,
  selectedModelId,
  selectedEffort,
  onEngineModelChange,
  onEffortChange,
  disabled = false,
}: ModelPickerProps) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const [activeEngineId, setActiveEngineId] = useState(selectedEngineId);
  const [activeOpenCodeProviderId, setActiveOpenCodeProviderId] = useState<string | null>(null);
  const [openCodeModelQuery, setOpenCodeModelQuery] = useState("");
  const [legacyExpanded, setLegacyExpanded] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const effortMenuRef = useRef<HTMLDivElement>(null);
  const wasOpenRef = useRef(false);
  const [pos, setPos] = useState({ bottom: 0, left: 0 });
  const ensureEngineHealth = useEngineStore((state) => state.ensureHealth);

  // Sync active engine when selection changes externally
  useEffect(() => {
    setActiveEngineId(selectedEngineId);
  }, [selectedEngineId]);

  // Reset legacy expanded when engine changes
  useEffect(() => {
    setLegacyExpanded(false);
  }, [activeEngineId]);

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) {
      return;
    }
    wasOpenRef.current = true;

    for (const engine of engines) {
      const engineHealth = health[engine.id];
      if (!engineHealth) {
        void ensureEngineHealth(engine.id);
        continue;
      }
      if (engineHealth.available === false) {
        void ensureEngineHealth(engine.id, { force: true });
      }
    }
  }, [engines, ensureEngineHealth, health, open]);

  // Position popover above trigger
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const popoverWidth = activeEngineId === "opencode" ? 680 : 440;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - popoverWidth - 8));
    setPos({
      bottom: window.innerHeight - rect.top + 6,
      left,
    });
  }, [activeEngineId, open]);

  // Click outside + Escape
  useEffect(() => {
    if (!open) return;

    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (
        triggerRef.current?.contains(target) ||
        popoverRef.current?.contains(target) ||
        effortMenuRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !effortMenuRef.current) setOpen(false);
    }

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  const toggle = useCallback(() => {
    if (disabled) return;
    setOpen((prev) => !prev);
  }, [disabled]);

  // Resolve current selection for trigger label
  const currentEngine = engines.find((e) => e.id === selectedEngineId) ?? engines[0];
  const currentModel =
    currentEngine?.models.find((m) => m.id === selectedModelId) ??
    currentEngine?.models.find((m) => !m.hidden) ??
    null;

  // Active engine in popover (for browsing)
  const browsingEngine = engines.find((e) => e.id === activeEngineId) ?? engines[0];
  const browsingModels = browsingEngine?.models ?? [];
  const activeModels = browsingModels.filter((m) => !m.hidden);
  const legacyModels = browsingModels.filter((m) => m.hidden);
  const openCodeProviderGroups = useMemo(
    () => groupOpenCodeModels(browsingModels),
    [browsingModels],
  );
  const selectedOpenCodeProviderId =
    selectedEngineId === "opencode" && selectedModelId
      ? getOpenCodeProviderId(selectedModelId)
      : null;
  const activeOpenCodeProvider =
    openCodeProviderGroups.find((group) => group.providerId === activeOpenCodeProviderId) ??
    openCodeProviderGroups.find((group) => group.providerId === selectedOpenCodeProviderId) ??
    openCodeProviderGroups[0] ??
    null;

  useEffect(() => {
    if (activeEngineId !== "opencode") {
      setActiveOpenCodeProviderId(null);
      setOpenCodeModelQuery("");
      return;
    }

    setActiveOpenCodeProviderId((current) => {
      if (current && openCodeProviderGroups.some((group) => group.providerId === current)) {
        return current;
      }
      return selectedOpenCodeProviderId ?? openCodeProviderGroups[0]?.providerId ?? null;
    });
  }, [activeEngineId, openCodeProviderGroups, selectedOpenCodeProviderId]);

  function handleModelSelect(engineId: string, modelId: string) {
    onEngineModelChange(engineId, modelId);
    // Keep popover open so the user can adjust reasoning effort
  }

  function renderFlatModelList() {
    return (
      <div className="mp-models-list">
        {activeModels.map((model) => (
          <ModelRow
            key={model.id}
            model={model}
            engineId={activeEngineId}
            isSelected={
              selectedEngineId === activeEngineId &&
              model.id === (selectedModelId ?? currentModel?.id)
            }
            selectedEffort={selectedEffort}
            onSelect={handleModelSelect}
            onEffortChange={onEffortChange}
            effortMenuRef={effortMenuRef}
          />
        ))}

        {legacyModels.length > 0 && (
          <>
            <button
              type="button"
              className="mp-legacy-toggle"
              onClick={() => setLegacyExpanded((prev) => !prev)}
            >
              <span className="mp-legacy-toggle-label">
                {t("modelPicker.legacy", { count: legacyModels.length })}
              </span>
              <ChevronRight
                size={11}
                className={`mp-legacy-chevron${legacyExpanded ? " mp-legacy-chevron-open" : ""}`}
              />
            </button>
            {legacyExpanded &&
              legacyModels.map((model) => (
                <ModelRow
                  key={model.id}
                  model={model}
                  engineId={activeEngineId}
                  isSelected={
                    selectedEngineId === activeEngineId &&
                    model.id === (selectedModelId ?? currentModel?.id)
                  }
                  selectedEffort={selectedEffort}
                  onSelect={handleModelSelect}
                  onEffortChange={onEffortChange}
                  effortMenuRef={effortMenuRef}
                />
              ))}
          </>
        )}
      </div>
    );
  }

  function renderOpenCodeProviderTree() {
    const provider = activeOpenCodeProvider;
    const providerActiveModels = provider
      ? filterOpenCodeModelsForQuery(provider.activeModels, openCodeModelQuery)
      : [];
    const providerLegacyModels = provider
      ? filterOpenCodeModelsForQuery(provider.legacyModels, openCodeModelQuery)
      : [];
    const providerVisibleCount = providerActiveModels.length + providerLegacyModels.length;
    return (
      <div className="mp-provider-tree">
        <div className="mp-provider-list">
          <div className="mp-provider-list-heading">{t("modelPicker.providers")}</div>
          {openCodeProviderGroups.map((group) => {
            const isActive = group.providerId === provider?.providerId;
            const isSelected = group.providerId === selectedOpenCodeProviderId;
            return (
              <button
                key={group.providerId}
                type="button"
                className={`mp-provider-row${isActive ? " mp-provider-row-active" : ""}${isSelected ? " mp-provider-row-selected" : ""}`}
                onClick={() => {
                  setLegacyExpanded(false);
                  setActiveOpenCodeProviderId(group.providerId);
                }}
              >
                <span className="mp-provider-name">{group.providerLabel}</span>
                <span className="mp-provider-count">{group.totalModelCount}</span>
                <ChevronRight size={12} className="mp-provider-chevron" />
              </button>
            );
          })}
        </div>

        <div className="mp-provider-models">
          <div className="mp-model-search">
            <Search size={12} className="mp-model-search-icon" />
            <input
              className="mp-model-search-input"
              value={openCodeModelQuery}
              onChange={(event) => setOpenCodeModelQuery(event.target.value)}
              placeholder={t("modelPicker.searchModels")}
              aria-label={t("modelPicker.searchModels")}
            />
            {provider ? (
              <span className="mp-model-search-count">
                {openCodeModelQuery.trim()
                  ? `${providerVisibleCount}/${provider.totalModelCount}`
                  : provider.totalModelCount}
              </span>
            ) : null}
          </div>

          <div className="mp-models-list mp-models-list-provider">
            {providerActiveModels.map((model) => (
              <ModelRow
                key={model.id}
                model={model}
                engineId={activeEngineId}
                isSelected={
                  selectedEngineId === activeEngineId &&
                  model.id === (selectedModelId ?? currentModel?.id)
                }
                selectedEffort={selectedEffort}
                onSelect={handleModelSelect}
                onEffortChange={onEffortChange}
                effortMenuRef={effortMenuRef}
              />
            ))}

            {provider && providerLegacyModels.length > 0 && (
              <>
                <button
                  type="button"
                  className="mp-legacy-toggle"
                  onClick={() => setLegacyExpanded((prev) => !prev)}
                >
                  <span className="mp-legacy-toggle-label">
                    {t("modelPicker.legacy", { count: providerLegacyModels.length })}
                  </span>
                  <ChevronRight
                    size={11}
                    className={`mp-legacy-chevron${legacyExpanded ? " mp-legacy-chevron-open" : ""}`}
                  />
                </button>
                {legacyExpanded &&
                  providerLegacyModels.map((model) => (
                    <ModelRow
                      key={model.id}
                      model={model}
                      engineId={activeEngineId}
                      isSelected={
                        selectedEngineId === activeEngineId &&
                        model.id === (selectedModelId ?? currentModel?.id)
                      }
                      selectedEffort={selectedEffort}
                      onSelect={handleModelSelect}
                      onEffortChange={onEffortChange}
                      effortMenuRef={effortMenuRef}
                    />
                  ))}
              </>
            )}
            {provider && providerVisibleCount === 0 ? (
              <div className="mp-empty">{t("modelPicker.noModels")}</div>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  // Build trigger label
  const triggerLabel = currentModel
    ? formatModelName(currentModel.displayName)
    : currentEngine?.name ?? t("modelPicker.selectModel");

  /* ── Trigger ── */
  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      className={`mp-trigger${open ? " mp-trigger-open" : ""}`}
      onClick={toggle}
      disabled={disabled}
      title={t("modelPicker.selectModel")}
    >
      <span className="mp-trigger-icon">
        {getHarnessIcon(selectedEngineId, 12)}
      </span>
      <span className="mp-trigger-label">{triggerLabel}</span>
      {selectedEffort && currentModel?.supportedReasoningEfforts?.length ? (
        <span className="mp-trigger-effort">{shortEffortLabel(t, selectedEffort)}</span>
      ) : null}
      <ChevronDown
        size={10}
        className={`mp-trigger-chevron${open ? " mp-trigger-chevron-open" : ""}`}
      />
    </button>
  );

  /* ── Popover ── */
  const popover = open
    ? createPortal(
        <div
          ref={popoverRef}
          className={`mp-popover${browsingEngine?.id === "opencode" ? " mp-popover-opencode" : ""}`}
          style={{
            position: "fixed",
            bottom: pos.bottom,
            left: pos.left,
          }}
        >
          {/* Engine rail */}
          <div className="mp-rail">
            <div className="mp-rail-label">{t("modelPicker.engine")}</div>
            {engines.map((engine) => {
              const isActive = engine.id === activeEngineId;
              const engineHealth = health[engine.id];
              const available = engineHealth?.available !== false;
              return (
                <button
                  key={engine.id}
                  type="button"
                  className={`mp-rail-engine${isActive ? " mp-rail-engine-active" : ""}`}
                  onClick={() => setActiveEngineId(engine.id)}
                >
                  <span className="mp-rail-engine-icon">
                    {getHarnessIcon(engine.id, 15)}
                  </span>
                  <span className="mp-rail-engine-name">{engine.name}</span>
                  <span
                    className={`mp-rail-dot${available ? " mp-rail-dot-ok" : " mp-rail-dot-err"}`}
                  />
                </button>
              );
            })}
          </div>

          {/* Models panel */}
          <div className="mp-models">
            {browsingEngine?.id !== "opencode" ? (
              <div className="mp-models-header">
                <span className="mp-models-title">{t("modelPicker.models")}</span>
                <span className="mp-models-count">{activeModels.length}</span>
              </div>
            ) : null}

            {browsingEngine?.id === "opencode"
              ? renderOpenCodeProviderTree()
              : renderFlatModelList()}
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <div className="mp-root">
      {trigger}
      {popover}
    </div>
  );
}

/* ── Model Row ── */

interface EffortMenuPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  placement: "top" | "bottom";
  ready: boolean;
}

const EFFORT_MENU_WIDTH = 264;
const EFFORT_MENU_MAX_HEIGHT = 320;
const EFFORT_MENU_GAP = 4;
const EFFORT_MENU_MARGIN = 8;

function reasoningEffortsMatch(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function ReasoningEffortDropdown({
  model,
  selectedEffort,
  onChange,
  menuRef,
}: {
  model: EngineModel;
  selectedEffort: string;
  onChange: (effort: string) => void;
  menuRef: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation("chat");
  const listboxId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const efforts = model.supportedReasoningEfforts ?? [];
  const effectiveEffort =
    resolveReasoningEffortForModel(model, selectedEffort) ??
    efforts[0]?.reasoningEffort ??
    selectedEffort;
  const selectedIndex = Math.max(
    0,
    efforts.findIndex((option) =>
      reasoningEffortsMatch(option.reasoningEffort, effectiveEffort),
    ),
  );
  const selectedOption = efforts[selectedIndex] ?? null;
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const [position, setPosition] = useState<EffortMenuPosition>({
    top: 0,
    left: 0,
    width: EFFORT_MENU_WIDTH,
    maxHeight: EFFORT_MENU_MAX_HEIGHT,
    placement: "bottom",
    ready: false,
  });

  const closeMenu = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) {
      triggerRef.current?.focus();
    }
  }, []);

  const openMenu = useCallback((initialIndex: number) => {
    setActiveIndex(initialIndex);
    setPosition((current) => ({ ...current, ready: false }));
    setOpen(true);
  }, []);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) {
      return;
    }

    const rect = trigger.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const width = Math.min(
      EFFORT_MENU_WIDTH,
      Math.max(0, viewportWidth - EFFORT_MENU_MARGIN * 2),
    );
    const maxHeight = Math.min(
      EFFORT_MENU_MAX_HEIGHT,
      Math.max(0, viewportHeight - EFFORT_MENU_MARGIN * 2),
    );
    const estimatedHeight = efforts.length * 52 + 8;
    const menuHeight = Math.min(
      menuRef.current?.scrollHeight ?? estimatedHeight,
      maxHeight,
    );
    const spaceBelow = viewportHeight - rect.bottom - EFFORT_MENU_GAP - EFFORT_MENU_MARGIN;
    const spaceAbove = rect.top - EFFORT_MENU_GAP - EFFORT_MENU_MARGIN;
    const placement =
      spaceBelow >= menuHeight || spaceBelow >= spaceAbove ? "bottom" : "top";
    const idealTop =
      placement === "bottom"
        ? rect.bottom + EFFORT_MENU_GAP
        : rect.top - menuHeight - EFFORT_MENU_GAP;
    const top = Math.max(
      EFFORT_MENU_MARGIN,
      Math.min(idealTop, viewportHeight - menuHeight - EFFORT_MENU_MARGIN),
    );
    const maxLeft = Math.max(
      EFFORT_MENU_MARGIN,
      viewportWidth - width - EFFORT_MENU_MARGIN,
    );
    const left = Math.max(
      EFFORT_MENU_MARGIN,
      Math.min(rect.right - width, maxLeft),
    );

    setPosition({ top, left, width, maxHeight, placement, ready: true });
  }, [efforts.length, menuRef]);

  useLayoutEffect(() => {
    if (open) {
      updatePosition();
    }
  }, [open, updatePosition]);

  useLayoutEffect(() => {
    if (open && position.ready) {
      menuRef.current?.focus();
    }
  }, [menuRef, open, position.ready]);

  useEffect(() => {
    if (!open) {
      return;
    }

    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (
        triggerRef.current?.contains(target) ||
        menuRef.current?.contains(target)
      ) {
        return;
      }
      closeMenu();
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
    }

    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [closeMenu, menuRef, open, updatePosition]);

  useEffect(() => {
    setActiveIndex(selectedIndex);
  }, [selectedIndex]);

  function selectEffort(index: number) {
    const option = efforts[index];
    if (!option) {
      return;
    }
    onChange(option.reasoningEffort);
    closeMenu(true);
  }

  function handleTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      openMenu(selectedIndex);
    } else if (event.key === "Home") {
      event.preventDefault();
      openMenu(0);
    } else if (event.key === "End") {
      event.preventDefault();
      openMenu(Math.max(0, efforts.length - 1));
    }
  }

  function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % efforts.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => (current - 1 + efforts.length) % efforts.length);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(Math.max(0, efforts.length - 1));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectEffort(activeIndex);
    } else if (event.key === "Tab") {
      closeMenu(true);
    }
  }

  if (!selectedOption) {
    return null;
  }

  const selectedLabel = effortDisplayLabel(t, selectedOption.reasoningEffort);
  const triggerId = `${listboxId}-trigger`;
  const activeOptionId = `${listboxId}-option-${activeIndex}`;
  const menu = open
    ? createPortal(
        <div
          ref={menuRef}
          id={listboxId}
          className="mp-effort-menu"
          role="listbox"
          tabIndex={-1}
          aria-labelledby={triggerId}
          aria-activedescendant={activeOptionId}
          data-placement={position.placement}
          onKeyDown={handleMenuKeyDown}
          style={{
            position: "fixed",
            top: position.top,
            left: position.left,
            width: position.width,
            maxHeight: position.maxHeight,
            visibility: position.ready ? "visible" : "hidden",
          }}
        >
          {efforts.map((option, index) => {
            const isSelected = reasoningEffortsMatch(
              option.reasoningEffort,
              effectiveEffort,
            );
            const isDefault = reasoningEffortsMatch(
              option.reasoningEffort,
              model.defaultReasoningEffort,
            );
            const isActive = index === activeIndex;
            return (
              <button
                key={option.reasoningEffort}
                id={`${listboxId}-option-${index}`}
                type="button"
                role="option"
                aria-selected={isSelected}
                className={`mp-effort-option${isSelected ? " mp-effort-option-selected" : ""}${isActive ? " mp-effort-option-active" : ""}`}
                onMouseMove={() => setActiveIndex(index)}
                onClick={() => selectEffort(index)}
              >
                <span className="mp-effort-option-copy">
                  <span className="mp-effort-option-heading">
                    <span className="mp-effort-option-name">
                      {effortDisplayLabel(t, option.reasoningEffort)}
                    </span>
                    {isDefault ? (
                      <span className="mp-effort-option-default">
                        {t("modelPicker.default")}
                      </span>
                    ) : null}
                  </span>
                  {option.description ? (
                    <span className="mp-effort-option-description">
                      {option.description}
                    </span>
                  ) : null}
                </span>
                {isSelected ? <Check size={13} className="mp-effort-option-check" /> : null}
              </button>
            );
          })}
        </div>,
        document.body,
      )
    : null;

  return (
    <div className="mp-effort-select">
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        className={`mp-effort-trigger${open ? " mp-effort-trigger-open" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={`${t("modelPicker.thinking")}: ${selectedLabel}`}
        title={selectedOption.description || selectedLabel}
        onClick={() => (open ? closeMenu() : openMenu(selectedIndex))}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="mp-effort-trigger-label">{selectedLabel}</span>
        <ChevronDown size={11} className="mp-effort-trigger-chevron" />
      </button>
      {menu}
    </div>
  );
}

function ModelRow({
  model,
  engineId,
  isSelected,
  selectedEffort,
  onSelect,
  onEffortChange,
  effortMenuRef,
}: {
  model: EngineModel;
  engineId: string;
  isSelected: boolean;
  selectedEffort: string;
  onSelect: (engineId: string, modelId: string) => void;
  onEffortChange: (effort: string) => void;
  effortMenuRef: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation("chat");
  const efforts = model.supportedReasoningEfforts ?? [];
  const showControls = efforts.length > 0;
  const metadataChips = modelMetadataChips(t, model);
  const showMetadataChips = isSelected;
  const showDescription = shouldShowModelDescription(engineId, model);
  const modelClassName = [
    "mp-model",
    isSelected ? "mp-model-selected" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={modelClassName}>
      <button
        type="button"
        className="mp-model-btn"
        onClick={() => onSelect(engineId, model.id)}
      >
        <div className="mp-model-info">
          <div className="mp-model-name-row">
            <span className="mp-model-name">
              {formatModelName(model.displayName)}
            </span>
            {model.isDefault && (
              <span className="mp-model-default">{t("modelPicker.default")}</span>
            )}
          </div>
          {showDescription && (
            <span className="mp-model-desc">{model.description}</span>
          )}
          {showMetadataChips && metadataChips.length > 0 ? (
            <span className="mp-model-meta">
              {metadataChips.map((chip) => (
                <span key={chip.label} className="mp-model-meta-chip" title={chip.title}>
                  {chip.label}
                </span>
              ))}
            </span>
          ) : null}
        </div>
        {isSelected && (
          <Check size={13} className="mp-model-check" />
        )}
      </button>

      {isSelected && showControls && (
        <div className="mp-model-controls">
          <span className="mp-model-controls-label">{t("modelPicker.thinking")}</span>
          <ReasoningEffortDropdown
            model={model}
            selectedEffort={selectedEffort}
            onChange={onEffortChange}
            menuRef={effortMenuRef}
          />
        </div>
      )}
    </div>
  );
}
