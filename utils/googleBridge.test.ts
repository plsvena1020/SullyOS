import { describe, expect, it, vi, afterEach } from 'vitest';
import { readGoogleBridgeUrl, googleBridgeFetch, createGoogleEvent, createGoogleTask, createGoogleCalendar, updateGoogleEvent, deleteGoogleEvent } from './googleBridge';

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

describe('googleBridge client', () => {
  it('缺省指向本地 8841', () => {
    expect(readGoogleBridgeUrl()).toBe('http://127.0.0.1:8841');
  });
  it('透传双 header', async () => {
    localStorage.setItem('aetheros.google.bridgeToken', 'T');
    const seen: any[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      seen.push([String(input), init?.headers]); return new Response('{}');
    });
    await googleBridgeFetch('/api/accounts', { headers: { 'X-Google-Account': 'g1' } });
    expect(seen[0][0]).toBe('http://127.0.0.1:8841/api/accounts');
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
  it('createGoogleCalendar POST /api/calendars', async () => {
    const seen: any[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      seen.push([String(input), init]); return Response.json({ id: 'c1' });
    });
    const out: any = await createGoogleCalendar({ accountId: 'g1', summary: 'S' });
    expect(out.id).toBe('c1');
    expect(seen[0][0].endsWith('/api/calendars')).toBe(true);
    expect(seen[0][1].method).toBe('POST');
    expect(seen[0][1].headers['X-Google-Account']).toBe('g1');
    expect(JSON.parse(seen[0][1].body)).toEqual({ accountId: 'g1', summary: 'S' });
  });
  it('updateGoogleEvent PUT /api/events/{eventId}', async () => {
    const seen: any[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      seen.push([String(input), init]); return Response.json({ id: 'e1' });
    });
    const out: any = await updateGoogleEvent({ accountId: 'g1', calendarId: 'primary', eventId: 'e 1', event: { summary: 'T' } });
    expect(out.id).toBe('e1');
    expect(seen[0][0].endsWith('/api/events/' + encodeURIComponent('e 1'))).toBe(true);
    expect(seen[0][1].method).toBe('PUT');
    expect(seen[0][1].headers['X-Google-Account']).toBe('g1');
    expect(JSON.parse(seen[0][1].body)).toEqual({ accountId: 'g1', calendarId: 'primary', event: { summary: 'T' } });
  });
  it('deleteGoogleEvent DELETE /api/events/{eventId}?calendarId=', async () => {
    const seen: any[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      seen.push([String(input), init]); return Response.json({ ok: true });
    });
    const out: any = await deleteGoogleEvent({ accountId: 'g1', calendarId: 'pri mary', eventId: 'e 1' });
    expect(out.ok).toBe(true);
    expect(seen[0][0].endsWith('/api/events/' + encodeURIComponent('e 1') + '?calendarId=' + encodeURIComponent('pri mary'))).toBe(true);
    expect(seen[0][1].method).toBe('DELETE');
    expect(seen[0][1].headers['X-Google-Account']).toBe('g1');
  });
});
