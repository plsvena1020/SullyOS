// worker/amsg/src/googleToolCtx.test.ts
// Lane W3：buildToolCtx 的 Google 透传 —— 有包才设两字段，无包 fail-closed。
//
// 钉住的行为：
//   1. 有 tool_pack.google → ctx.googleSelection 按 `::` 切好、ctx.googleFetch 可调用；
//   2. 无 google 字段 → 两字段都是 undefined（老包行为不变）；
//   3. 坏形状条目（无分隔 / 任一侧为空 / 非串）跳过，不抛；
//   4. googleFetch 拼 env 桥地址、透传调用方头、恒定覆盖鉴权头与 10s 超时 signal，
//      method/body 照单透传（写路径 POST /api/events 靠它）。
import { describe, expect, it, vi, afterEach } from 'vitest';
import { buildToolCtx, configureGoogleBridgeEnv } from './index';
import type { AmsgToolConfig, AmsgToolPack } from '../../../utils/amsgToolPack';

const packOf = (google?: AmsgToolPack['google']): AmsgToolPack => ({
  v: 1,
  charName: 'test-char',
  xhsEnabled: false,
  activeMemoryMonths: [],
  memories: [],
  timeAwarenessEnabled: true,
  ...(google ? { google } : {}),
});

// buildToolCtx 只把 config 原样挂 realtimeConfig（另读 proxyWorkerUrl / xhsMcpConfig
// 两个可选字段），这里给最小形状即可——类型用 cast 补齐，不把全量凭据表抄进来。
const config = { v: 1, proxyWorkerUrl: '' } as unknown as AmsgToolConfig;

afterEach(() => {
  vi.unstubAllGlobals();
  configureGoogleBridgeEnv(null);
});

describe('buildToolCtx — Google 透传', () => {
  it('有包→ctx 有值：selection 按 `::` 切好，googleFetch 是函数', () => {
    configureGoogleBridgeEnv({ url: 'https://bridge.test/g', token: 'tok123' });
    const { toolCtx } = buildToolCtx(
      packOf({ enabled: true, selection: ['acc1::cal1', 'acc2::cal2'], bridgeUrl: 'https://bridge.test/g' }),
      config,
    );
    expect(toolCtx.googleSelection).toEqual([
      { accountId: 'acc1', calendarId: 'cal1' },
      { accountId: 'acc2', calendarId: 'cal2' },
    ]);
    expect(typeof toolCtx.googleFetch).toBe('function');
  });

  it('无包→两字段都不设（fail-closed，老包行为不变）', () => {
    configureGoogleBridgeEnv({ url: 'https://bridge.test/g', token: 'tok123' });
    const { toolCtx } = buildToolCtx(packOf(), config);
    expect(toolCtx.googleSelection).toBeUndefined();
    expect(toolCtx.googleFetch).toBeUndefined();
  });

  it('坏形状条目跳过：无分隔 / 空账号 / 空日历 / 非串', () => {
    configureGoogleBridgeEnv({ url: 'https://bridge.test/g', token: 'tok123' });
    const { toolCtx } = buildToolCtx(
      packOf({
        enabled: true,
        selection: ['ok::cal', 'no-sep', '::empty-acc', 'empty-cal::', 123 as unknown as string],
        bridgeUrl: 'https://bridge.test/g',
      }),
      config,
    );
    expect(toolCtx.googleSelection).toEqual([{ accountId: 'ok', calendarId: 'cal' }]);
    // 包在但全坏也照样给 fetch（调用方 readGoogleSelection 会结构化抛错，不在这里吞）。
    expect(typeof toolCtx.googleFetch).toBe('function');
  });

  it('googleFetch：拼桥地址 + 透传调用方头 + token 头 + 超时 signal + method 保留', async () => {
    configureGoogleBridgeEnv({ url: 'https://bridge.test/g/', token: 'tok123' });
    const seen: Array<{ url: unknown; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init: RequestInit) => {
        seen.push({ url, init });
        return new Response('[]', { status: 200 });
      }),
    );
    const { toolCtx } = buildToolCtx(
      packOf({ enabled: true, selection: ['acc1::cal1'], bridgeUrl: 'https://bridge.test/g' }),
      config,
    );
    await toolCtx.googleFetch!('/api/events', {
      method: 'GET',
      headers: { 'X-Google-Account': 'acc1' },
    });
    expect(seen).toHaveLength(1);
    // 桥地址尾斜杠已归一，不会拼出双斜杠。
    expect(seen[0].url).toBe('https://bridge.test/g/api/events');
    expect(seen[0].init.method).toBe('GET');
    const headers = seen[0].init.headers as Record<string, string>;
    expect(headers['X-Google-Account']).toBe('acc1');
    expect(headers['X-Google-Bridge-Token']).toBe('tok123');
    expect(seen[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it('googleFetch：Headers 实例照样透传（调用方传什么 HeadersInit 都不丢）', async () => {
    configureGoogleBridgeEnv({ url: 'https://bridge.test/g', token: 'tok123' });
    const seen: Array<{ url: unknown; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init: RequestInit) => {
        seen.push({ url, init });
        return new Response('[]', { status: 200 });
      }),
    );
    const { toolCtx } = buildToolCtx(
      packOf({ enabled: true, selection: ['acc1::cal1'], bridgeUrl: 'https://bridge.test/g' }),
      config,
    );
    const incoming = new Headers({ 'X-Google-Account': 'acc1' });
    await toolCtx.googleFetch!('/api/calendars', { method: 'GET', headers: incoming });
    expect(seen).toHaveLength(1);
    const headers = seen[0].init.headers as Record<string, string>;
    expect(headers['x-google-account']).toBe('acc1');
    expect(headers['X-Google-Bridge-Token']).toBe('tok123');
  });
});
