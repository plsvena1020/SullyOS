/**
 * 查手机 · 定时自动刷新引擎。
 *
 * 用户不再需要每次点进查手机手动点刷新：开启 autoRefresh 的角色，到间隔
 * 就由全局调度器（OSContext 每分钟 tick）或打开 App 时的补刷检查自动重生成
 * 一批聊天记录。单写入者设计：maybeAutoRefreshPhone 内部用 inFlight 集合 +
 * staleness 检查保证同一个角色不会并发刷、也不会刚刷过又刷。
 *
 * 与手动刷新的差异：自动刷新**只写 phoneState**（records / contacts），
 * 不往私聊塞 phone_card——后台无人值守的动作保持最小侵入，聊天内容是否
 * 带手机卡片仍由用户手动刷新时决定（sendToChat）。
 */
import type { CharacterProfile, PhoneContact, PhoneEvidence, UserProfile } from '../types';
import { DB } from './db';
import { ContextBuilder } from './context';
import { extractContent, extractJson, safeResponseJson } from './safeApi';
import { injectMemoryPalace } from './memoryPalace/pipeline';
import { upsertContact, matchRealChar, normName } from './relationshipChat';
import { phoneFieldToText } from './phoneEvidence';
import { listAirpEventsByChar } from './airp/eventStore';
import { renderCheckPhoneMaterialSection, selectCheckPhoneMaterial } from './airp/projection';

/** 自动刷新 API 配置（与 relationshipGen 同构） */
export interface PhoneAutoApiConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
}

export interface PhoneAutoSnapshot {
    char: CharacterProfile;
    user: UserProfile;
    /** 神经链接里真实存在的其他角色（真假甄别用，需完整对象以取设定简介） */
    roster: CharacterProfile[];
    api: PhoneAutoApiConfig;
}

/** 正在刷新的 charId 集合：防并发（OSContext tick 与 App 打开补刷可能同时到达） */
const inFlight = new Set<string>();

/** 判断该角色现在是否到了该刷的时间（staleness 检查，含默认间隔 30 分钟） */
export const isPhoneAutoRefreshDue = (char: CharacterProfile, now = Date.now()): boolean => {
    if (!char.phoneState?.autoRefresh) return false;
    const intervalMin = char.phoneState.autoRefreshIntervalMin && char.phoneState.autoRefreshIntervalMin > 0
        ? char.phoneState.autoRefreshIntervalMin : 30;
    const last = char.phoneState.lastAutoRefreshAt || 0;
    return now - last >= intervalMin * 60_000;
};

/**
 * 到点自动刷新一批「聊天软件」记录。
 * 返回新增条数；null = 没刷（未到时间 / 已在刷 / 无 key）。
 * 抛错 = 生成失败（调用方决定是否提示；调度器静默重试下一轮）。
 */
export const maybeAutoRefreshPhone = async (
    charId: string,
    snap: PhoneAutoSnapshot,
    updateCharacter: (id: string, updates: (prev: CharacterProfile) => Partial<CharacterProfile>) => void,
): Promise<number | null> => {
    const { char, user, roster, api } = snap;
    if (char.id !== charId) return null;
    if (!isPhoneAutoRefreshDue(char)) return null;
    if (!api.apiKey) return null;
    if (inFlight.has(charId)) return null;
    inFlight.add(charId);
    try {
        // —— 组 context（与手动刷新同口径：记忆宫殿 + 时间感知 + 最近聊天）——
        await injectMemoryPalace(char);
        const limit = char.contextLimit && char.contextLimit > 0 ? char.contextLimit : 500;
        const msgs = await DB.getMessagesByCharId(char.id);
        const lastMsg = msgs[msgs.length - 1];
        const context = ContextBuilder.buildCoreContext(
            char, user, true, undefined, undefined,
            { lastInteractionTs: lastMsg?.timestamp },
        );
        const recentMsgs = msgs.slice(-limit).map(m => {
            const roleName = m.role === 'user' ? user.name : char.name;
            const content = m.type === 'text' ? m.content : `[${m.type}]`;
            return `${roleName}: ${content}`;
        }).join('\n');

        // —— 真假甄别规则（与手动刷新 chat 分支同源）——
        const myContacts = char.phoneState?.contacts || [];
        const briefOf = (ch: CharacterProfile) => (ch.socialProfile?.bio || ch.description || ch.systemPrompt || '')
            .replace(/\s+/g, ' ').trim().slice(0, 90);
        const rosterInfo = roster.length
            ? roster.map(c => {
                const known = myContacts.find(k => k.linkedCharId === c.id);
                const rel = known
                    ? `；和机主的已知关系：${known.identity || '未标注'}${known.note ? `（备注：${known.note}）` : ''}`
                    : '；机主通讯录里暂无 TA（未必认识）';
                return `- ${c.name}：${briefOf(c) || '（无公开设定）'}${rel}`;
            }).join('\n')
            : '（无其他真实角色）';
        const allowFictional = char.phoneState?.allowFictionalContacts !== false;
        const fictionRule = allowFictional
            ? ''
            : `\n**硬约束**：禁止虚构任何 NPC，联系人**只能**取自上面的真实角色名单。若名单为空，直接返回空数组 []。`;
        const realCharRule = `**真实存在的人（神经链接名单 · 含设定与已知关系）**：
${rosterInfo}

**真假甄别 + 关系判定（务必走心）**：
- 联系人就是名单里的人 → "kind":"real"，"linkedName" 填名单里的**原名**；否则按人设虚构 → "kind":"npc"。
- **关系必须贴合上面每个真实角色的设定与已知关系，别凭空安成「同事/老友」**。不认识就别硬塞进通讯录。
- "identity" 写**机主对 TA 的称呼 / 关系备注**（如「学长」「前任」「彼方网友」），要具体贴合来历。${fictionRule}`;

        // AIRP 事件投影（查手机 · 自动刷新）：自动刷新只产 chat 记录，按锁定映射取
        // relationship 事件当素材。去重是无状态的——扫该角色现有 phoneState.records 上的
        // airpEventIds 求并集。没有未投影素材时素材块为空串，prompt 与记录逐字节等同旧行为。
        const projectedEventIds = new Set<string>(
            (char.phoneState?.records || []).flatMap(r => r.airpEventIds ?? []),
        );
        const airpMaterial = selectCheckPhoneMaterial(
            await listAirpEventsByChar(char.id),
            projectedEventIds,
            'chat',
        );
        const airpMaterialSection = renderCheckPhoneMaterialSection(airpMaterial);

        const prompt = `${context}

### [你和用户「${user.name}」的最近聊天（仅背景参考）]
${recentMsgs}

### [视角锁定 · 极重要]
接下来要生成的是**你（${char.name}）自己手机里的东西**——你自己的生活、社交、记录。完全用**你的第一人称视角**；用户「${user.name}」只是在偷看你的手机，TA **不是**你的联系人。

### [Task · 自动生活更新]
时间静静流逝，你的生活在继续。生成 3 个**你（${char.name}）自己**手机聊天软件里的**对话片段**（你和你自己联系人的对话，第一人称视角，不是用户的社交）。

${realCharRule}${airpMaterialSection}

要求：
1. **联系人**: 真实角色按上面的设定与关系来；其余可按人设虚构合理的人。不要用"User"。
2. **对话感**: 有来有回的对话脚本（3-4句），体现真实的关系。
3. **格式**: 严格用 "我:..." 代表主角(你)，"对方:..." 代表联系人。
4. **内容要新**: 与「最近聊天」错开，是你这段时间自己生活里发生的新片段。
格式JSON数组: [{ "title": "真实角色填原名/虚构填名字", "kind": "real|npc", "linkedName": "若 real 填真实角色原名否则留空", "identity": "机主对 TA 的称呼/关系备注", "affinity": 30, "detail": "对方: 最近怎么样？\\n我: 还活着。\\n对方: 那就好。" }, ...]`;

        const res = await fetch(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.apiKey}` },
            body: JSON.stringify({ model: api.model, messages: [{ role: 'user', content: prompt }], temperature: 0.8 }),
        });
        if (!res.ok) throw new Error(`LLM ${res.status}`);
        const data = await safeResponseJson(res);
        const content = extractContent(data);
        const json = extractJson(content) || [];
        if (!Array.isArray(json)) throw new Error('解析失败');

        const isUserName = (name?: string) => !!name && normName(name) === normName(user.name);
        let contactsAcc: PhoneContact[] = [...(char.phoneState?.contacts || [])];
        const newRecords: PhoneEvidence[] = [];

        for (const item of json) {
            if (!item || typeof item !== 'object') continue;
            const title = phoneFieldToText((item as any).title, 'Unknown');
            const detail = phoneFieldToText((item as any).detail, '...');
            if (!detail) continue;

            // 联系人 upsert（同手动刷新口径）
            const pureName = title.replace(/[（(].*?[）)]/g, '').trim() || title;
            if (isUserName(pureName)) continue;
            const linkedId = (item as any).kind === 'real'
                ? (matchRealChar((item as any).linkedName || pureName, roster.map(c => ({ id: c.id, name: c.name }))) || matchRealChar(pureName, roster.map(c => ({ id: c.id, name: c.name }))))
                : matchRealChar(pureName, roster.map(c => ({ id: c.id, name: c.name })));
            const kind: PhoneContact['kind'] = linkedId ? 'real' : 'npc';
            if (!allowFictional && !linkedId) continue;
            const realChar = roster.find(c => c.id === linkedId);
            const existingByLink = linkedId ? contactsAcc.find(c => c.linkedCharId === linkedId) : undefined;
            const contactName = existingByLink?.name || realChar?.name || pureName;
            contactsAcc = upsertContact(contactsAcc, {
                name: contactName,
                identity: phoneFieldToText((item as any).identity),
                kind,
                linkedCharId: linkedId,
                avatar: linkedId ? realChar?.avatar : undefined,
                affinity: typeof (item as any).affinity === 'number' ? (item as any).affinity : undefined,
                lastInteraction: Date.now(),
            });
            const contactId = contactsAcc.find(c => (linkedId && c.linkedCharId === linkedId) || normName(c.name) === normName(contactName))?.id;

            newRecords.push({
                id: `rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                type: 'chat',
                title,
                detail,
                timestamp: Date.now(),
                contactId,
            });
        }

        // AIRP 投影锚点 + 时间戳：这批记录若来自上面的事件素材，就带上事件 id（下次无状态去重）
        // 并把时间戳对齐到事件 at（修掉「全堆在写入时刻」的时间聚集）。空素材/零记录时一个字段不动。
        if (airpMaterial.length > 0) {
            const airpEventIds = airpMaterial.map(event => event.id);
            newRecords.forEach((record, index) => {
                record.airpEventIds = [...airpEventIds];
                record.timestamp = airpMaterial[Math.min(index, airpMaterial.length - 1)].at;
            });
        }

        // 合并落库：updater 取最新状态，不覆盖并发写入的其他字段。
        // 自动刷新只写 phoneState，不往私聊塞 phone_card（保持后台动作最小侵入）。
        const added = newRecords.length;
        updateCharacter(charId, (cur) => ({
            phoneState: {
                ...cur.phoneState,
                records: [...(cur.phoneState?.records || []), ...newRecords],
                contacts: contactsAcc,
                lastAutoRefreshAt: Date.now(),
            },
        }));
        return added;
    } finally {
        inFlight.delete(charId);
    }
};