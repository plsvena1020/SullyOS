import { describe, expect, it } from 'vitest';
import {
  GOOGLE_SCOPES, buildEventBody, buildGoogleAuthUrl, buildTaskBody, normalizeGoogleEvents,
  normalizeGoogleTasks, mergeHolidayOverlay, isGoogleTokenExpired,
} from './googleCalendar';

describe('googleCalendar pure', () => {
  it('scope 覆盖日历清单/自有事件/待办/公开假日/邮箱', () => {
    expect(GOOGLE_SCOPES).toContain('calendar.readonly');
    expect(GOOGLE_SCOPES).toContain('calendar.events.owned');
    expect(GOOGLE_SCOPES).toContain('https://www.googleapis.com/auth/tasks ');
    expect(GOOGLE_SCOPES).toContain('calendar.events.public.readonly');
    expect(GOOGLE_SCOPES).toContain('userinfo.email');
    // 旧值不得残留：完整 scope 包含只读，重复声明无意义
    expect(GOOGLE_SCOPES).not.toContain('calendar.events.readonly');
    expect(GOOGLE_SCOPES).not.toContain('tasks.readonly');
    expect(GOOGLE_SCOPES).not.toContain('gmail');
  });
  it('授权 URL 带 client_id/redirect_uri/state/scope', () => {
    const url = buildGoogleAuthUrl({ clientId: 'CID', redirectUri: 'http://localhost:3000/x', state: 'S' });
    expect(url.startsWith('https://accounts.google.com/o/oauth2/v2/auth?')).toBe(true);
    expect(url).toContain('client_id=CID');
    expect(url).toContain('access_type=offline');
  });
  it('全天事件用 start.date，cancelled 跳过', () => {
    const out = normalizeGoogleEvents([
      { id: '1', status: 'confirmed', summary: '中秋', start: { date: '2026-09-25' } },
      { id: '2', status: 'cancelled', summary: '作废', start: { date: '2026-09-25' } },
      { id: '3', status: 'confirmed', summary: '会', start: { dateTime: '2026-09-25T15:00:00+08:00' }, location: '国贸' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ dateKey: '2026-09-25', title: '中秋' });
    expect(out[1]).toMatchObject({ dateKey: '2026-09-25', location: '国贸' });
  });
  it('待办无 due 时 dueKey 为 null', () => {
    const out = normalizeGoogleTasks([{ title: '买机票', status: 'needsAction' }]);
    expect(out[0]).toMatchObject({ title: '买机票', dueKey: null });
  });
  it('假日合并 google 优先，缺失回落 cnHoliday，再缺失 null', () => {
    expect(mergeHolidayOverlay('中秋节', { isOffDay: true, name: '本地' })).toMatchObject({ name: '中秋节' });
    expect(mergeHolidayOverlay(null, { isOffDay: false, name: '补班' })).toMatchObject({ name: '补班' });
    expect(mergeHolidayOverlay(null, null)).toBeNull();
  });
  it('过期提前 60 秒', () => {
    expect(isGoogleTokenExpired(Date.now() + 30_000)).toBe(true);
    expect(isGoogleTokenExpired(Date.now() + 120_000)).toBe(false);
  });
  it('全天写体 start.date 为当日且 end.date 为次日', () => {
    const body = buildEventBody({ title: '放假', dateKey: '2026-09-25' });
    expect(body.start.date).toBe('2026-09-25');
    expect(body.end.date).toBe('2026-09-26');
  });
  it('时刻写体 start 含 T09:00:00 且 end 为 10:00', () => {
    const body = buildEventBody({ title: '开会', dateKey: '2026-09-25', timeText: '09:00' });
    expect(body.start.dateTime).toContain('T09:00:00');
    expect(body.end.dateTime).toContain('10:00');
  });
  it('无 due 的 task 写体不带 due 键', () => {
    const body = buildTaskBody({ title: '买机票' });
    expect('due' in body).toBe(false);
  });
});
