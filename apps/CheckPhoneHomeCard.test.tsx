// @vitest-environment jsdom

// 查手机「家」卡片行为测试 —— 钉住三件事：
//   1. VPS 停机显式离线态（徽章 + 横幅都有文案，绝不留白）；
//   2. 切源开关要点两次才写盘（防手滑）；
//   3. 行为参数改完能一键恢复默认。
//
// 环境说明：vitest 全局是 node 环境，本文件靠文件头指令单独跑 jsdom；
// vitest.config.ts 的 include 已收 apps/components（与 utils/worker 同列）。
// 不写 JSX，用 React.createElement（同 utils/blobRefHook.contract.test.ts 手法）。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import CheckPhoneHomeCard from './CheckPhoneHomeCard';

// React 18 下 createRoot + act 必须显式声明 act 环境，否则 act 不聚合更新。
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

const q = (sel: string): HTMLElement | null => container.querySelector(sel) as HTMLElement | null;
const qAll = (sel: string): HTMLElement[] => Array.from(container.querySelectorAll(sel)) as HTMLElement[];

/** 反复放行宏任务，直到 predicate 成立（等探针 + 拉数的异步链跑完）。 */
async function flushUntil(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 80 && !predicate(); i++) {
        await act(async () => {
            await new Promise<void>((resolve) => setTimeout(resolve, 5));
        });
    }
    expect(predicate()).toBe(true);
}

/** 给 React 受控 input 设值（直接调原生 setter 再派 input 事件）。 */
function setInputValue(el: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
        ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
    act(() => {
        setter?.call(el, value);
        el.dispatchEvent(new window.Event('input', { bubbles: true }));
        el.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
}

function click(el: HTMLElement | null) {
    expect(el).not.toBeNull();
    act(() => {
        el!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
}

beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('os_agent_url', 'https://vps.example');
    localStorage.setItem('os_api_token', 't');
    localStorage.setItem('os_home_source', 'local');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
});

describe('CheckPhoneHomeCard', () => {
    it('VPS 停机：徽章显式离线 + 横幅给说法，不留白', async () => {
        vi.stubGlobal('fetch', () => Promise.reject(new Error('down')));
        act(() => {
            root.render(createElement(CheckPhoneHomeCard, { charId: 'c1' }));
        });
        await flushUntil(() => q('[data-testid="home-offline"]') !== null);
        const badge = q('[data-testid="home-badge"]');
        expect(badge?.textContent ?? '').toMatch(/离线/);
        const banner = q('[data-testid="home-offline"]');
        expect(banner?.textContent ?? '').toMatch(/VPS 连不上/);
        expect((banner?.textContent ?? '').trim().length).toBeGreaterThan(10);
    });

    it('切源开关：点一次只提示，点两次才写盘', async () => {
        vi.stubGlobal('fetch', () => Promise.reject(new Error('down')));
        act(() => {
            root.render(createElement(CheckPhoneHomeCard, { charId: 'c1' }));
        });
        await flushUntil(() => q('[data-testid="home-source"]') !== null);

        click(q('[data-testid="home-source"]'));
        // 第一次只亮出二次确认，盘里还是 local。
        expect(q('[data-testid="home-source-confirm"]')).not.toBeNull();
        expect(localStorage.getItem('os_home_source')).toBe('local');

        click(q('[data-testid="home-source"]'));
        // 第二次才真正切到 vps，提示收起。
        expect(localStorage.getItem('os_home_source')).toBe('vps');
        expect(q('[data-testid="home-source-confirm"]')).toBeNull();
    });

    it('行为参数：改完点恢复默认，四组全回滚', async () => {
        vi.stubGlobal('fetch', () => Promise.reject(new Error('down')));
        act(() => {
            root.render(createElement(CheckPhoneHomeCard, { charId: 'c1' }));
        });
        await flushUntil(() => q('[data-testid="home-cfg-roundIntervalMin"]') !== null);

        const interval = q('[data-testid="home-cfg-roundIntervalMin"]') as HTMLInputElement;
        const threshold = q('[data-testid="home-cfg-shareThreshold"]') as HTMLInputElement;
        expect(interval.value).toBe('30');
        setInputValue(interval, '60');
        setInputValue(threshold, '90');
        expect(interval.value).toBe('60');
        expect(threshold.value).toBe('90');

        click(q('[data-testid="home-reset"]'));
        expect((q('[data-testid="home-cfg-roundIntervalMin"]') as HTMLInputElement).value).toBe('30');
        expect((q('[data-testid="home-cfg-shareThreshold"]') as HTMLInputElement).value).toBe('60');
        expect((q('[data-testid="home-cfg-quietStartHour"]') as HTMLInputElement).value).toBe('0');
        expect((q('[data-testid="home-cfg-dailyMaxRounds"]') as HTMLInputElement).value).toBe('48');
        // 顺带确认滑杆也跟着回滚（同一 state 驱动）。
        expect(qAll('input[type="range"]').length).toBe(4);
    });

    it('服务端有存档：挂载后合并进来并回写本地，挂了就用本地顶着', async () => {
        vi.stubGlobal('fetch', (input: any) => {
            const url = String(typeof input === 'string' ? input : input?.url ?? '');
            if (url.includes('/home/config/')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({
                        charId: 'c1',
                        config: { roundIntervalMin: 60, quietStart: '23:00', dailyMaxRounds: 20 },
                    }),
                });
            }
            return Promise.reject(new Error('down'));
        });
        act(() => {
            root.render(createElement(CheckPhoneHomeCard, { charId: 'c1' }));
        });
        await flushUntil(() => (q('[data-testid="home-cfg-roundIntervalMin"]') as HTMLInputElement)?.value === '60');
        expect((q('[data-testid="home-cfg-quietStartHour"]') as HTMLInputElement).value).toBe('23');
        expect((q('[data-testid="home-cfg-dailyMaxRounds"]') as HTMLInputElement).value).toBe('20');
        // shareThreshold 服务端不管，留本地默认。
        expect((q('[data-testid="home-cfg-shareThreshold"]') as HTMLInputElement).value).toBe('60');
        const saved = JSON.parse(localStorage.getItem('os_home_cfg_c1') ?? '{}');
        expect(saved.roundIntervalMin).toBe(60);
    });
});
