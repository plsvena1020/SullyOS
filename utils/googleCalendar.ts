// Google Calendar 纯函数层：无网络、无 secrets，可被前端与单测直接引用。
// scope 清单说明：
// - userinfo.email：只用于设置页显示"已连接 xxx@gmail.com"，不含个人数据；缺了 userinfo 端点 403
// - calendar.readonly：calendarList（日历清单与勾选列表）需要；events.owned 只管事件不管日历元数据
// - calendar.events.owned / tasks：读自有日历事件与待办 + char 主动创建
// - calendar.events.public.readonly：官方节假日日历
export const GOOGLE_SCOPES =
  'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/tasks https://www.googleapis.com/auth/calendar.events.public.readonly https://www.googleapis.com/auth/userinfo.email';

export const GOOGLE_HOLIDAY_CALENDAR_ID = 'zh.china#holiday@group.v.calendar.google.com';

const GOOGLE_AUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth';

export function buildGoogleAuthUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES,
    state: args.state,
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${GOOGLE_AUTH_BASE}?${params.toString()}`;
}

export function buildTokenExchangeBody(args: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Record<string, string> {
  return {
    code: args.code,
    client_id: args.clientId,
    client_secret: args.clientSecret,
    redirect_uri: args.redirectUri,
    grant_type: 'authorization_code',
  };
}

export function normalizeGoogleEvents(items: any[]): Array<{
  dateKey: string;
  title: string;
  startText: string;
  location: string;
  calendarId: string;
  source: 'google';
}> {
  const out: Array<{
    dateKey: string;
    title: string;
    startText: string;
    location: string;
    calendarId: string;
    source: 'google';
  }> = [];
  for (const item of items ?? []) {
    if (item?.status === 'cancelled') continue;
    const start = item?.start ?? {};
    const dateKey =
      typeof start.date === 'string'
        ? start.date
        : typeof start.dateTime === 'string'
          ? start.dateTime.slice(0, 10)
          : null;
    if (!dateKey) continue;
    out.push({
      dateKey,
      title: typeof item?.summary === 'string' ? item.summary : '',
      // 带偏移量的 ISO 串（'2026-09-30T02:39:00-04:00'）原样留着：显示层用 toDate
      // 按自带偏移换算成本地钟点，dateKey 则按事件的本地日期落格（见 formatGoogleEventTime）。
      startText:
        typeof start.dateTime === 'string'
          ? start.dateTime
          : typeof start.date === 'string'
            ? start.date
            : '',
      location: typeof item?.location === 'string' ? item.location : '',
      calendarId: typeof item?.calendarId === 'string' ? item.calendarId : '',
      source: 'google',
    });
  }
  return out;
}

/** 全局统一时区：账号时区可能是 America/New_York，但用户在中国，一律按北京时间呈现。 */
export const GOOGLE_DISPLAY_TIME_ZONE = 'Asia/Shanghai';

const partsFormatter = (() => {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: GOOGLE_DISPLAY_TIME_ZONE,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
  } catch {
    return null; // 老环境缺 Intl 时区数据时退回本地时区
  }
})();

/**
 * 把事件时间显示成北京钟点。
 *
 * Google 返回两种形态：
 *  - 全天：`'2026-10-20'`（无时刻）
 *  - 时刻：`'2026-09-30T02:39:00-04:00'`（带偏移量）或 `'...Z'`（UTC）
 *
 * 早先的实现直接 slice(11,16)，于是 `-04:00` 的美东事件原样显示成 02:39。
 * 这里按 Asia/Shanghai 换算：同一条事件无论 Google 账号时区是什么，都显示北京时间。
 */
export function formatGoogleEventTime(startText: string, fallback = '全天'): string {
  if (!startText) return fallback;
  if (!startText.includes('T')) return fallback; // 全天事件没有时刻
  const d = new Date(startText);
  if (Number.isNaN(d.getTime())) {
    const m = startText.match(/T(\d{2}):(\d{2})/);
    return m ? `${m[1]}:${m[2]}` : fallback;
  }
  if (partsFormatter) {
    const p: Record<string, string> = {};
    for (const { type, value } of partsFormatter.formatToParts(d)) p[type] = value;
    // Intl 在午夜可能给 24，改成 00
    const hh = p.hour === '24' ? '00' : p.hour;
    return `${hh}:${p.minute}`;
  }
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** 事件落在哪一天（按北京时间归日，而非按 UTC 日期或事件原始时区）。 */
export function googleEventLocalDateKey(startText: string): string | null {
  if (!startText || !startText.includes('T')) return null;
  const d = new Date(startText);
  if (Number.isNaN(d.getTime())) return null;
  if (partsFormatter) {
    const p: Record<string, string> = {};
    for (const { type, value } of partsFormatter.formatToParts(d)) p[type] = value;
    return `${p.year}-${p.month}-${p.day}`;
  }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function normalizeGoogleTasks(items: any[]): Array<{
  title: string;
  dueKey: string | null;
  notes: string;
  status: string;
}> {
  return (items ?? []).map((item: any) => ({
    title: typeof item?.title === 'string' ? item.title : '',
    dueKey: typeof item?.due === 'string' ? item.due.slice(0, 10) : null,
    notes: typeof item?.notes === 'string' ? item.notes : '',
    status: typeof item?.status === 'string' ? item.status : 'needsAction',
  }));
}

export function mergeHolidayOverlay(
  googleName: string | null,
  cnInfo: { isOffDay: boolean; name: string } | null,
): { isOffDay: boolean; name: string } | null {
  if (googleName != null) return { isOffDay: cnInfo?.isOffDay ?? true, name: googleName };
  if (cnInfo != null) return { isOffDay: cnInfo.isOffDay, name: cnInfo.name };
  return null;
}

export function isGoogleTokenExpired(expiresAtMs: number, nowMs: number = Date.now()): boolean {
  return nowMs >= expiresAtMs - 60_000;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function addOneDay(dateKey: string): string {
  const [yStr, mStr, dStr] = dateKey.split('-');
  let y = Number(yStr);
  let m = Number(mStr);
  let d = Number(dStr);
  const dim = m === 2 ? (isLeapYear(y) ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31;
  d += 1;
  if (d > dim) {
    d = 1;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

export function buildEventBody(args: {
  title: string;
  dateKey: string;
  timeText?: string;
  timeZone?: string;
  location?: string;
  description?: string;
}): {
  summary: string;
  start: { date?: string; dateTime?: string; timeZone?: string };
  end: { date?: string; dateTime?: string; timeZone?: string };
  location?: string;
  description?: string;
} {
  const body: ReturnType<typeof buildEventBody> = args.timeText == null
    ? { summary: args.title, start: { date: args.dateKey }, end: { date: addOneDay(args.dateKey) } }
    : (() => {
        const [hStr, mStr] = args.timeText.split(':');
        const total = Number(hStr) * 60 + Number(mStr) + 60;
        const endDate = total >= 24 * 60 ? addOneDay(args.dateKey) : args.dateKey;
        const endTotal = total >= 24 * 60 ? total - 24 * 60 : total;
        const endHH = pad2(Math.floor(endTotal / 60));
        const endMM = pad2(endTotal % 60);
        return {
          summary: args.title,
          start: { dateTime: `${args.dateKey}T${args.timeText}:00` },
          end: { dateTime: `${endDate}T${endHH}:${endMM}:00` },
        };
      })();
  if (args.timeText != null && args.timeZone != null) {
    body.start.timeZone = args.timeZone;
    body.end.timeZone = args.timeZone;
  }
  if (args.location != null) body.location = args.location;
  if (args.description != null) body.description = args.description;
  return body;
}

export function buildTaskBody(args: {
  title: string;
  dueKey?: string;
  notes?: string;
}): { title: string; due?: string; notes?: string } {
  const body: { title: string; due?: string; notes?: string } = { title: args.title };
  if (args.dueKey != null) body.due = `${args.dueKey}T00:00:00.000Z`;
  if (args.notes != null) body.notes = args.notes;
  return body;
}
