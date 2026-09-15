import { safeFetchJson } from '../safeApi';
import { buildDirectorSystemPrompt, buildDirectorUserPrompt } from './directorPrompt';
import { parseAirpDirectorOutput } from './directorCore';
import { decideAirpCapability } from './capabilities';
import type {
  AirpDirectorOutput,
  AirpRuntimeSnapshot,
  AirpToolIntent,
} from './types';
import type { CharacterProfile } from '../../types';

export interface AirpDirectorApi {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface AirpToolExecution {
  ok: boolean;
  text: string;
}

export interface AirpToolExecutor {
  executeTool(toolName: string, args: Record<string, unknown>): Promise<AirpToolExecution>;
}

export interface AirpLlmFetcher {
  postChatCompletions(url: string, body: Record<string, unknown>): Promise<unknown>;
}

export interface AirpDirectorDeps {
  executor?: AirpToolExecutor;
  fetcher?: AirpLlmFetcher;
}

export interface AirpDirectorRunResult {
  ok: boolean;
  output?: AirpDirectorOutput;
  error?: string;
  usage?: { promptTokens?: number; completionTokens?: number };
}

type AirpDirectorError = 'http_error' | 'timeout' | 'empty_response' | 'parse_failed';

type AirpDirectorRoundResult =
  | { ok: true; output: AirpDirectorOutput; usage?: { promptTokens?: number; completionTokens?: number } }
  | { ok: false; error: AirpDirectorError };

interface ToolExecutionRecord {
  toolName: string;
  text: string;
}

/** 阶段一实际接线的仓库已有 read 工具；其余能力只注册不接线。 */
const STAGE1_WIRED_TOOLS: readonly string[] = ['recall_deep', 'web_search', 'read_note'];

const RESPONSE_FORMAT_MODEL = /gpt|deepseek/i;

const TOOL_RESULT_LIMIT = 2000;

const TOOL_RESULT_TRUNCATION_SUFFIX = '…[截断]';

const TEXT_CAPABILITY_UNAVAILABLE = '该能力暂不可用';
const TEXT_CAPABILITY_NOT_ALLOWED = '该能力当前不允许执行';
const TEXT_CAPABILITY_NEEDS_CONFIRMATION = '该能力需要用户确认，跳过执行';
const TEXT_TOOL_EXECUTION_FAILED = '执行失败';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildChatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

function buildRequestBody(
  model: string,
  systemPrompt: string,
  userPrompt: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.3,
    max_tokens: 1600,
  };
  if (RESPONSE_FORMAT_MODEL.test(model)) {
    body.response_format = { type: 'json_object' };
  }
  return body;
}

function createDefaultFetcher(apiKey: string): AirpLlmFetcher {
  return {
    postChatCompletions(url, body) {
      return safeFetchJson(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
        },
        0,
        45000,
      );
    },
  };
}

function extractResponseContent(json: unknown): string | null {
  if (!isRecord(json)) return null;
  const choices = json.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!isRecord(first)) return null;
  const message = first.message;
  if (!isRecord(message)) return null;

  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (isRecord(part) && typeof part.text === 'string') parts.push(part.text);
    }
    return parts.join('');
  }
  return null;
}

function readResponseUsage(
  json: unknown,
): { promptTokens?: number; completionTokens?: number } | undefined {
  if (!isRecord(json)) return undefined;
  const usage = json.usage;
  if (!isRecord(usage)) return undefined;

  const result: { promptTokens?: number; completionTokens?: number } = {};
  if (typeof usage.prompt_tokens === 'number') result.promptTokens = usage.prompt_tokens;
  if (typeof usage.completion_tokens === 'number') result.completionTokens = usage.completion_tokens;
  return Object.keys(result).length > 0 ? result : undefined;
}

function accumulateUsage(
  total: { promptTokens?: number; completionTokens?: number } | undefined,
  addition: { promptTokens?: number; completionTokens?: number } | undefined,
): { promptTokens?: number; completionTokens?: number } | undefined {
  if (addition === undefined) return total;

  const next = { ...(total ?? {}) };
  if (addition.promptTokens !== undefined) {
    next.promptTokens = (next.promptTokens ?? 0) + addition.promptTokens;
  }
  if (addition.completionTokens !== undefined) {
    next.completionTokens = (next.completionTokens ?? 0) + addition.completionTokens;
  }
  return next;
}

function classifyFetchError(error: unknown): 'timeout' | 'http_error' {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return 'timeout';
    if (/abort|timeout|timed out|etimedout|deadline/i.test(error.message)) return 'timeout';
  }
  return 'http_error';
}

async function runDirectorRound(
  url: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  fetcher: AirpLlmFetcher,
): Promise<AirpDirectorRoundResult> {
  let json: unknown;
  try {
    json = await fetcher.postChatCompletions(
      url,
      buildRequestBody(model, systemPrompt, userPrompt),
    );
  } catch (error) {
    return { ok: false, error: classifyFetchError(error) };
  }

  const content = extractResponseContent(json);
  if (content === null) return { ok: false, error: 'empty_response' };

  const output = parseAirpDirectorOutput(content);
  if (output === null) return { ok: false, error: 'parse_failed' };

  return { ok: true, output, usage: readResponseUsage(json) };
}

function truncateToolResult(text: string): string {
  return text.length > TOOL_RESULT_LIMIT
    ? `${text.slice(0, TOOL_RESULT_LIMIT)}${TOOL_RESULT_TRUNCATION_SUFFIX}`
    : text;
}

async function resolveToolIntentText(
  intent: AirpToolIntent,
  snapshot: AirpRuntimeSnapshot,
  executor: AirpToolExecutor | undefined,
): Promise<string> {
  const capability = snapshot.capabilities.find((candidate) => candidate.id === intent.capabilityId);
  if (capability === undefined) return TEXT_CAPABILITY_UNAVAILABLE;

  const decision = decideAirpCapability(capability, snapshot.autonomyLevel, 'browser');
  if (!decision.allowed) return TEXT_CAPABILITY_NOT_ALLOWED;
  if (decision.requiresConfirmation) return TEXT_CAPABILITY_NEEDS_CONFIRMATION;
  if (!STAGE1_WIRED_TOOLS.includes(intent.toolName)) return TEXT_CAPABILITY_UNAVAILABLE;
  if (executor === undefined) return TEXT_CAPABILITY_UNAVAILABLE;

  try {
    const args = isRecord(intent.arguments) ? intent.arguments : {};
    const result = await executor.executeTool(intent.toolName, args);
    return typeof result?.text === 'string' ? result.text : '';
  } catch {
    return TEXT_TOOL_EXECUTION_FAILED;
  }
}

async function executeToolIntents(
  intents: AirpToolIntent[],
  snapshot: AirpRuntimeSnapshot,
  executor: AirpToolExecutor | undefined,
): Promise<ToolExecutionRecord[]> {
  const records: ToolExecutionRecord[] = [];
  for (const intent of intents) {
    const text = await resolveToolIntentText(intent, snapshot, executor);
    records.push({ toolName: intent.toolName, text: truncateToolResult(text) });
  }
  return records;
}

function buildToolFollowUpPrompt(
  userPrompt: string,
  executions: ToolExecutionRecord[],
): string {
  const lines = executions.map((execution) => `- ${execution.toolName}: ${execution.text}`);
  return `${userPrompt}\n\n[工具执行结果]\n${lines.join('\n')}`;
}

/**
 * Runs exactly one director pass (at most two chat-completions calls: the
 * planning call and, when the plan requests tools, one refinement call).
 *
 * CONTRACT — `output.toolIntents` reflects the director's original requests;
 * every executable one was already attempted during the run. CONSUMERS MUST NOT
 * RE-EXECUTE them.
 *
 * LLM and tool failures never reject: they resolve to `{ ok: false, ... }` (or a
 * degraded `{ ok: true, ... }` for a failed refinement round). Only unexpected
 * programming errors propagate.
 */
export async function runAirpDirector(
  char: CharacterProfile,
  api: AirpDirectorApi,
  snapshot: AirpRuntimeSnapshot,
  latestUserMessage: string,
  recentDialogueTail: string[],
  deps?: AirpDirectorDeps,
): Promise<AirpDirectorRunResult> {
  const systemPrompt = buildDirectorSystemPrompt(snapshot);
  const userPrompt = buildDirectorUserPrompt(snapshot, latestUserMessage, recentDialogueTail);
  const url = buildChatCompletionsUrl(api.baseUrl);
  const fetcher = deps?.fetcher ?? createDefaultFetcher(api.apiKey);

  const firstRound = await runDirectorRound(url, api.model, systemPrompt, userPrompt, fetcher);
  if (!firstRound.ok) return { ok: false, error: firstRound.error };

  const usage = accumulateUsage(undefined, firstRound.usage);
  const firstOutput = firstRound.output;

  if (firstOutput.toolIntents.length === 0) {
    return usage === undefined ? { ok: true, output: firstOutput } : { ok: true, output: firstOutput, usage };
  }

  const executions = await executeToolIntents(firstOutput.toolIntents, snapshot, deps?.executor);
  const followUpPrompt = buildToolFollowUpPrompt(userPrompt, executions);

  const secondRound = await runDirectorRound(url, api.model, systemPrompt, followUpPrompt, fetcher);
  if (!secondRound.ok) {
    return usage === undefined ? { ok: true, output: firstOutput } : { ok: true, output: firstOutput, usage };
  }

  const finalUsage = accumulateUsage(usage, secondRound.usage);
  const finalOutput: AirpDirectorOutput = { ...secondRound.output, toolIntents: [] };
  return finalUsage === undefined
    ? { ok: true, output: finalOutput }
    : { ok: true, output: finalOutput, usage: finalUsage };
}
