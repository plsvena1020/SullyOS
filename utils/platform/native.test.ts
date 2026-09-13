import { describe, expect, it } from 'vitest';
import { invokeTauri } from './native';

describe('native loaders', () => {
  it('invokeTauri outside Tauri rejects with readable error', async () => {
    await expect(invokeTauri('nope')).rejects.toThrow(/tauri unavailable/);
  });
});
