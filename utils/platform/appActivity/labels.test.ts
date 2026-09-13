import { describe, expect, it } from 'vitest';
import { labelOfSullyosApp } from './labels';

describe('labelOfSullyosApp', () => {
  const installed = [
    { id: 'chat', name: 'Message' },
    { id: 'settings', name: '设置' },
  ];
  it('resolves installed, hidden, then falls back to id', () => {
    expect(labelOfSullyosApp('chat', installed, {})).toBe('Message');
    expect(labelOfSullyosApp('home', installed, { home: '家园' })).toBe('家园');
    expect(labelOfSullyosApp('mystery', installed, {})).toBe('mystery');
  });
});
