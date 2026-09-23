// worker/sullyos-home/src/memoryLeaf.ts
export interface MemoryLeaf { summary: string; room: string; importance: number }
const FACT_RE = /(下周|明天|记得|喜欢|讨厌|要去|买了|约了|上海|北京|出差|生日|会议)/;
export function extractMemories(msgs: Array<{ role: string; content: string }>): MemoryLeaf[] {
  return msgs.filter((m) => FACT_RE.test(m.content)).map((m) => ({
    summary: m.content.slice(0, 120), room: 'living', importance: 0.6,
  }));
}
export function mergePlateEntries(base: string[], incoming: string[]): string[] {
  return [...new Set([...base, ...incoming])].slice(-12);
}
