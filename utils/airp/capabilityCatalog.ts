import type { AirpCapability } from './types';

export const AIRP_CAPABILITIES: readonly AirpCapability[] = [
  { id: 'memory_deep_dive', title: '定向深挖记忆（基线召回之上补检索）', environment: 'shared', risk: 'read', category: 'memory', toolNames: ['recall_deep'] },
  { id: 'web_search',  title: '网页搜索', environment: 'shared', risk: 'read', category: 'external', toolNames: ['web_search'] },
  { id: 'read_note',   title: '读笔记',   environment: 'shared', risk: 'read', category: 'memory', toolNames: ['read_note'] },
  { id: 'weather_elsewhere', title: '查第三地天气（当前地已固定注入，此工具只查其他地点）', environment: 'shared', risk: 'read', category: 'weather', toolNames: ['weather_lookup_place'] },
  { id: 'amap_nearby', title: '查周边地点', environment: 'shared', risk: 'read', category: 'location', toolNames: ['amap_search_places'] },
  { id: 'amap_route',  title: '查路线耗时', environment: 'shared', risk: 'read', category: 'location', toolNames: ['amap_route'] },
  { id: 'schedule_write', title: '自管排程', environment: 'browser', risk: 'low_write', category: 'schedule', toolNames: ['schedule_now', 'schedule_cancel', 'schedule_renew'] },
  { id: 'diary_write',    title: '写日记', environment: 'browser', risk: 'low_write', category: 'memory', toolNames: ['save_diary'] },
  { id: 'google_calendar_read', title: '查 Google 日程与待办（用户自己的日历、节假日）', environment: 'shared', risk: 'read', category: 'schedule', toolNames: ['google_calendar_query', 'google_task_query'] },
  { id: 'google_calendar_write', title: '帮用户创建 Google 日程或待办（必须先给预览、等用户点头再落盘）', environment: 'browser', risk: 'low_write', category: 'schedule', toolNames: ['google_create_propose', 'google_create_execute'] },
  { id: 'mcp_passthrough', title: 'MCP 工具（白名单展开）', environment: 'shared', risk: 'confirm', category: 'external', toolNames: [] },
];
