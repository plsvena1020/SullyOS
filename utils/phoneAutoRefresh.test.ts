import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ DB: { getMessagesByCharId: vi.fn() } }));
vi.mock("./context", () => ({ ContextBuilder: { buildCoreContext: vi.fn(() => "CTX") } }));
vi.mock("./memoryPalace/pipeline", () => ({ injectMemoryPalace: vi.fn(async () => {}) }));
vi.mock("./airp/eventStore", () => ({ listAirpEventsByChar: vi.fn(async () => []) }));

import { isPhoneAutoRefreshDue, maybeAutoRefreshPhone, type PhoneAutoApiConfig } from "./phoneAutoRefresh";
import { DB } from "./db";
import { listAirpEventsByChar } from "./airp/eventStore";
import type { AirpCommittedEvent } from "./airp/commit";
import type { CharacterProfile, PhoneEvidence } from "../types";

const char = (ps: unknown) => ({ id: "c1", phoneState: ps } as never);

describe("isPhoneAutoRefreshDue", () => {
  it("returns false when autoRefresh off", () => {
    expect(isPhoneAutoRefreshDue(char(undefined))).toBe(false);
    expect(isPhoneAutoRefreshDue(char({ autoRefresh: false }), Date.now())).toBe(false);
  });
  it("uses default 30min interval", () => {
    const now = 1000000000;
    expect(isPhoneAutoRefreshDue(char({ autoRefresh: true, lastAutoRefreshAt: 0 }), now)).toBe(true);
    expect(isPhoneAutoRefreshDue(char({ autoRefresh: true, lastAutoRefreshAt: now - 29 * 60_000 }), now)).toBe(false);
    expect(isPhoneAutoRefreshDue(char({ autoRefresh: true, lastAutoRefreshAt: now - 30 * 60_000 }), now)).toBe(true);
  });
  it("respects custom interval", () => {
    const now = 2000000000;
    expect(isPhoneAutoRefreshDue(char({ autoRefresh: true, autoRefreshIntervalMin: 15, lastAutoRefreshAt: now - 14 * 60_000 }), now)).toBe(false);
    expect(isPhoneAutoRefreshDue(char({ autoRefresh: true, autoRefreshIntervalMin: 15, lastAutoRefreshAt: now - 15 * 60_000 }), now)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// Task 28 · AIRP 事件投影：自动刷新把世界事件当素材，记录带回锚点 + 事件时间戳
// ─────────────────────────────────────────────────────────────

const makeEvent = (overrides: Partial<AirpCommittedEvent> = {}): AirpCommittedEvent => ({
  id: "e1",
  charId: "c1",
  type: "relationship",
  summary: "和阿禾聊了搬家",
  participants: [],
  impact: "minor",
  at: 111,
  authority: "confirmed_scene",
  disclosedToUser: true,
  source: { kind: "runtime" },
  ...overrides,
});

const buildChar = (phoneState: Record<string, unknown>): CharacterProfile => ({
  id: "c1",
  name: "阿晴",
  phoneState: { autoRefresh: true, lastAutoRefreshAt: 0, records: [], ...phoneState },
} as unknown as CharacterProfile);

const API: PhoneAutoApiConfig = { baseUrl: "https://api.test/v1", apiKey: "k", model: "m" };

const recordsOf = (state: Partial<CharacterProfile>): PhoneEvidence[] =>
  (state.phoneState?.records || []) as PhoneEvidence[];

const stubLlm = (items: unknown[]) => {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(items) } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const promptOf = (fetchMock: ReturnType<typeof vi.fn>): string => {
  const init = fetchMock.mock.calls[0][1] as RequestInit;
  return (JSON.parse(String(init.body)) as { messages: { content: string }[] }).messages[0].content;
};

const runAutoRefresh = async (
  charProfile: CharacterProfile,
  events: AirpCommittedEvent[],
): Promise<{ added: number | null; state: Partial<CharacterProfile> }> => {
  vi.mocked(DB.getMessagesByCharId).mockResolvedValue([]);
  vi.mocked(listAirpEventsByChar).mockResolvedValue(events);
  let captured: Partial<CharacterProfile> | undefined;
  const added = await maybeAutoRefreshPhone(
    "c1",
    { char: charProfile, user: { name: "我" } as never, roster: [], api: API },
    (_id, updates) => { captured = updates(charProfile); },
  );
  return { added, state: captured as Partial<CharacterProfile> };
};

describe("maybeAutoRefreshPhone · AIRP 事件投影", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listAirpEventsByChar).mockResolvedValue([]);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("feeds unprojected relationship events and anchors the new chat records", async () => {
    const charProfile = buildChar({ records: [] });
    const fetchMock = stubLlm([
      { title: "阿禾", kind: "npc", identity: "邻居", detail: "对方: 搬完了？\n我: 差不多了" },
    ]);
    const { added, state } = await runAutoRefresh(charProfile, [makeEvent({ id: "ev-1", at: 111 })]);

    expect(added).toBe(1);
    const [record] = recordsOf(state);
    expect(record.airpEventIds).toEqual(["ev-1"]);
    expect(record.timestamp).toBe(111);

    const prompt = promptOf(fetchMock);
    expect(prompt).toContain("- 和阿禾聊了搬家");
    expect(prompt).toContain("不得虚构");
  });

  it("aligns timestamps to the newest events and anchors every new record", async () => {
    const charProfile = buildChar({ records: [] });
    const fetchMock = stubLlm([
      { title: "阿禾", kind: "npc", detail: "对方: 一" },
      { title: "小林", kind: "npc", detail: "对方: 二" },
    ]);
    const { added, state } = await runAutoRefresh(charProfile, [
      makeEvent({ id: "e-old", at: 1000, summary: "旧事" }),
      makeEvent({ id: "e-new", at: 3000, summary: "新事" }),
    ]);

    expect(added).toBe(2);
    const records = recordsOf(state);
    expect(records.map((r) => r.timestamp)).toEqual([3000, 1000]);
    expect(records[0].airpEventIds).toEqual(["e-new", "e-old"]);
    expect(records[1].airpEventIds).toEqual(["e-new", "e-old"]);
    expect(promptOf(fetchMock)).toContain("- 新事\n- 旧事");
  });

  it("gives each record its own anchor array (no shared-reference aliasing)", async () => {
    const charProfile = buildChar({ records: [] });
    stubLlm([
      { title: "阿禾", kind: "npc", detail: "对方: 一" },
      { title: "小林", kind: "npc", detail: "对方: 二" },
    ]);
    const { state } = await runAutoRefresh(charProfile, [
      makeEvent({ id: "e-old", at: 1000, summary: "旧事" }),
      makeEvent({ id: "e-new", at: 3000, summary: "新事" }),
    ]);

    const records = recordsOf(state);
    expect(records[0].airpEventIds).not.toBe(records[1].airpEventIds);
    records[0].airpEventIds!.push("mutated");
    expect(records[1].airpEventIds).toEqual(["e-new", "e-old"]);
  });

  it("drops already-projected events and keeps the old prompt / record shape", async () => {
    const charProfile = buildChar({
      records: [{ id: "old", type: "chat", title: "旧", detail: "旧", timestamp: 1, airpEventIds: ["ev-1"] }],
    });
    const fetchMock = stubLlm([{ title: "阿禾", kind: "npc", detail: "对方: 三" }]);
    const before = Date.now();
    const { added, state } = await runAutoRefresh(charProfile, [makeEvent({ id: "ev-1", at: 111 })]);

    expect(added).toBe(1);
    const record = recordsOf(state).slice(-1)[0];
    expect(record.airpEventIds).toBeUndefined();
    expect(record.timestamp).toBeGreaterThanOrEqual(before);
    expect(promptOf(fetchMock)).not.toContain("最近真实发生过的事");
  });

  it("leaves unmapped event types out of the chat material", async () => {
    const charProfile = buildChar({ records: [] });
    const fetchMock = stubLlm([{ title: "阿禾", kind: "npc", detail: "对方: 四" }]);
    const { state } = await runAutoRefresh(charProfile, [
      makeEvent({ id: "act-1", type: "activity", at: 222, summary: "去跑步" }),
    ]);

    expect(recordsOf(state)[0].airpEventIds).toBeUndefined();
    expect(promptOf(fetchMock)).not.toContain("去跑步");
  });
});
