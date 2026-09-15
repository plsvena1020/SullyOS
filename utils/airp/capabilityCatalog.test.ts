import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { AIRP_CAPABILITIES } from './capabilityCatalog';
import type { AirpCapability } from './types';

const EXPECTED: AirpCapability[] = [
  { id: 'memory_deep_dive', title: '定向深挖记忆（基线召回之上补检索）', environment: 'shared', risk: 'read', category: 'memory', toolNames: ['recall_deep'] },
  { id: 'web_search',  title: '网页搜索', environment: 'shared', risk: 'read', category: 'external', toolNames: ['web_search'] },
  { id: 'read_note',   title: '读笔记',   environment: 'shared', risk: 'read', category: 'memory', toolNames: ['read_note'] },
  { id: 'weather_elsewhere', title: '查第三地天气（当前地已固定注入，此工具只查其他地点）', environment: 'shared', risk: 'read', category: 'weather', toolNames: ['weather_lookup_place'] },
  { id: 'amap_nearby', title: '查周边地点', environment: 'shared', risk: 'read', category: 'location', toolNames: ['amap_search_places'] },
  { id: 'amap_route',  title: '查路线耗时', environment: 'shared', risk: 'read', category: 'location', toolNames: ['amap_route'] },
  { id: 'schedule_write', title: '自管排程', environment: 'browser', risk: 'low_write', category: 'schedule', toolNames: ['schedule_now', 'schedule_cancel', 'schedule_renew'] },
  { id: 'diary_write',    title: '写日记', environment: 'browser', risk: 'low_write', category: 'memory', toolNames: ['save_diary'] },
  { id: 'mcp_passthrough', title: 'MCP 工具（白名单展开）', environment: 'shared', risk: 'confirm', category: 'external', toolNames: [] },
];

describe('AIRP_CAPABILITIES — locked catalog shape', () => {
  it('exposes exactly the 9 registered capabilities in order', () => {
    expect(AIRP_CAPABILITIES).toHaveLength(9);
    expect(AIRP_CAPABILITIES).toEqual(EXPECTED);
  });

  it('has 9 unique ids', () => {
    expect(new Set(AIRP_CAPABILITIES.map((c) => c.id)).size).toBe(9);
  });

  it('each entry matches its verbatim environment/risk/category/toolNames', () => {
    for (const expected of EXPECTED) {
      const actual = AIRP_CAPABILITIES.find((c) => c.id === expected.id);
      expect(actual).toEqual(expected);
    }
  });

  it('mcp_passthrough is legal with an empty toolNames array (expanded by whitelist at runtime)', () => {
    const mcp = AIRP_CAPABILITIES.find((c) => c.id === 'mcp_passthrough');
    expect(mcp?.toolNames).toEqual([]);
    expect(Array.isArray(mcp?.toolNames)).toBe(true);
  });

  it('is assignable to readonly AirpCapability[]', () => {
    const typed: readonly AirpCapability[] = AIRP_CAPABILITIES;
    expect(typed).toBe(AIRP_CAPABILITIES);
  });
});

describe('purity', () => {
  it('imports nothing but ./types', () => {
    const source = readFileSync(new URL('./capabilityCatalog.ts', import.meta.url), 'utf8');
    const specifiers = [
      ...source.matchAll(/from\s+['"]([^'"]+)['"]/g),
      ...source.matchAll(/import\s+['"]([^'"]+)['"]/g),
    ].map((m) => m[1]);

    expect(specifiers.every((s) => s === './types')).toBe(true);
  });
});
