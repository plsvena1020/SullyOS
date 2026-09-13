import { detectRuntime } from './detect';

/**
 * 原生壳不注册 Service Worker：Android WebView 没有 Push 绑定，
 * Windows WebView2 没有 PushManager，注册只会进入半工作态。
 */
export function shouldRegisterServiceWorker(g: typeof globalThis = globalThis): boolean {
  return detectRuntime(g) === 'web';
}
