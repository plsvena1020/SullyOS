/**
 * Google 桥接服务前端客户端（只读）。
 * 形状照抄 utils/proxyWorker.ts（base URL 懒读 + fallback）与
 * utils/realtimeContext.ts NotionManager.testConnection（不可达分支文案结构）。
 */

const BRIDGE_URL_KEY = 'aetheros.google.bridgeUrl';
const BRIDGE_TOKEN_KEY = 'aetheros.google.bridgeToken';

export const DEFAULT_GOOGLE_BRIDGE_URL = 'http://127.0.0.1:8841';

const normalize = (url: string): string => url.trim().replace(/\/+$/, '');

/**
 * 读取当前生效的桥接服务地址（已去尾斜杠）。懒读 localStorage，
 * 用户在设置里改完、新发起的请求立刻生效，无需刷新页面。
 */
export const readGoogleBridgeUrl = (): string => {
  try {
    const raw = localStorage.getItem(BRIDGE_URL_KEY);
    if (!raw) return DEFAULT_GOOGLE_BRIDGE_URL;
    const url = normalize(raw);
    if (!/^https?:\/\//i.test(url)) return DEFAULT_GOOGLE_BRIDGE_URL;
    return url;
  } catch {
    return DEFAULT_GOOGLE_BRIDGE_URL;
  }
};

const toHeaderRecord = (headers: HeadersInit | undefined): Record<string, string> => {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => { out[key] = value; });
    return out;
  }
  if (Array.isArray(headers)) {
    const out: Record<string, string> = {};
    for (const [key, value] of headers) out[key] = value;
    return out;
  }
  return { ...(headers as Record<string, string>) };
};

/**
 * 经桥接服务发请求：自动拼 base，并带上 X-Google-Bridge-Token
 *（读 localStorage['aetheros.google.bridgeToken']）。
 * X-Google-Account 由调用方经 init.headers 传入，直接透传。
 */
export const googleBridgeFetch = (path: string, init?: RequestInit): Promise<Response> => {
  const base = readGoogleBridgeUrl();
  let token = '';
  try {
    token = localStorage.getItem(BRIDGE_TOKEN_KEY) || '';
  } catch {
    token = '';
  }
  const headers: Record<string, string> = toHeaderRecord(init?.headers);
  if (token) headers['X-Google-Bridge-Token'] = token;
  return fetch(`${base}${path}`, { ...init, headers });
};

/**
 * 经桥接服务创建日历事件：POST /api/events，.json() 透传。
 * calendarId/event 不校验不清洗（W1/W4 负责形状）。
 */
export const createGoogleEvent = ({ accountId, calendarId, event }: { accountId: string; calendarId: string; event: any }): Promise<any> =>
  googleBridgeFetch('/api/events', {
    method: 'POST',
    headers: { 'X-Google-Account': accountId },
    body: JSON.stringify({ accountId, calendarId, event }),
  }).then((res) => res.json());

/**
 * 经桥接服务创建任务：POST /api/tasks，tasklist 缺省 '@default'，.json() 透传。
 */
export const createGoogleTask = ({ accountId, tasklist = '@default', task }: { accountId: string; tasklist?: string; task: any }): Promise<any> =>
  googleBridgeFetch('/api/tasks', {
    method: 'POST',
    headers: { 'X-Google-Account': accountId },
    body: JSON.stringify({ accountId, tasklist, task }),
  }).then((res) => res.json());

/**
 * 经桥接服务创建日历：POST /api/calendars，.json() 透传。
 * summary 不校验不清洗。
 */
export const createGoogleCalendar = ({ accountId, summary }: { accountId: string; summary: string }): Promise<any> =>
  googleBridgeFetch('/api/calendars', {
    method: 'POST',
    headers: { 'X-Google-Account': accountId },
    body: JSON.stringify({ accountId, summary }),
  }).then((res) => res.json());

/**
 * 经桥接服务更新日历事件：PUT /api/events/{eventId}，.json() 透传。
 * calendarId/event 不校验不清洗。
 */
export const updateGoogleEvent = ({ accountId, calendarId, eventId, event }: { accountId: string; calendarId: string; eventId: string; event: any }): Promise<any> =>
  googleBridgeFetch(`/api/events/${encodeURIComponent(eventId)}`, {
    method: 'PUT',
    headers: { 'X-Google-Account': accountId },
    body: JSON.stringify({ accountId, calendarId, event }),
  }).then((res) => res.json());

/**
 * 经桥接服务删除日历事件：DELETE /api/events/{eventId}?calendarId=，.json() 透传。
 */
export const deleteGoogleEvent = ({ accountId, calendarId, eventId }: { accountId: string; calendarId: string; eventId: string }): Promise<any> =>
  googleBridgeFetch(`/api/events/${encodeURIComponent(eventId)}?calendarId=${encodeURIComponent(calendarId)}`, {
    method: 'DELETE',
    headers: { 'X-Google-Account': accountId },
  }).then((res) => res.json());

export const GoogleBridgeClient = {
  /**
   * 测试桥接服务连接（调 /api/health，免鉴权）。
   */
  testConnection: async (): Promise<{ success: boolean; message: string }> => {
    const base = readGoogleBridgeUrl();
    try {
      const response = await googleBridgeFetch('/api/health', { method: 'GET' });
      const text = await response.text();
      if (!response.ok) {
        try {
          const errJson = JSON.parse(text);
          return { success: false, message: `连接失败: ${errJson.error || errJson.message || response.status}` };
        } catch {
          return { success: false, message: `连接失败: ${response.status}` };
        }
      }
      try {
        JSON.parse(text);
        return { success: true, message: '连接成功！桥接服务正常' };
      } catch {
        return { success: false, message: '返回格式错误' };
      }
    } catch (e: any) {
      const msg = String(e?.message || e);
      // fetch 在请求根本没到达服务器时抛 TypeError（Safari 报 "Load failed"、
      // Chrome 报 "Failed to fetch"），说明是桥接服务不可达，不是账号问题
      if (/load failed|failed to fetch|networkerror/i.test(msg)) {
        return { success: false, message: `无法连接到 Google 桥接服务 ${base}：请先在浏览器里试试能否直接打开该地址。打不开说明当前网络访问不了它（换网络/开代理后重试），或检查桥接服务是否已启动` };
      }
      return { success: false, message: `网络错误: ${msg}` };
    }
  },
};
