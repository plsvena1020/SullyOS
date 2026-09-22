/**
 * 塔罗 LLM 解读：只做「叙述层」，牌义全部来自 tarotData.ts 的静态真实数据。
 *
 * 省 token 纪律：prompt 里只放「本次抽到的几张牌」的牌义（位置 + 正逆位 +
 * 关键词 + 一两句简义），绝不灌入整副牌库。Transport 复刻 pomodoroLlm：
 * direct safeFetchJson POST 到 `${baseUrl}/chat/completions`，失败抛错，
 * 调用方吞掉后回退到本地速览。
 */

import type { CharacterProfile, UserProfile } from '../types';
import { ContextBuilder } from './context';
import { safeFetchJson, extractContent } from './safeApi';
import type { TarotCard, TarotSpread } from './tarotData';

export interface TarotLlmApi {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

export interface TarotDrawnInput {
  card: TarotCard;
  reversed: boolean;
  positionName: string;
  positionMeaning: string;
}

export interface TarotReadingInput {
  /** 问卜者名字：用户或某角色名 */
  querentName: string;
  question?: string;
  spread: TarotSpread;
  drawn: TarotDrawnInput[];
}

export interface TarotLlmMessages {
  system: string;
  user: string;
}

const coreOf = (reader: CharacterProfile, user: UserProfile): string => {
  try {
    return ContextBuilder.buildCoreContext(reader, user, false);
  } catch {
    return `你是${reader.name}。`;
  }
};

export const buildTarotReadingMessages = (
  reader: CharacterProfile,
  user: UserProfile,
  input: TarotReadingInput,
): TarotLlmMessages => {
  const question = input.question?.trim() || '（随缘一问）';
  const cardsText = input.drawn
    .map((d, i) => {
      const face = d.reversed ? d.card.reversed : d.card.upright;
      const orientation = d.reversed ? '逆位' : '正位';
      return (
        `第${i + 1}张【${d.positionName}】${d.card.nameCn}（${d.card.nameEn}，${orientation}）\n` +
        `位置含义：${d.positionMeaning}\n` +
        `关键词：${face.keywords.join('、')}\n` +
        `牌义：${face.meaning}`
      );
    })
    .join('\n\n');
  const system =
    `${coreOf(reader, user)}\n\n` +
    `【塔罗解读】${input.querentName}问：「${question}」\n` +
    `牌阵「${input.spread.nameCn}」（${input.spread.nameEn}），抽到${input.drawn.length}张牌，牌义资料如下：\n\n` +
    `${cardsText}\n\n` +
    `请你像面对面坐在桌前一样，用自己的语气为${input.querentName}娓娓道来。` +
    `不要分点、不要小标题、不要逐张机械复述牌义；把这几张牌串成一段连贯的话，` +
    `让牌与牌之间自然过渡，先回应${input.querentName}的疑问，再顺着牌面展开，最后收拢成你的劝慰或提醒。` +
    `位置含义可以融进叙述里，但别把它们当标题一条条念出来。` +
    `你只能基于上面给出的牌义资料叙述，不得发明资料之外的牌义，也不要复读指令。只输出解读本身。`;
  const userText =
    `【塔罗】${input.querentName}问「${question}」，` +
    `用「${input.spread.nameCn}」牌阵抽到了` +
    `${input.drawn.map((d) => `${d.positionName}·${d.card.nameCn}${d.reversed ? '(逆位)' : ''}`).join('、')}，请为我解读。`;
  return { system, user: userText };
};

export const requestTarotReading = async (
  api: TarotLlmApi,
  reader: CharacterProfile,
  user: UserProfile,
  input: TarotReadingInput,
  maxTokens = 800,
): Promise<string> => {
  const baseUrl = api.baseUrl?.replace(/\/+$/, '');
  if (!baseUrl) throw new Error('missing baseUrl');
  if (!api.model) throw new Error('missing model');
  const msgs = buildTarotReadingMessages(reader, user, input);
  const data = await safeFetchJson(
    `${baseUrl}/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.apiKey || 'sk-none'}` },
      body: JSON.stringify({
        model: api.model,
        messages: [
          { role: 'system', content: msgs.system },
          { role: 'user', content: msgs.user },
        ],
        temperature: 0.9,
        max_tokens: maxTokens,
        stream: false,
      }),
    },
    1,
    30_000,
    { appName: '塔罗', charId: reader.id, charName: reader.name, purpose: '塔罗牌解读' },
  );
  const text = extractContent(data)?.trim();
  if (!text) throw new Error('empty reply');
  return text;
};
