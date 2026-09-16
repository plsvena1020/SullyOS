// utils/xhsSession.test.ts
import { describe, it, expect } from 'vitest';
import {
    classifyXhsBridgeFailure, RETRYABLE_COMMANDS, isSessionExpiry, assertNoCookieLeak,
} from './xhsSession';

const EXPIRY_TEXT = '这串 cookie 在 xiaohongshu.com 和 rednote.com 两套后端都没有通过登录校验。请从当前实际登录的网站重新复制完整请求 Cookie。';

describe('classifyXhsBridgeFailure', () => {
    it('maps 401 to NO_SESSION', () => {
        expect(classifyXhsBridgeFailure({ httpStatus: 401 })).toBe('NO_SESSION');
    });
    it('maps 429 to RATE_LIMITED', () => {
        expect(classifyXhsBridgeFailure({ httpStatus: 429 })).toBe('RATE_LIMITED');
    });
    it('maps 406/461/471 to UPSTREAM_REJECTED (protected endpoints are not expiry)', () => {
        expect(classifyXhsBridgeFailure({ httpStatus: 406 })).toBe('UPSTREAM_REJECTED');
        expect(classifyXhsBridgeFailure({ httpStatus: 461 })).toBe('UPSTREAM_REJECTED');
        expect(classifyXhsBridgeFailure({ httpStatus: 471 })).toBe('UPSTREAM_REJECTED');
    });
    it('maps the worker login-rejection text to SESSION_EXPIRED', () => {
        expect(classifyXhsBridgeFailure({ errorText: EXPIRY_TEXT })).toBe('SESSION_EXPIRED');
    });
    it('maps check-login logged_in:false to SESSION_EXPIRED', () => {
        expect(classifyXhsBridgeFailure({ endpoint: 'check-login', body: { logged_in: false } })).toBe('SESSION_EXPIRED');
    });
    it('maps timeout to NETWORK_FAILURE', () => {
        expect(classifyXhsBridgeFailure({ errorText: 'XHS_REQUEST_TIMEOUT' })).toBe('NETWORK_FAILURE');
    });
    it('maps unknown shapes to UNKNOWN', () => {
        expect(classifyXhsBridgeFailure({ httpStatus: 500, errorText: 'boom' })).toBe('UNKNOWN');
    });
});

describe('RETRYABLE_COMMANDS', () => {
    it('contains read-only commands only', () => {
        expect(RETRYABLE_COMMANDS.has('search')).toBe(true);
        expect(RETRYABLE_COMMANDS.has('check-login')).toBe(true);
        expect(RETRYABLE_COMMANDS.has('get-feed-detail')).toBe(true);
        expect(RETRYABLE_COMMANDS.has('reply-comment')).toBe(false);
        expect(RETRYABLE_COMMANDS.has('like-feed')).toBe(false);
        expect(RETRYABLE_COMMANDS.has('publish')).toBe(false);
    });
});

describe('isSessionExpiry and assertNoCookieLeak', () => {
    it('isSessionExpiry only true for SESSION_EXPIRED', () => {
        expect(isSessionExpiry('SESSION_EXPIRED')).toBe(true);
        expect(isSessionExpiry('NO_SESSION')).toBe(false);
    });
    it('descriptor without cookie passes the leak check', () => {
        expect(() => assertNoCookieLeak({ nickname: 'x', platform: 'xhs' })).not.toThrow();
    });
    it('cookie key or a1=/web_session= values trip the leak check', () => {
        expect(() => assertNoCookieLeak({ cookie: 'a1=abc' })).toThrow('SESSION_DESCRIPTOR_LEAK');
        expect(() => assertNoCookieLeak({ note: 'a1=secret; web_session=zzz' })).toThrow('SESSION_DESCRIPTOR_LEAK');
    });
});
