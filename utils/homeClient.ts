const base = () => (localStorage.getItem('os_agent_url') ?? '').replace(/\/$/, '');
export function getHomeSource(): 'vps' | 'local' {
  return localStorage.getItem('os_home_source') === 'vps' ? 'vps' : 'local';
}
export function setHomeSource(v: 'vps' | 'local'): void {
  localStorage.setItem('os_home_source', v);
}
export async function fetchHome(path: string, init?: RequestInit) {
  const res = await fetch(`${base()}${path}`, {
    ...init,
    headers: {
      'x-client-token': localStorage.getItem('os_api_token') ?? '',
      ...(init?.headers ?? {}),
    },
  }).catch(() => { throw new Error('home-offline'); });
  if (!res.ok) throw new Error(res.status === 401 ? 'home-unauthorized' : 'home-offline');
  return res.json();
}
export async function fetchHomeMessages(charId: string) {
  return fetchHome(`/home/messages?charId=${encodeURIComponent(charId)}`);
}
export async function fetchHomeMemories(charId: string, limit = 50) {
  return fetchHome(`/home/memories?charId=${encodeURIComponent(charId)}&limit=${encodeURIComponent(String(limit))}`);
}
export interface HomeServerConfig {
  roundIntervalMin: number;
  quietStart: string;
  dailyMaxRounds: number;
}
/** 家行为参数读服务端：失败抛 home-offline，调用方回退本地。 */
export async function fetchHomeConfig(charId: string): Promise<HomeServerConfig> {
  const data = await fetchHome(`/home/config/${encodeURIComponent(charId)}`) as { config?: unknown };
  if (!data || typeof data.config !== 'object' || data.config === null) throw new Error('home-offline');
  return data.config as HomeServerConfig;
}
/** 家行为参数写服务端：返回 clamp 后的终值，失败抛 home-offline（本地已落盘）。 */
export async function saveHomeConfig(charId: string, patch: Partial<HomeServerConfig>): Promise<HomeServerConfig> {
  const data = await fetchHome(`/home/config/${encodeURIComponent(charId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  }) as { config?: unknown };
  if (!data || typeof data.config !== 'object' || data.config === null) throw new Error('home-offline');
  return data.config as HomeServerConfig;
}
