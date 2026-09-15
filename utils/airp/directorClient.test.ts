import { describe, it, expect } from 'vitest';
import { runAirpDirector } from './directorClient';
import type {
  AirpDirectorApi,
  AirpLlmFetcher,
  AirpToolExecution,
  AirpToolExecutor,
} from './directorClient';
import type { AirpCapability, AirpRuntimeSnapshot } from './types';
import type { CharacterProfile } from '../../types';

const char: CharacterProfile = {
  id: 'char-1',
  name: 'Aria',
  avatar: '',
  description: '',
  systemPrompt: '',
  memories: [],
};

const RECALL_CAP: AirpCapability = {
  id: 'cap-recall',
  title: '深层回忆',
  environment: 'browser',
  risk: 'read',
  category: 'memory',
  toolNames: ['recall_deep'],
};

const UNWIRED_CAP: AirpCapability = {
  id: 'cap-unwired',
  title: '他处天气',
  environment: 'shared',
  risk: 'read',
  category: 'weather',
  toolNames: ['weather_elsewhere'],
};

const CONFIRM_CAP: AirpCapability = {
  id: 'cap-mcp',
  title: 'MCP 工具',
  environment: 'browser',
  risk: 'confirm',
  category: 'external',
  toolNames: [],
};

function makeSnapshot(overrides: Partial<AirpRuntimeSnapshot> = {}): AirpRuntimeSnapshot {
  return {
    v: 1,
    charId: 'char-1',
    builtAt: 1_700_000_000_000,
    autonomyLevel: 1,
    scene: { now: 1_700_000_000_000, tzId: 'Asia/Shanghai' },
    facts: [],
    knowledge: [],
    recentEventSummaries: [],
    unresolvedThreads: [],
    capabilities: [],
    ...overrides,
  };
}

function makeDirectorJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    sceneGoal: '保持轻松的氛围',
    replyIntent: '温和地回应',
    beats: [],
    allowedDisclosures: [],
    forbiddenAssumptions: [],
    toolIntents: [],
    proposedEvents: [],
    commitCandidates: [],
    ...overrides,
  };
}

function chatResponse(
  content: unknown,
  usage?: { prompt_tokens: number; completion_tokens: number },
): Record<string, unknown> {
  return {
    choices: [{ message: { content } }],
    ...(usage ? { usage } : {}),
  };
}

type FetcherCall = { url: string; body: Record<string, any> };

function makeFetcher(...responses: unknown[]): {
  fetcher: AirpLlmFetcher;
  calls: FetcherCall[];
} {
  const calls: FetcherCall[] = [];
  let index = 0;
  const fetcher: AirpLlmFetcher = {
    async postChatCompletions(url, body) {
      calls.push({ url, body });
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (response instanceof Error) throw response;
      return response;
    },
  };
  return { fetcher, calls };
}

function makeExecutor(result: AirpToolExecution | Error = { ok: true, text: 'ok' }): {
  executor: AirpToolExecutor;
  calls: Array<{ toolName: string; args: Record<string, unknown> }>;
} {
  const calls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
  const executor: AirpToolExecutor = {
    async executeTool(toolName, args) {
      calls.push({ toolName, args });
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { executor, calls };
}

function makeApi(overrides: Partial<AirpDirectorApi> = {}): AirpDirectorApi {
  return {
    baseUrl: 'https://llm.example.com/v1/',
    apiKey: 'sk-test',
    model: 'claude-3-5-sonnet',
    ...overrides,
  };
}

function messagesOf(call: FetcherCall): Array<{ role: string; content: string }> {
  return call.body.messages as Array<{ role: string; content: string }>;
}

describe('runAirpDirector — single round, no tools', () => {
  it('parses the output and sends the pinned body without response_format for a non-gpt model', async () => {
    const output = makeDirectorJson();
    const { fetcher, calls } = makeFetcher(
      chatResponse(JSON.stringify(output), { prompt_tokens: 12, completion_tokens: 7 }),
    );

    const result = await runAirpDirector(char, makeApi(), makeSnapshot(), '你好', ['上一句'], {
      fetcher,
    });

    expect(result.ok).toBe(true);
    expect(result.output).toEqual(output);
    expect(result.usage).toEqual({ promptTokens: 12, completionTokens: 7 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://llm.example.com/v1/chat/completions');
    expect(calls[0].body.model).toBe('claude-3-5-sonnet');
    expect(calls[0].body.temperature).toBe(0.3);
    expect(calls[0].body.max_tokens).toBe(1600);
    expect('response_format' in calls[0].body).toBe(false);
    const messages = messagesOf(calls[0]);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('AIRP');
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain('你好');
  });

  it('adds response_format json_object only for gpt / deepseek models', async () => {
    for (const model of ['gpt-4o', 'deepseek-chat']) {
      const { fetcher, calls } = makeFetcher(chatResponse(JSON.stringify(makeDirectorJson())));
      const result = await runAirpDirector(char, makeApi({ model }), makeSnapshot(), 'hi', [], {
        fetcher,
      });
      expect(result.ok).toBe(true);
      expect(calls[0].body.response_format).toEqual({ type: 'json_object' });
    }
  });
});

describe('runAirpDirector — response extraction and failures', () => {
  it('reports parse_failed without leaking raw text when content is garbage', async () => {
    const { fetcher } = makeFetcher(chatResponse('definitely not json'));

    const result = await runAirpDirector(char, makeApi(), makeSnapshot(), 'hi', [], { fetcher });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('parse_failed');
    expect(result.error).not.toContain('definitely');
    expect(result.output).toBeUndefined();
  });

  it('reports empty_response for null content and parses joined array parts', async () => {
    const { fetcher } = makeFetcher(chatResponse(null));
    const missing = await runAirpDirector(char, makeApi(), makeSnapshot(), 'hi', [], { fetcher });
    expect(missing.ok).toBe(false);
    expect(missing.error).toBe('empty_response');

    const parts = [{ type: 'text', text: JSON.stringify(makeDirectorJson()) }];
    const { fetcher: partsFetcher } = makeFetcher(chatResponse(parts));
    const joined = await runAirpDirector(char, makeApi(), makeSnapshot(), 'hi', [], {
      fetcher: partsFetcher,
    });
    expect(joined.ok).toBe(true);
    expect(joined.output?.sceneGoal).toBe('保持轻松的氛围');
  });

  it('maps a rejected round-1 fetch to http_error and abort/timeout to timeout', async () => {
    const { fetcher } = makeFetcher(new Error('boom'));
    const failed = await runAirpDirector(char, makeApi(), makeSnapshot(), 'hi', [], { fetcher });
    expect(failed.ok).toBe(false);
    expect(failed.error).toBe('http_error');

    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    const { fetcher: abortFetcher } = makeFetcher(abort);
    const timedOut = await runAirpDirector(char, makeApi(), makeSnapshot(), 'hi', [], {
      fetcher: abortFetcher,
    });
    expect(timedOut.ok).toBe(false);
    expect(timedOut.error).toBe('timeout');
  });
});

describe('runAirpDirector — tool round', () => {
  const round1WithIntents = makeDirectorJson({
    toolIntents: [
      {
        capabilityId: 'cap-recall',
        toolName: 'recall_deep',
        reason: '需要回忆',
        arguments: { query: '去年夏天' },
      },
      {
        capabilityId: 'cap-unwired',
        toolName: 'weather_elsewhere',
        reason: '想知道',
        arguments: { city: 'Tokyo' },
      },
    ],
  });

  it('executes wired intents once, feeds every result back, and returns the round-2 output', async () => {
    const snapshot = makeSnapshot({ capabilities: [RECALL_CAP, UNWIRED_CAP] });
    const round2 = makeDirectorJson({ sceneGoal: '融合工具结果' });
    const { fetcher, calls } = makeFetcher(
      chatResponse(JSON.stringify(round1WithIntents)),
      chatResponse(JSON.stringify(round2)),
    );
    const { executor, calls: execCalls } = makeExecutor({ ok: true, text: '找到 3 条回忆' });

    const result = await runAirpDirector(char, makeApi(), snapshot, '你好', ['上一句'], {
      fetcher,
      executor,
    });

    expect(result.ok).toBe(true);
    expect(result.output?.sceneGoal).toBe('融合工具结果');
    expect(result.output?.toolIntents).toEqual([]);
    expect(execCalls).toEqual([{ toolName: 'recall_deep', args: { query: '去年夏天' } }]);
    expect(calls).toHaveLength(2);
    const followUp = messagesOf(calls[1])[1].content;
    expect(followUp).toContain('你好');
    expect(followUp).toContain('[工具执行结果]');
    expect(followUp).toContain('- recall_deep: 找到 3 条回忆');
    expect(followUp).toContain('- weather_elsewhere: 该能力暂不可用');
  });

  it('marks an intent whose capabilityId is absent as unavailable without executing it', async () => {
    const snapshot = makeSnapshot({ capabilities: [RECALL_CAP] });
    const round1 = makeDirectorJson({
      toolIntents: [
        {
          capabilityId: 'cap-does-not-exist',
          toolName: 'recall_deep',
          reason: '想回忆',
          arguments: { query: '去年夏天' },
        },
      ],
    });
    const { fetcher, calls } = makeFetcher(
      chatResponse(JSON.stringify(round1)),
      chatResponse(JSON.stringify(makeDirectorJson({ sceneGoal: '缺失能力后' }))),
    );
    const { executor, calls: execCalls } = makeExecutor();

    const result = await runAirpDirector(char, makeApi(), snapshot, 'hi', [], { fetcher, executor });

    expect(result.ok).toBe(true);
    expect(execCalls).toHaveLength(0);
    expect(calls).toHaveLength(2);
    expect(messagesOf(calls[1])[1].content).toContain('- recall_deep: 该能力暂不可用');
  });

  it('skips confirmation-risk intents without executing them but still runs round 2', async () => {
    const snapshot = makeSnapshot({ capabilities: [CONFIRM_CAP] });
    const round1 = makeDirectorJson({
      toolIntents: [
        { capabilityId: 'cap-mcp', toolName: 'mcp_tool', reason: '试试', arguments: {} },
      ],
    });
    const { fetcher, calls } = makeFetcher(
      chatResponse(JSON.stringify(round1)),
      chatResponse(JSON.stringify(makeDirectorJson({ sceneGoal: '确认后' }))),
    );
    const { executor, calls: execCalls } = makeExecutor();

    const result = await runAirpDirector(char, makeApi(), snapshot, 'hi', [], { fetcher, executor });

    expect(result.ok).toBe(true);
    expect(execCalls).toHaveLength(0);
    expect(calls).toHaveLength(2);
    expect(messagesOf(calls[1])[1].content).toContain('- mcp_tool: 该能力需要用户确认，跳过执行');
  });

  it('drops round-2 intents instead of executing them again', async () => {
    const snapshot = makeSnapshot({ capabilities: [RECALL_CAP] });
    const round1 = makeDirectorJson({
      toolIntents: [
        { capabilityId: 'cap-recall', toolName: 'recall_deep', reason: '一次', arguments: {} },
      ],
    });
    const round2 = makeDirectorJson({
      sceneGoal: '第二轮',
      toolIntents: [
        { capabilityId: 'cap-recall', toolName: 'recall_deep', reason: '再来', arguments: {} },
      ],
    });
    const { fetcher } = makeFetcher(
      chatResponse(JSON.stringify(round1)),
      chatResponse(JSON.stringify(round2)),
    );
    const { executor, calls: execCalls } = makeExecutor();

    const result = await runAirpDirector(char, makeApi(), snapshot, 'hi', [], { fetcher, executor });

    expect(result.ok).toBe(true);
    expect(result.output?.sceneGoal).toBe('第二轮');
    expect(result.output?.toolIntents).toEqual([]);
    expect(execCalls).toHaveLength(1);
  });

  it('falls back to the round-1 output when round 2 fails', async () => {
    const snapshot = makeSnapshot({ capabilities: [RECALL_CAP] });
    const round1 = makeDirectorJson({
      sceneGoal: '第一轮',
      toolIntents: [
        { capabilityId: 'cap-recall', toolName: 'recall_deep', reason: '一次', arguments: {} },
      ],
    });
    const { executor } = makeExecutor();

    const { fetcher } = makeFetcher(
      chatResponse(JSON.stringify(round1)),
      chatResponse('garbage again'),
    );
    const parseFailure = await runAirpDirector(char, makeApi(), snapshot, 'hi', [], {
      fetcher,
      executor,
    });
    expect(parseFailure.ok).toBe(true);
    expect(parseFailure.output?.sceneGoal).toBe('第一轮');
    expect(parseFailure.output?.toolIntents).toHaveLength(1);

    const { fetcher: throwingFetcher } = makeFetcher(
      chatResponse(JSON.stringify(round1)),
      new Error('network down'),
    );
    const networkFailure = await runAirpDirector(char, makeApi(), snapshot, 'hi', [], {
      fetcher: throwingFetcher,
      executor,
    });
    expect(networkFailure.ok).toBe(true);
    expect(networkFailure.output?.sceneGoal).toBe('第一轮');
  });

  it('sums usage across both rounds', async () => {
    const snapshot = makeSnapshot({ capabilities: [RECALL_CAP] });
    const round1 = makeDirectorJson({
      toolIntents: [
        { capabilityId: 'cap-recall', toolName: 'recall_deep', reason: '一次', arguments: {} },
      ],
    });
    const { fetcher } = makeFetcher(
      chatResponse(JSON.stringify(round1), { prompt_tokens: 10, completion_tokens: 5 }),
      chatResponse(JSON.stringify(makeDirectorJson({ sceneGoal: '二轮' })), {
        prompt_tokens: 7,
        completion_tokens: 3,
      }),
    );
    const { executor } = makeExecutor({ ok: true, text: 'ok' });

    const result = await runAirpDirector(char, makeApi(), snapshot, 'hi', [], { fetcher, executor });

    expect(result.usage).toEqual({ promptTokens: 17, completionTokens: 8 });
  });

  it('truncates over-long tool results before feeding them back', async () => {
    const snapshot = makeSnapshot({ capabilities: [RECALL_CAP] });
    const long = 'x'.repeat(2500);
    const round1 = makeDirectorJson({
      toolIntents: [
        { capabilityId: 'cap-recall', toolName: 'recall_deep', reason: '一次', arguments: {} },
      ],
    });
    const { fetcher, calls } = makeFetcher(
      chatResponse(JSON.stringify(round1)),
      chatResponse(JSON.stringify(makeDirectorJson({ sceneGoal: '二轮' }))),
    );
    const { executor } = makeExecutor({ ok: true, text: long });

    await runAirpDirector(char, makeApi(), snapshot, 'hi', [], { fetcher, executor });

    const followUp = messagesOf(calls[1])[1].content;
    expect(followUp).toContain(`${'x'.repeat(2000)}…[截断]`);
    expect(followUp).not.toContain('x'.repeat(2001));
  });
});
