// Google Calendar 纯函数层：无网络、无 secrets，可被前端与单测直接引用。
export const GOOGLE_SCOPES =
  'https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/tasks https://www.googleapis.com/auth/calendar.events.public.readonly';

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
