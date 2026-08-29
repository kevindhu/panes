import type {
  ApprovalBlock,
  ApprovalResponse,
  DynamicToolCallResponse,
  McpServerElicitationResponse,
  Message,
  NetworkPolicyAmendment,
  PermissionsApprovalResponse,
} from "../../types";

export interface ToolInputOption {
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface ToolInputQuestion {
  id: string;
  header?: string;
  question: string;
  options: ToolInputOption[];
  multiple?: boolean;
  custom?: boolean;
  secret?: boolean;
}

export type ToolInputSelections = Record<string, string[]>;

const REQUEST_USER_INPUT_METHOD = "item/tool/requestuserinput";
const DYNAMIC_TOOL_CALL_METHOD = "item/tool/call";
const PERMISSIONS_REQUEST_METHOD = "item/permissions/requestapproval";
const MCP_ELICITATION_REQUEST_METHOD = "mcpserver/elicitation/request";

function normalizeServerMethod(method: string): string {
  return method
    .replace(/\./g, "/")
    .toLowerCase()
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.replace(/[_-]/g, ""))
    .join("/");
}

export function getApprovalServerMethod(details?: Record<string, unknown>): string {
  const serverMethod = typeof details?._serverMethod === "string" ? details._serverMethod : "";
  return normalizeServerMethod(serverMethod);
}

export function isRequestUserInputApproval(details?: Record<string, unknown>): boolean {
  return getApprovalServerMethod(details) === REQUEST_USER_INPUT_METHOD;
}

export function isDynamicToolCallApproval(details?: Record<string, unknown>): boolean {
  return getApprovalServerMethod(details) === DYNAMIC_TOOL_CALL_METHOD;
}

export function isPermissionsRequestApproval(details?: Record<string, unknown>): boolean {
  return getApprovalServerMethod(details) === PERMISSIONS_REQUEST_METHOD;
}

export function isMcpElicitationApproval(details?: Record<string, unknown>): boolean {
  return getApprovalServerMethod(details) === MCP_ELICITATION_REQUEST_METHOD;
}

export function requiresCustomApprovalPayload(details?: Record<string, unknown>): boolean {
  return isDynamicToolCallApproval(details) || isMcpElicitationApproval(details);
}

export function defaultAdvancedApprovalPayload(
  details?: Record<string, unknown>
): ApprovalResponse {
  if (isRequestUserInputApproval(details)) {
    return {
      answers: {},
    };
  }

  if (isDynamicToolCallApproval(details)) {
    return {
      success: true,
      contentItems: [],
    };
  }

  if (isMcpElicitationApproval(details)) {
    const content = defaultMcpElicitationContent(details);
    if (content && Object.keys(content).length > 0) {
      return {
        action: "accept",
        content,
      } satisfies McpServerElicitationResponse;
    }

    return {
      action: "accept",
    } satisfies McpServerElicitationResponse;
  }

  return { decision: "accept" };
}

function readDetailsValue(
  details: Record<string, unknown> | undefined,
  camelKey: string,
  snakeKey: string,
): unknown {
  if (!details) {
    return undefined;
  }

  if (camelKey in details) {
    return details[camelKey];
  }

  return details[snakeKey];
}

export function parseApprovalCommand(details?: Record<string, unknown>): string | undefined {
  const value = readDetailsValue(details, "command", "command");
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (Array.isArray(value)) {
    const parts = value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return parts.length > 0 ? parts.join(" ") : undefined;
  }

  return undefined;
}

export function parseApprovalReason(details?: Record<string, unknown>): string | undefined {
  const value = readDetailsValue(details, "reason", "reason");
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parseProposedExecpolicyAmendment(
  details?: Record<string, unknown>
): string[] {
  const value = readDetailsValue(
    details,
    "proposedExecpolicyAmendment",
    "proposed_execpolicy_amendment",
  );
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string");
}

export function parseProposedNetworkPolicyAmendments(
  details?: Record<string, unknown>
): NetworkPolicyAmendment[] {
  const value = readDetailsValue(
    details,
    "proposedNetworkPolicyAmendments",
    "proposed_network_policy_amendments",
  );
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (typeof entry !== "object" || entry === null) {
        return null;
      }

      const amendment = entry as Record<string, unknown>;
      const host = typeof amendment.host === "string" ? amendment.host.trim() : "";
      const action = amendment.action;
      if (!host || (action !== "allow" && action !== "deny")) {
        return null;
      }

      return {
        host,
        action,
      } satisfies NetworkPolicyAmendment;
    })
    .filter((entry): entry is NetworkPolicyAmendment => Boolean(entry));
}

export function parseDynamicToolCallName(details?: Record<string, unknown>): string | undefined {
  const tool =
    typeof details?.tool === "string"
      ? details.tool.trim()
      : typeof details?.name === "string"
        ? details.name.trim()
        : "";
  return tool.length > 0 ? tool : undefined;
}

export function parseDynamicToolCallArguments(
  details?: Record<string, unknown>
): Record<string, unknown> | null {
  const value = details?.arguments;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function parseRequestedPermissions(
  details?: Record<string, unknown>
): Record<string, unknown> | null {
  const value = readDetailsValue(details, "permissions", "permissions");
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function buildPermissionsApprovalResponse(
  details: Record<string, unknown> | undefined,
  scope: "turn" | "session",
): PermissionsApprovalResponse {
  return {
    permissions: parseRequestedPermissions(details) ?? {},
    scope,
  };
}

export function buildPermissionsDeclineResponse(): PermissionsApprovalResponse {
  return {
    permissions: {},
    scope: "turn",
  };
}

export function parseMcpElicitationServerName(
  details?: Record<string, unknown>
): string | undefined {
  const value = readDetailsValue(details, "serverName", "server_name");
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parseMcpElicitationMessage(
  details?: Record<string, unknown>
): string | undefined {
  const value = readDetailsValue(details, "message", "message");
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parseMcpElicitationMode(
  details?: Record<string, unknown>
): "form" | "url" | undefined {
  const value = readDetailsValue(details, "mode", "mode");
  return value === "form" || value === "url" ? value : undefined;
}

export function parseMcpElicitationUrl(
  details?: Record<string, unknown>
): string | undefined {
  const value = readDetailsValue(details, "url", "url");
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parseMcpElicitationSchema(
  details?: Record<string, unknown>
): Record<string, unknown> | null {
  const value = readDetailsValue(details, "requestedSchema", "requested_schema");
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function defaultMcpElicitationContent(
  details?: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (parseMcpElicitationMode(details) !== "form") {
    return undefined;
  }

  const schema = parseMcpElicitationSchema(details);
  const properties =
    schema && typeof schema.properties === "object" && schema.properties !== null
      ? (schema.properties as Record<string, unknown>)
      : null;
  if (!properties) {
    return {};
  }

  const content: Record<string, unknown> = {};
  for (const [field, rawSchema] of Object.entries(properties)) {
    if (typeof rawSchema !== "object" || rawSchema === null || Array.isArray(rawSchema)) {
      content[field] = "";
      continue;
    }

    const propertySchema = rawSchema as Record<string, unknown>;
    if (propertySchema.default !== undefined) {
      content[field] = propertySchema.default;
      continue;
    }

    const propertyType = propertySchema.type;
    if (propertyType === "boolean") {
      content[field] = false;
      continue;
    }
    if (propertyType === "number" || propertyType === "integer") {
      content[field] = 0;
      continue;
    }
    if (propertyType === "array") {
      content[field] = [];
      continue;
    }

    content[field] = "";
  }

  return content;
}

export function buildDynamicToolCallResponse(
  text: string,
  success: boolean,
  imageUrl?: string
): DynamicToolCallResponse {
  const contentItems: DynamicToolCallResponse["contentItems"] = [];
  const normalizedText = text.trim();
  const normalizedImageUrl = imageUrl?.trim();

  if (normalizedText) {
    contentItems.push({
      type: "inputText",
      text: normalizedText,
    });
  }

  if (normalizedImageUrl) {
    contentItems.push({
      type: "inputImage",
      imageUrl: normalizedImageUrl,
    });
  }

  return {
    success,
    contentItems,
  };
}

function parseOption(raw: unknown): ToolInputOption | null {
  if (typeof raw === "string") {
    const label = raw.trim();
    if (!label) {
      return null;
    }
    return {
      label,
      recommended: /\(recommended\)/i.test(label),
    };
  }

  if (typeof raw !== "object" || raw === null) {
    return null;
  }

  const optionObj = raw as Record<string, unknown>;
  const labelValue = optionObj.label ?? optionObj.value;
  const label = typeof labelValue === "string" ? labelValue.trim() : "";
  if (!label) {
    return null;
  }

  const description =
    typeof optionObj.description === "string" ? optionObj.description.trim() : undefined;
  const recommendedFlag = optionObj.recommended === true;
  return {
    label,
    description: description || undefined,
    recommended: recommendedFlag || /\(recommended\)/i.test(label),
  };
}

export function parseToolInputQuestions(details: Record<string, unknown>): ToolInputQuestion[] {
  const rawQuestions = details.questions;
  if (!Array.isArray(rawQuestions)) {
    return [];
  }

  const questions: ToolInputQuestion[] = [];
  for (let index = 0; index < rawQuestions.length; index += 1) {
    const raw = rawQuestions[index];
    if (typeof raw !== "object" || raw === null) {
      continue;
    }

    const questionObj = raw as Record<string, unknown>;
    const idCandidate = questionObj.id;
    const questionId =
      typeof idCandidate === "string" && idCandidate.trim()
        ? idCandidate.trim()
        : `question-${index + 1}`;

    const header =
      typeof questionObj.header === "string" && questionObj.header.trim()
        ? questionObj.header.trim()
        : undefined;
    const questionText =
      typeof questionObj.question === "string" && questionObj.question.trim()
        ? questionObj.question.trim()
        : header ?? "";

    if (!questionText) {
      continue;
    }

    const options = Array.isArray(questionObj.options)
      ? questionObj.options
          .map(parseOption)
          .filter((option): option is ToolInputOption => Boolean(option))
      : [];
    const customValue = questionObj.isOther ?? questionObj.is_other ?? questionObj.custom;
    const secretValue = questionObj.isSecret ?? questionObj.is_secret ?? questionObj.secret;

    questions.push({
      id: questionId,
      header,
      question: questionText,
      options,
      multiple: questionObj.multiple === true,
      custom: typeof customValue === "boolean" ? customValue : undefined,
      secret: typeof secretValue === "boolean" ? secretValue : undefined,
    });
  }

  return questions;
}

export function toolInputQuestionAllowsCustomAnswer(question: ToolInputQuestion): boolean {
  // Codex uses `options: null` for a free-form question. `isOther` only
  // controls whether an additional free-form answer is allowed alongside a
  // fixed option list.
  return question.options.length === 0 || question.custom === true;
}

export function findLatestPendingToolInputApproval(messages: Message[]): ApprovalBlock | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const blocks = messages[messageIndex]?.blocks ?? [];
    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = blocks[blockIndex];
      if (
        block.type === "approval" &&
        block.status === "pending" &&
        isRequestUserInputApproval(block.details) &&
        parseToolInputQuestions(block.details).length > 0
      ) {
        return block;
      }
    }
  }

  return null;
}

function defaultAnswersForQuestion(question: ToolInputQuestion): string[] {
  if (question.multiple) {
    return question.options
      .filter((option) => option.recommended)
      .map((option) => option.label);
  }

  const recommended = question.options.find((option) => option.recommended);
  return [recommended?.label ?? question.options[0]?.label]
    .filter((answer): answer is string => Boolean(answer?.trim()));
}

export function defaultToolInputSelections(
  questions: ToolInputQuestion[]
): ToolInputSelections {
  const selections: ToolInputSelections = {};
  for (const question of questions) {
    const answers = defaultAnswersForQuestion(question);
    if (answers.length > 0) {
      selections[question.id] = answers;
    }
  }
  return selections;
}

function selectedAnswersForQuestion(
  selectedByQuestion: Record<string, string | string[]>,
  question: ToolInputQuestion,
): string[] {
  const selected = selectedByQuestion[question.id];
  const rawAnswers = Array.isArray(selected) ? selected : [selected];
  return rawAnswers
    .filter((answer): answer is string => typeof answer === "string")
    .map((answer) => answer.trim())
    .filter((answer) => answer.length > 0);
}

export function buildToolInputResponseFromSelections(
  questions: ToolInputQuestion[],
  selectedByQuestion: Record<string, string | string[]>,
  customByQuestion?: Record<string, string>
): ApprovalResponse {
  const answers: Record<string, { answers: string[] }> = {};

  for (const question of questions) {
    const allowCustom = toolInputQuestionAllowsCustomAnswer(question);
    const customAnswer = allowCustom ? customByQuestion?.[question.id]?.trim() : "";
    const selectedAnswers = selectedAnswersForQuestion(selectedByQuestion, question);
    const fallbackAnswers = defaultAnswersForQuestion(question);
    const baseAnswers = selectedAnswers.length > 0 ? selectedAnswers : fallbackAnswers;
    let finalAnswers = baseAnswers;
    if (customAnswer) {
      finalAnswers = question.multiple ? [...baseAnswers, customAnswer] : [customAnswer];
    }

    answers[question.id] = { answers: Array.from(new Set(finalAnswers)) };
  }

  return { answers };
}
