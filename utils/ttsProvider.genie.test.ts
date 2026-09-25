import { describe, expect, it } from 'vitest';
import { isGenieVoiceEnabledSync, setGenieVoiceEnabled } from './ttsProvider';

describe('Genie 开关单例', () => {
  it('只有显式 true 才为 true（undefined/false 都关闭）', () => {
    setGenieVoiceEnabled(undefined);
    expect(isGenieVoiceEnabledSync()).toBe(false);
    setGenieVoiceEnabled(false);
    expect(isGenieVoiceEnabledSync()).toBe(false);
    setGenieVoiceEnabled(true);
    expect(isGenieVoiceEnabledSync()).toBe(true);
  });
});
