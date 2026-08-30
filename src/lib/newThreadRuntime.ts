import type { EngineInfo, Thread } from "../types";

export type NewThreadServiceTier = "fast" | "flex";

export interface NewThreadRuntimeSelection {
  engineId: string;
  modelId: string;
  reasoningEffort: string | null;
  serviceTier: NewThreadServiceTier | null;
}

export type ComposerRuntimeSnapshot = NewThreadRuntimeSelection;

export const NEW_THREAD_FALLBACK_RUNTIME: NewThreadRuntimeSelection = {
  engineId: "codex",
  modelId: "gpt-5.6-sol",
  reasoningEffort: "high",
  serviceTier: null,
};

interface ResolveNewThreadRuntimeInput {
  engines: ReadonlyArray<EngineInfo>;
  composerRuntime?: ComposerRuntimeSnapshot | null;
  activeThread?: Thread | null;
}

function normalizeString(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeServiceTier(
  value: string | null | undefined,
): NewThreadServiceTier | null {
  return value === "fast" || value === "flex" ? value : null;
}

function runtimeFromThread(thread: Thread): NewThreadRuntimeSelection {
  const lastModelId = normalizeString(
    typeof thread.engineMetadata?.lastModelId === "string"
      ? thread.engineMetadata.lastModelId
      : null,
  );
  const reasoningEffort = normalizeString(
    typeof thread.engineMetadata?.reasoningEffort === "string"
      ? thread.engineMetadata.reasoningEffort
      : null,
  );
  const serviceTier =
    thread.engineId === "codex"
      ? normalizeServiceTier(
          typeof thread.engineMetadata?.serviceTier === "string"
            ? thread.engineMetadata.serviceTier
            : null,
        )
      : null;

  return {
    engineId: thread.engineId,
    modelId: lastModelId ?? thread.modelId,
    reasoningEffort,
    serviceTier,
  };
}

function resolveRuntimeCandidate(
  engines: ReadonlyArray<EngineInfo>,
  candidate: NewThreadRuntimeSelection | null | undefined,
): NewThreadRuntimeSelection | null {
  if (!candidate) {
    return null;
  }

  const engineId = normalizeString(candidate.engineId);
  const modelId = normalizeString(candidate.modelId);
  if (!engineId || !modelId) {
    return null;
  }

  const engine = engines.find((item) => item.id === engineId);
  if (!engine) {
    return {
      engineId,
      modelId,
      reasoningEffort: normalizeString(candidate.reasoningEffort),
      serviceTier: engineId === "codex" ? normalizeServiceTier(candidate.serviceTier) : null,
    };
  }

  const model = engine.models.find((item) => item.id === modelId);
  if (!model) {
    return null;
  }

  const reasoningEffort = normalizeString(candidate.reasoningEffort);
  const supportedEffort =
    reasoningEffort &&
    model.supportedReasoningEfforts.some(
      (option) => option.reasoningEffort === reasoningEffort,
    )
      ? reasoningEffort
      : null;

  return {
    engineId: engine.id,
    modelId: model.id,
    reasoningEffort: supportedEffort,
    serviceTier: engine.id === "codex" ? normalizeServiceTier(candidate.serviceTier) : null,
  };
}

function runtimeFromCatalogDefault(
  engines: ReadonlyArray<EngineInfo>,
): NewThreadRuntimeSelection | null {
  const codexEngine = engines.find((item) => item.id === "codex");
  const model =
    codexEngine?.models.find((item) => item.isDefault && !item.hidden) ??
    codexEngine?.models.find((item) => !item.hidden) ??
    codexEngine?.models[0];

  if (!codexEngine || !model) {
    return null;
  }

  const fallbackEffort = normalizeString(NEW_THREAD_FALLBACK_RUNTIME.reasoningEffort);
  const modelEffort = model.supportedReasoningEfforts.some(
    (option) => option.reasoningEffort === fallbackEffort,
  )
    ? fallbackEffort
    : normalizeString(model.defaultReasoningEffort);

  return resolveRuntimeCandidate(engines, {
    engineId: codexEngine.id,
    modelId: model.id,
    reasoningEffort: modelEffort,
    serviceTier: NEW_THREAD_FALLBACK_RUNTIME.serviceTier,
  });
}

export function resolveNewThreadRuntime({
  engines,
  composerRuntime,
  activeThread,
}: ResolveNewThreadRuntimeInput): NewThreadRuntimeSelection {
  const candidates: Array<NewThreadRuntimeSelection | null> = [
    composerRuntime ?? null,
    activeThread ? runtimeFromThread(activeThread) : null,
    NEW_THREAD_FALLBACK_RUNTIME,
  ];

  for (const candidate of candidates) {
    const resolved = resolveRuntimeCandidate(engines, candidate);
    if (resolved) {
      return resolved;
    }
  }

  return runtimeFromCatalogDefault(engines) ?? { ...NEW_THREAD_FALLBACK_RUNTIME };
}
