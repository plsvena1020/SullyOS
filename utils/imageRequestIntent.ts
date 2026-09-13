/**
 * imageRequestIntent — 「用户这条消息是不是在明确要图」的轻量判定。
 *
 * 两个消费方共用：
 *   1. 聊天提示词（发送时刻构建）：命中时追加一句「这一轮必须真的输出生图标签」的硬提醒，
 *      提高模型真的发图的比例（本地聊天与云端即时对话都吃得到）；
 *   2. 后处理诊断：模型回复里一个生图标签都没有、而用户又在要图时留一条痕，
 *      把「模型没写」和「链路坏了」分开。
 *
 * 纯正则、零依赖；判错的代价只是多一句提醒 / 多一条日志，不改任何行为。
 */

import type { Message } from '../types';

// 要图意图关键词。宁可略宽：误判只会多一句提示，漏判才会让「要自拍没图」再次查无头绪。
const IMAGE_REQUEST_RE =
    /自拍|拍照|照片|图片|拍一?张|发一?张|发图|发个图|来一?张|画一?[张幅个]|画张|配图|给我看.{0,6}(样子|脸)|看看你.{0,6}(样子|脸)|你(长|是)什么样/;

export function looksLikeImageRequest(text: string): boolean {
    const value = String(text || '').trim();
    if (!value) return false;
    return IMAGE_REQUEST_RE.test(value);
}

/** 最近一条 user 消息是不是在要图；没有 user 消息返回 false。 */
export function lastUserMessageWantsImage(messages: Array<Pick<Message, 'role' | 'content'>> | undefined): boolean {
    if (!Array.isArray(messages)) return false;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i];
        if (!m || m.role !== 'user') continue;
        const content = typeof m.content === 'string' ? m.content : '';
        return looksLikeImageRequest(content);
    }
    return false;
}
