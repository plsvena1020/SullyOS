import { describe, it, expect } from 'vitest';
import { buildTarotReadingMessages, type TarotReadingInput } from './tarotLlm';
import { cardById, spreadById } from './tarotData';
import type { CharacterProfile, UserProfile } from '../types';

const reader = { id: 'c1', name: 'TestChar' } as CharacterProfile;
const user = { name: 'Tester' } as UserProfile;

const three = spreadById('three')!;
const fool = cardById('major-00-fool')!;
const sun = cardById('major-19-sun')!;
const tower = cardById('major-16-tower')!;

const input: TarotReadingInput = {
  querentName: 'Tester',
  question: '这周适合跳槽吗',
  spread: three,
  drawn: [
    { card: fool, reversed: false, positionName: '过去', positionMeaning: '来路' },
    { card: sun, reversed: true, positionName: '现在', positionMeaning: '当下' },
  ],
};

describe('tarot llm prompt builder', () => {
  it('injects only the drawn cards, never the whole deck', () => {
    const m = buildTarotReadingMessages(reader, user, input);
    expect(m.system).toContain('愚者');
    expect(m.system).toContain('太阳');
    // 没抽到的牌不得出现在 prompt 里（省 token 纪律）
    expect(m.system).not.toContain('高塔');
    expect(m.system).not.toContain(tower.nameEn);
    // 更不该出现整副牌库的痕迹
    expect(m.system).not.toContain('圣杯');
    expect(m.system).not.toContain('星币');
  });

  it('carries position names, orientations and the given meanings', () => {
    const m = buildTarotReadingMessages(reader, user, input);
    expect(m.system).toContain('过去');
    expect(m.system).toContain('现在');
    expect(m.system).toContain('正位');
    expect(m.system).toContain('逆位');
    expect(m.system).toContain(fool.upright.meaning);
    expect(m.system).toContain(sun.reversed.meaning);
    // 反面牌义不得混入
    expect(m.system).not.toContain(fool.reversed.meaning);
    expect(m.system).not.toContain(sun.upright.meaning);
  });

  it('forbids the model from inventing meanings', () => {
    const m = buildTarotReadingMessages(reader, user, input);
    expect(m.system).toMatch(/只能|不得|禁止/);
  });

  it('asks for flowing prose instead of a card-by-card recitation', () => {
    const m = buildTarotReadingMessages(reader, user, input);
    expect(m.system).toMatch(/娓娓|连贯|自然过渡/);
    expect(m.system).toMatch(/不要分点/);
    expect(m.system).not.toContain('按位置逐张');
  });

  it('puts the question and spread in the user turn', () => {
    const m = buildTarotReadingMessages(reader, user, input);
    expect(m.user).toContain('这周适合跳槽吗');
    expect(m.user).toContain('时间之流');
    expect(m.user).toContain('Tester');
  });
});
