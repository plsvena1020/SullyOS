import { describe, expect, it, vi, afterEach } from 'vitest';
import { readGoogleBridgeUrl, googleBridgeFetch, createGoogleEvent, createGoogleTask } from './googleBridge';

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

describe('googleBridge client', () => {
  it('缺省指向本地 8839', () => {
    expect(readGoogleBridgeUrl()).toBe('http://127.0.0.1:8839');
  });
  it('透传双 header', async () => {
    localStorage.setItem('aetheros.google.bridgeToken', 'T');
    const seen: any[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      seen.push([String(input), init?.headers]); return new Response('{}');
    });
    await googleBridgeFetch('/api/accounts', { headers: { 'X-Google-Account': 'g1' } });
    expect(seen[0][0]).toBe('http://127.0.0.1:8839/api/accounts');
    expect(seen[0][1]['X-Google-Bridge-Token']).toBe('T');
    expect(seen[0][1]['X-Google-Account']).toBe('g1');
  });
  it('createGoogleEvent POST /api/events', async () => {
    const seen: any[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      seen.push([String(input), init]); return Response.json({ id: 'e1' });
    });
    const out: any = await createGoogleEvent({ accountId: 'g1', calendarId: 'primary', event: { summary: 'T' } });
    expect(out.id).toBe('e1');
    expect(seen[0][0].endsWith('/api/events')).toBe(true);
    expect(seen[0][1].headers['X-Google-Account']).toBe('g1');
    expect(JSON.parse(seen[0][1].body).calendarId).toBe('primary');
  });
  it('createGoogleTask 缺省 tasklist @default', async () => {
    const seen: any[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      seen.push([String(input), init]); return Response.json({ id: 't1' });
    });
    const out: any = await createGoogleTask({ accountId: 'g1', task: { title: 'T' } });
    expect(out.id).toBe('t1');
    expect(seen[0][0].endsWith('/api/tasks')).toBe(true);
    expect(seen[0][1].headers['X-Google-Account']).toBe('g1');
    expect(JSON.parse(seen[0][1].body).tasklist).toBe('@default');
  });
});
