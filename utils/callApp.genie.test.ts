import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(path.resolve(__dirname, '../apps/CallApp.tsx'), 'utf8');

const GENIE_EMOTIONS = 'happy/sad/angry/fearful/surprised/calm/fluent';
const LEGACY_EMOTIONS = 'happy/sad/angry/fearful/disgusted/surprised/calm/fluent';

describe('CallApp Genie voice wiring', () => {
  it('uses the Genie guide/display path and a 7-item emotion list', () => {
    const list = source.match(/const voiceEmotionList = isGenieVoiceEnabledSync\(\)\s*\?\s*'([^']+)'\s*:\s*'([^']+)'/);
    expect(list).not.toBeNull();
    expect(list?.[1]).toBe(GENIE_EMOTIONS);
    expect(list?.[1]).not.toContain('disgusted');
    expect(list?.[2]).toBe(LEGACY_EMOTIONS);
    expect(source).toContain('（情绪只能取 ${voiceEmotionList}）');
    expect(source).toContain('if (isGenieVoiceEnabledSync()) return GENIE_VOICE_ACTING_GUIDE;');
    expect(source).toContain('if (isGenieVoiceEnabledSync()) return cleanTextForTtsGenie(text);');
    expect(source).toContain('const GENIE_LEADING_EMOTION_RE = /^\\s*[\\[【]\\s*(happy|sad|angry|fearful|surprised|calm|fluent)\\s*[\\]】]\\s*/i;');
  });
});
