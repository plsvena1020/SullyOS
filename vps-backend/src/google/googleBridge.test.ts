import { describe, expect, it, vi, afterEach } from 'vitest';
// @ts-expect-error VPS 纯 JS 服务无类型声明
import { startGoogleBridge } from './googleBridge.js';
// @ts-expect-error VPS 纯 JS 服务无类型声明
import { createGoogleStore } from './googleStore.js';
import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs';

afterEach(() => { vi.restoreAllMocks(); });
const KEY = 'ab'.repeat(32);
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gbridge-')), 's.json');
const start = async (routes: Record<string, any> = {}) => {
  const realFetch = globalThis.fetch.bind(globalThis);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const target = typeof input === 'string' ? input : String(input?.url ?? input);
    const url = new URL(target);
    // 回环流量是测试本体调桥，必须走真 fetch；Google 上游才走 stub（未知上游仍抛）。
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);
    const route = routes[`${url.hostname}${url.pathname}`];
    if (!route) throw new Error(`unexpected upstream: ${url}`);
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
  });
  const store = createGoogleStore({ sessionKeyHex: KEY, filePath: tmpFile() });
  const b = startGoogleBridge({ port: 0, host: '127.0.0.1', token: 'T', store, clientId: 'C', clientSecret: 'S', redirectUri: 'R' });
  await b.ready;
  return b;
};

describe('googleBridge', () => {
  it('health 免鉴权', async () => {
    const b = await start(); const r = await fetch(`http://127.0.0.1:${b.port}/api/health`);
    expect(r.status).toBe(200); await b.close();
  });
  it('无 token 拒绝且响应不含敏感字样', async () => {
    const b = await start();
    const r = await fetch(`http://127.0.0.1:${b.port}/api/accounts`);
    expect(r.status).toBe(401);
    expect(await r.text()).not.toMatch(/refresh|REFRESH/);
    await b.close();
  });
  it('exchange 存 refresh 但响应不回显', async () => {
    const b = await start({
      'oauth2.googleapis.com/token': { body: { access_token: 'A', refresh_token: 'REF', expires_in: 3600 } },
      'www.googleapis.com/oauth2/v2/userinfo': { body: { id: 'g1', email: 'u@x.com' } },
    });
    const r = await fetch(`http://127.0.0.1:${b.port}/api/accounts/exchange`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-google-bridge-token': 'T' },
      body: JSON.stringify({ code: 'CODE' }),
    });
    expect(r.status).toBe(200);
    const body: any = await r.json();
    expect(body.accountId).toBe('g1');
    expect(JSON.stringify(body)).not.toContain('REF');
    await b.close();
  });
  it('exchange 存 scope 且 listAccounts 可见', async () => {
    const b = await start({
      'oauth2.googleapis.com/token': { body: { access_token: 'A', refresh_token: 'REF', expires_in: 3600, scope: 'https://www.googleapis.com/auth/calendar.readonly' } },
      'www.googleapis.com/oauth2/v2/userinfo': { body: { id: 'g1', email: 'u@x.com' } },
    });
    const ex = await fetch(`http://127.0.0.1:${b.port}/api/accounts/exchange`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-google-bridge-token': 'T' },
      body: JSON.stringify({ code: 'CODE' }),
    });
    expect(ex.status).toBe(200);
    const list = await fetch(`http://127.0.0.1:${b.port}/api/accounts`, {
      headers: { 'x-google-bridge-token': 'T' },
    });
    expect(list.status).toBe(200);
    const accounts: any = await list.json();
    expect(accounts[0].scope).toBe('https://www.googleapis.com/auth/calendar.readonly');
    await b.close();
  });
  it('events 透传并盖 calendarId', async () => {
    const b = await start({
      'oauth2.googleapis.com/token': { body: { access_token: 'A', refresh_token: 'REF', expires_in: 3600 } },
      'www.googleapis.com/oauth2/v2/userinfo': { body: { id: 'g1', email: 'u@x.com' } },
      'www.googleapis.com/calendar/v3/calendars/primary/events': { body: { items: [{ id: '1', summary: '会', start: { dateTime: '2026-09-25T15:00:00+08:00' } }] } },
    });
    const ex = await fetch(`http://127.0.0.1:${b.port}/api/accounts/exchange`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-google-bridge-token': 'T' },
      body: JSON.stringify({ code: 'CODE' }),
    });
    expect(ex.status).toBe(200);
    const r = await fetch(`http://127.0.0.1:${b.port}/api/events?calendarId=primary&timeMin=x&timeMax=y`, {
      headers: { 'x-google-bridge-token': 'T', 'x-google-account': 'g1' },
    });
    expect(r.status).toBe(200);
    const body: any = await r.json();
    expect(body.items[0]).toMatchObject({ id: '1', calendarId: 'primary' });
    await b.close();
  });
  it('POST /api/events 透传上游回体', async () => {
    const b = await start({
      'oauth2.googleapis.com/token': { body: { access_token: 'A', refresh_token: 'REF', expires_in: 3600 } },
      'www.googleapis.com/oauth2/v2/userinfo': { body: { id: 'g1', email: 'u@x.com' } },
      'www.googleapis.com/calendar/v3/calendars/primary/events': { body: { id: 'ev123', summary: '对齐会' } },
    });
    const ex = await fetch(`http://127.0.0.1:${b.port}/api/accounts/exchange`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-google-bridge-token': 'T' },
      body: JSON.stringify({ code: 'CODE' }),
    });
    expect(ex.status).toBe(200);
    const r = await fetch(`http://127.0.0.1:${b.port}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-google-bridge-token': 'T', 'x-google-account': 'g1' },
      body: JSON.stringify({ accountId: 'g1', calendarId: 'primary', event: { summary: '对齐会' } }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const body: any = await r.json();
    expect(body.id).toBe('ev123');
    await b.close();
  });
  it('POST /api/tasks 透传上游回体', async () => {
    const b = await start({
      'oauth2.googleapis.com/token': { body: { access_token: 'A', refresh_token: 'REF', expires_in: 3600 } },
      'www.googleapis.com/oauth2/v2/userinfo': { body: { id: 'g1', email: 'u@x.com' } },
      'tasks.googleapis.com/tasks/v1/lists/@default/tasks': { body: { id: 'tk456', title: '买牛奶' } },
    });
    const ex = await fetch(`http://127.0.0.1:${b.port}/api/accounts/exchange`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-google-bridge-token': 'T' },
      body: JSON.stringify({ code: 'CODE' }),
    });
    expect(ex.status).toBe(200);
    const r = await fetch(`http://127.0.0.1:${b.port}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-google-bridge-token': 'T', 'x-google-account': 'g1' },
      body: JSON.stringify({ accountId: 'g1', task: { title: '买牛奶' } }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const body: any = await r.json();
    expect(body.id).toBe('tk456');
    await b.close();
  });
  it('无 token 调写入口 401', async () => {
    const b = await start();
    const r = await fetch(`http://127.0.0.1:${b.port}/api/events`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'g1', calendarId: 'primary', event: { summary: 'x' } }),
    });
    expect(r.status).toBe(401);
    await b.close();
  });
  it('上游 403 透状态码', async () => {
    const b = await start({
      'oauth2.googleapis.com/token': { body: { access_token: 'A', refresh_token: 'REF', expires_in: 3600 } },
      'www.googleapis.com/oauth2/v2/userinfo': { body: { id: 'g1', email: 'u@x.com' } },
      'www.googleapis.com/calendar/v3/calendars/primary/events': { status: 403, body: { error: { code: 403, message: 'insufficient scope' } } },
    });
    const ex = await fetch(`http://127.0.0.1:${b.port}/api/accounts/exchange`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-google-bridge-token': 'T' },
      body: JSON.stringify({ code: 'CODE' }),
    });
    expect(ex.status).toBe(200);
    const r = await fetch(`http://127.0.0.1:${b.port}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-google-bridge-token': 'T', 'x-google-account': 'g1' },
      body: JSON.stringify({ accountId: 'g1', calendarId: 'primary', event: { summary: 'x' } }),
    });
    expect(r.status).toBe(403);
    const body: any = await r.json();
    expect(body.error.code).toBe(403);
    await b.close();
  });
});
