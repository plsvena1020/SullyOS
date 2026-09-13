import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { createWebSecureStore } from './web';

describe('web secure store', () => {
  it('set/get/remove roundtrip', async () => {
    const store = createWebSecureStore();
    await store.set('perspective.deviceToken', 'pvd_abc');
    expect(await store.get('perspective.deviceToken')).toBe('pvd_abc');
    await store.remove('perspective.deviceToken');
    expect(await store.get('perspective.deviceToken')).toBeNull();
  });
});
