
import React, { useState, useEffect, useRef } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { SocialPost, SocialComment, SubAccount } from '../types';
import { ContextBuilder } from '../utils/context';
import { isBlobRef } from '../utils/blobRef';
import { safeResponseJson } from '../utils/safeApi';
import { mergeSocialComments, prependUniqueSocialPosts, updateSocialPost } from '../utils/socialFeedMerge';
import { normalizeMastodonStatus, dedupeByRemoteId, toMastodonVisibility, isChineseStatus, visibleInMoments } from '../utils/momentsFeed';
import { createBindSession, loadIdentities, mcpBaseUrl, type BoundIdentity } from '../utils/mastodonOAuth';
import { callMcpTool, loadMcpServers } from '../utils/mcpClient';
import type { McpServerConfig } from '../utils/mcpClient';
import TokenImg from '../components/os/TokenImg';

const TWEMOJI_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72';
const twemojiUrl = (codepoint: string) => `${TWEMOJI_BASE}/${codepoint}.png`;

const apiErrorMessage = async (response: Response): Promise<string> => {
    let detail = '';
    try {
        const text = await response.text();
        try {
            const json = JSON.parse(text);
            detail = json?.error?.message || json?.message || json?.error || '';
        } catch {
            detail = text;
        }
    } catch { /* ignore unreadable error bodies */ }
    const compact = String(detail || '').replace(/\s+/g, ' ').trim().slice(0, 180);
    return `HTTP ${response.status}${compact ? `: ${compact}` : ''}`;
};

// Convert a twemoji codepoint string (eg "1f388", "1f3d6-fe0f") to the actual emoji character.
// Falls back to the input if conversion fails, or to ✨ if input itself looks broken.
const codepointToEmoji = (code: string): string => {
    if (!code) return '✨';
    // If it already contains non-hex (likely already a real emoji char), return as-is.
    if (!/^[0-9a-fA-F-]+$/.test(code)) return code;
    try {
        const points = code.split('-').map(c => parseInt(c, 16)).filter(n => Number.isFinite(n));
        if (points.length === 0) return '✨';
        return String.fromCodePoint(...points);
    } catch {
        return '✨';
    }
};

const STICKER_OPTIONS = [
    { code: '2728', label: 'sparkles' },
    { code: '1f388', label: 'balloon' },
    { code: '1f3a8', label: 'palette' },
    { code: '1f4f7', label: 'camera' },
    { code: '1f3b5', label: 'music' },
    { code: '1f3ae', label: 'game' },
    { code: '1f354', label: 'burger' },
    { code: '1f3d6-fe0f', label: 'beach' },
    { code: '1f4a4', label: 'sleep' },
    { code: '1f4a1', label: 'idea' },
];

// --- Constants & Styles ---
const BRAND_COLOR = '#07c160'; // 微信绿

const getRandomStyle = () => undefined;

// --- Robust JSON Parser ---
const safeParseJSON = (input: string) => {
    const clean = input.replace(/```json/g, '').replace(/```/g, '').trim();
    try {
        const parsed = JSON.parse(clean);
        if (!Array.isArray(parsed) && typeof parsed === 'object' && parsed !== null) {
            const keys = Object.keys(parsed);
            if (keys.length === 1 && Array.isArray(parsed[keys[0]])) {
                return parsed[keys[0]];
            }
        }
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        try {
            const start = clean.indexOf('[');
            if (start === -1) return [];
            let end = clean.lastIndexOf('}');
            while (end > start) {
                const attempt = clean.substring(start, end + 1) + ']';
                try {
                    const result = JSON.parse(attempt);
                    if (Array.isArray(result)) return result;
                } catch (err) {}
                end = clean.lastIndexOf('}', end - 1);
            }
            return [];
        } catch (e2) {
            return [];
        }
    }
};

// --- Icons ---

const Icons = {
    Heart: ({ filled, onClick, className }: { filled?: boolean, onClick?: (e: any) => void, className?: string }) => (
        <svg onClick={onClick} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill={filled ? BRAND_COLOR : "none"} stroke={filled ? BRAND_COLOR : "currentColor"} strokeWidth={2} className={`transition-transform active:scale-75 cursor-pointer ${className || "w-6 h-6"}`}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z" />
        </svg>
    ),
    ChatBubble: ({ className }: { className?: string }) => (
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className={className || "w-6 h-6"}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 20.25c4.97 0 9-3.694 9-8.25s-4.03-8.25-9-8.25S3 7.444 3 12c0 2.104.859 4.023 2.273 5.48.432.447.74 1.04.586 1.641a4.483 4.483 0 0 1-.923 1.785A5.969 5.969 0 0 0 6 21c1.282 0 2.47-.402 3.445-1.087.81.22 1.668.337 2.555.337Z" />
        </svg>
    ),
    Back: ({ onClick, className }: { onClick?: () => void, className?: string }) => (
        <svg onClick={onClick} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className={className || "w-6 h-6 cursor-pointer text-slate-800"}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
        </svg>
    ),
    Plus: ({ className }: { className?: string }) => (
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className={className || "w-6 h-6"}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
        </svg>
    ),
};

// 空态（查手机 EmptyState 同款结构，浅色主题适配）
const EmptyState: React.FC<{ text: string }> = ({ text }) => (
    <div className="flex flex-col items-center justify-center py-16 text-slate-300 gap-2">
        <span className="text-4xl">🍃</span>
        <span className="text-xs">{text}</span>
    </div>
);

// --- Main App ---

const MomentsApp: React.FC = () => {
    const { closeApp, characters, apiConfig, addToast, userProfile } = useOS();
    const [feed, setFeed] = useState<SocialPost[]>([]);
    // 双 tab：熟人（我 + 角色 + home 时间线）| 发现（公开流，只留中文）
    const [activeTab, setActiveTab] = useState<'known' | 'discover'>('known');
    const [isCreateOpen, setIsCreateOpen] = useState(false);

    const [selectedPost, setSelectedPost] = useState<SocialPost | null>(null);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [loadingComments, setLoadingComments] = useState(false);

    // Post Creation State
    const [newPostTitle, setNewPostTitle] = useState('');
    const [newPostContent, setNewPostContent] = useState('');
    const [newPostEmoji, setNewPostEmoji] = useState('2728');
    // 发帖身份：'user'（我）或 charId（某角色）；可见性默认私密
    const [selectedIdentity, setSelectedIdentity] = useState<string>('user');
    const [identities, setIdentities] = useState<BoundIdentity[]>([]);

    // 已绑身份：挂载读一次 + 绑定成功事件刷新（PhoneShell 回调里 saveIdentity 后派发）
    useEffect(() => {
        loadIdentities(localStorage).then(setIdentities).catch(() => {});
        const onChange = () => { loadIdentities(localStorage).then(setIdentities).catch(() => {}); };
        window.addEventListener('mastodon-identities-changed', onChange);
        return () => window.removeEventListener('mastodon-identities-changed', onChange);
    }, []);
    const [newPostVisibility, setNewPostVisibility] = useState<'public' | 'private' | 'direct'>('private');

    // Comment Input State
    const [commentInput, setCommentInput] = useState('');
    const [isReplyingToUser, setIsReplyingToUser] = useState(false);

    // 角色马甲（评论生成用；默认每人一个主账号，无管理 UI）
    const [characterHandles, setCharacterHandles] = useState<Record<string, SubAccount[]>>({});

    // 本人资料直接取全局 userProfile（朋友圈不另维护一套）
    const socialProfile = { name: userProfile.name, avatar: userProfile.avatar, bio: userProfile.bio };
    // 本人头像：按角色区分（perCharAvatars[charId] 优先，整体头像兜底）
    const myAvatarFor = (charId?: string) =>
        (charId ? (userProfile.perCharAvatars?.[charId] || userProfile.avatar) : userProfile.avatar);

    // Refs
    const commentsEndRef = useRef<HTMLDivElement>(null);
    const detailScrollRef = useRef<HTMLDivElement>(null);
    const prevCommentCountRef = useRef(0); // Track comment count to prevent initial jump
    const feedRef = useRef<SocialPost[]>([]);
    const mountedRef = useRef(true);
    const refreshRequestRef = useRef<AbortController | null>(null);
    const commentRequestRef = useRef<{ postId: string; controller: AbortController } | null>(null);
    const replyRequestRef = useRef<{ postId: string; controller: AbortController } | null>(null);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            refreshRequestRef.current?.abort();
            commentRequestRef.current?.controller.abort();
            replyRequestRef.current?.controller.abort();
            refreshRequestRef.current = null;
            commentRequestRef.current = null;
            replyRequestRef.current = null;
        };
    }, []);

    useEffect(() => {
        DB.getSocialPosts().then(posts => {
            if (posts.length > 0) {
                const sorted = posts.sort((a,b) => b.timestamp - a.timestamp);
                // IndexedDB can be slow on mobile. If the user already created
                // something while this read was pending, keep that live version.
                const liveIds = new Set(feedRef.current.map(post => post.id));
                const next = [...feedRef.current, ...sorted.filter(post => !liveIds.has(post.id) && visibleInMoments(post))];
                feedRef.current = next;
                setFeed(next);
            }
        });

        // Load Handles
        const savedHandles = localStorage.getItem('spark_char_handles');
        let initialHandles: Record<string, SubAccount[]> = {};
        if (savedHandles) {
            try { initialHandles = JSON.parse(savedHandles); } catch(e) {}
        }

        // Ensure every character has at least one default handle
        characters.forEach(c => {
            if (!initialHandles[c.id] || initialHandles[c.id].length === 0) {
                initialHandles[c.id] = [{
                    id: 'default',
                    handle: c.socialProfile?.handle || c.name,
                    note: '主账号'
                }];
            }
        });
        setCharacterHandles(initialHandles);

    }, [characters.length]);

    // Save Handles to LocalStorage whenever updated
    useEffect(() => {
        if (Object.keys(characterHandles).length > 0) {
            localStorage.setItem('spark_char_handles', JSON.stringify(characterHandles));
        }
    }, [characterHandles]);

    // FIX: Only scroll to bottom if comment count INCREASES, not on initial load
    // This prevents the "jumping" behavior when opening a post
    useEffect(() => {
        if (selectedPost) {
            const currentCount = selectedPost.comments.length;
            if (currentCount > prevCommentCountRef.current) {
                // New comment added: only scroll the internal detail panel.
                // Avoid scrollIntoView(), which can scroll outer containers and shift the whole app layout.
                const detailScroller = detailScrollRef.current;
                if (detailScroller) {
                    detailScroller.scrollTo({
                        top: detailScroller.scrollHeight,
                        behavior: 'smooth'
                    });
                }
            }
            prevCommentCountRef.current = currentCount;
        } else {
            prevCommentCountRef.current = 0; // Reset
        }
    }, [selectedPost?.comments.length]);

    const prependPostsToFeed = (newPosts: SocialPost[]) => {
        const next = prependUniqueSocialPosts(feedRef.current, newPosts);
        feedRef.current = next;
        setFeed(next);
        // Only persist the new batch. Re-saving the request's stale feed snapshot
        // could erase comments or user posts that arrived while it was running.
        Promise.all(newPosts.map(p => DB.saveSocialPost(p))).catch(console.error);
    };

    const updatePostInFeed = (postId: string, updater: (post: SocialPost) => SocialPost): SocialPost | undefined => {
        const result = updateSocialPost(feedRef.current, postId, updater);
        if (!result.post) return undefined;
        feedRef.current = result.feed;
        setFeed(result.feed);
        setSelectedPost(current => (current?.id === postId ? result.post! : current));
        DB.saveSocialPost(result.post).catch(console.error);
        return result.post;
    };

    const removePostFromFeed = (postId: string) => {
        const next = feedRef.current.filter(p => p.id !== postId);
        feedRef.current = next;
        setFeed(next);
        DB.deleteSocialPost(postId);
        setSelectedPost(current => (current?.id === postId ? null : current));
    };

    // --- Mastodon 同步（读回链 + 发出链） ---

    const findMomentsServer = (): McpServerConfig | null => {
        try {
            const servers = loadMcpServers();
            const candidates = servers.filter(s =>
                (s.tools || []).some(t => t.name === 'moments_post' || t.name === 'timeline_home' || t.name === 'timeline_public'));
            return candidates.find(s => s.enabled) || candidates[0] || null;
        } catch { return null; }
    };

    const hostOf = (url?: string | null): string => {
        if (!url) return '';
        try { return new URL(url).hostname; } catch { return ''; }
    };

    // MCP 返回形态不固定（data / rawText / content 文本块），尽量宽地抽出 status 数组
    const extractStatuses = (payload: any): any[] => {
        if (!payload) return [];
        if (Array.isArray(payload)) return payload;
        if (Array.isArray(payload?.statuses)) return payload.statuses;
        if (Array.isArray(payload?.result)) return payload.result;
        if (Array.isArray(payload?.content)) {
            for (const block of payload.content) {
                const text = typeof block === 'string' ? block : block?.text;
                if (typeof text !== 'string') continue;
                try {
                    const parsed = JSON.parse(text);
                    if (Array.isArray(parsed)) return parsed;
                    if (Array.isArray(parsed?.statuses)) return parsed.statuses;
                } catch { /* 不是 JSON 就跳过 */ }
            }
        }
        if (typeof payload === 'string') {
            try {
                const parsed = JSON.parse(payload);
                if (Array.isArray(parsed)) return parsed;
                if (Array.isArray(parsed?.statuses)) return parsed.statuses;
            } catch { /* ignore */ }
        }
        return [];
    };

    const statusToPost = (s: any, instanceFallback: string, ownerId: string, tagDiscover: boolean): SocialPost | null => {
        if (!s || s.id == null) return null;
        const instance = hostOf(s.url) || instanceFallback;
        const post = normalizeMastodonStatus({
            id: String(s.id),
            url: s.url ?? null,
            content: typeof s.content === 'string' ? s.content : (s.text ?? ''),
            visibility: typeof s.visibility === 'string' ? s.visibility : 'private',
            created_at: typeof s.created_at === 'string' ? s.created_at : new Date().toISOString(),
            in_reply_to_id: s.in_reply_to_id ?? null,
            media_attachments: Array.isArray(s.media_attachments) ? s.media_attachments : [],
        }, instance, ownerId);
        const acct = s.account || {};
        if (acct.display_name || acct.username) post.authorName = acct.display_name || acct.username;
        if (acct.avatar) post.authorAvatar = acct.avatar;
        if (s.url) post.sourceUrl = s.url;
        if (tagDiscover) post.tags = [...(post.tags || []), '发现'];
        return post;
    };

    // 熟人：timeline_home；发现：timeline_public（只留中文）
    const handleSync = async (kind: 'home' | 'public') => {
        if (refreshRequestRef.current) return;
        const controller = new AbortController();
        refreshRequestRef.current = controller;
        setIsRefreshing(true);
        try {
            const server = findMomentsServer();
            if (!server) {
                addToast('还没接 Mastodon，先看本地', 'info');
                return;
            }
            const tool = kind === 'home' ? 'timeline_home' : 'timeline_public';
            const res = await callMcpTool(server, tool, kind === 'home' ? { ownerId: selectedIdentity, limit: 20 } : { limit: 20 });
            if (controller.signal.aborted) return;
            if (!res.success) throw new Error(res.error || '同步失败');
            const raw = extractStatuses(res.data ?? res.rawText);
            const ownerId = kind === 'home' ? 'user' : 'public';
            const normalized: SocialPost[] = [];
            for (const s of raw) {
                const post = statusToPost(s, server.name || 'mastodon', ownerId, kind === 'public');
                if (!post) continue;
                if (!isChineseStatus({ language: s.language ?? null, text: post.content })) continue;
                normalized.push(post);
            }
            if (controller.signal.aborted) return;
            const fresh = dedupeByRemoteId(feedRef.current, normalized);
            if (fresh.length > 0) {
                prependPostsToFeed(fresh);
                addToast(kind === 'home' ? `熟人圈更新 ${fresh.length} 条` : `发现 ${fresh.length} 条中文帖`, 'success');
            } else {
                addToast('没有新动态', 'info');
            }
        } catch (e: any) {
            if (e?.name !== 'AbortError' && mountedRef.current) addToast('同步失败: ' + (e?.message || e), 'error');
        } finally {
            if (refreshRequestRef.current === controller) {
                refreshRequestRef.current = null;
                if (mountedRef.current) setIsRefreshing(false);
            }
        }
    };

    // 发帖回执解析：{id,url} 或 {status:{...}} 都接住
    const parsePostedStatus = (payload: any): { id?: string; url?: string; instance?: string } => {
        if (!payload) return {};
        const obj = payload?.status && typeof payload.status === 'object' ? payload.status : payload;
        if (typeof obj === 'string') {
            try { return parsePostedStatus(JSON.parse(obj)); } catch { return {}; }
        }
        if (obj && typeof obj === 'object' && obj.id != null) {
            const url = typeof obj.url === 'string' ? obj.url : undefined;
            return { id: String(obj.id), url, instance: hostOf(url) || undefined };
        }
        return {};
    };

    const publishToMastodon = async (post: SocialPost, charId: string | undefined, localVisibility: string) => {
        try {
            const server = findMomentsServer();
            if (!server) return; // 没接服务器就只留本地
            const text = post.title && post.title !== '无标题' ? `${post.title}\n${post.content}` : post.content;
            const res = await callMcpTool(server, 'moments_post', {
                ownerId: charId || 'user',
                status: text,
                visibility: toMastodonVisibility(localVisibility),
                confirm: true,
            });
            if (!mountedRef.current) return;
            if (!res.success) { addToast(`同步到 Mastodon 失败：${res.error || '未知错误'}`, 'error'); return; }
            const remote = parsePostedStatus(res.data ?? res.rawText);
            if (remote.id) {
                updatePostInFeed(post.id, current => ({
                    ...current,
                    origin: 'mastodon',
                    mastodonStatusId: remote.id,
                    mastodonInstance: remote.instance || current.mastodonInstance,
                    mastodonOwnerId: charId || 'user',
                    ...(remote.url ? { sourceUrl: remote.url } : {}),
                }));
            }
        } catch (e: any) {
            if (mountedRef.current) addToast(`同步到 Mastodon 失败：${e?.message || e}`, 'error');
        }
    };

    // 一键绑定发起：注册应用 → 存 pending → 跳授权页。回调由 PhoneShell effect 接住换 token + 落盘。
    const handleBind = async () => {
        try {
            const raw = window.prompt('输入 Mastodon 实例域名（如 mastodon.social）');
            if (!raw) return;
            const server = findMomentsServer();
            if (!server?.token) {
                addToast('先在设置 → MCP 添加 Mastodon 服务器（地址见用户文档第八节）', 'info');
                return;
            }
            const { authorizeUrl, pending } = await createBindSession({
                instance: raw,
                ownerId: selectedIdentity,
                mcpBase: mcpBaseUrl(server),
                mcpToken: server.token,
                redirectUri: `${window.location.origin}/`,
            });
            sessionStorage.setItem('mastodon-oauth-pending', JSON.stringify(pending));
            window.location.href = authorizeUrl;
        } catch (e: any) { addToast(String(e?.message ?? e), 'error'); }
    };

    const generateComments = async (post: SocialPost) => {
        if (!post || !apiConfig.apiKey) return;
        const livePost = feedRef.current.find(item => item.id === post.id) || post;
        if (livePost.comments.length > 0) return;
        if (commentRequestRef.current?.postId === post.id) return;
        commentRequestRef.current?.controller.abort();
        const controller = new AbortController();
        commentRequestRef.current = { postId: post.id, controller };
        post = livePost;
        setLoadingComments(true);
        try {
            const shuffledChars = [...characters].sort(() => 0.5 - Math.random());
            const selectedChars = shuffledChars.slice(0, 2);

            let identityMap = "";
            for (const char of selectedChars) {
                const handles = characterHandles[char.id] || [];
                const hList = handles.map(h => `"${h.handle}" (${h.note})`).join(', ');
                identityMap += `- 角色 ${char.name} 可用身份: ${hList}\n`;
            }

            let contextPrompt = "";
            for (const char of selectedChars) {
                contextPrompt += `\n<<< 评论者角色: ${char.name} >>>\n${ContextBuilder.buildCoreContext(char, userProfile, false)}\n`;
            }

            let authorType = "Stranger";
            if (post.authorType === 'user') authorType = "User";
            else if (post.authorType === 'character' && post.authorCharId) {
                const c = characters.find(ch => ch.id === post.authorCharId);
                if (c) authorType = `Character "${c.name}"`;
            } else if (!post.authorType) {
                // Legacy fallback for posts saved before authorType was tracked.
                if (post.authorName === socialProfile.name) authorType = "User";
                else {
                    const c = characters.find(ch => {
                        const handles = characterHandles[ch.id] || [];
                        return handles.some(h => h.handle === post.authorName);
                    });
                    if (c) authorType = `Character "${c.name}"`;
                }
            }

            const prompt = `### 任务: 模拟社交APP评论区
**帖子来源**: 朋友圈
**楼主**: "${post.authorName}" (${authorType})
**帖子标题**: "${post.title}"
**帖子正文**:
"""
${post.content || '(楼主没写正文)'}
"""

请基于上面的【标题 + 正文】生成 4-6 条评论，评论要切实回应正文里提到的内容，不要只对着标题空泛地说。混合使用 **选定角色** 和 **随机路人**。
角色评论时，请选择一个符合语境的马甲身份。

### 角色身份库
${identityMap}

### 禁令
- **绝对禁止** 生成 \`author\` 等于或近似 "${socialProfile.name}" (用户) 的评论。
- 路人评论的 \`author\` 必须是全新的网名，绝对不能与上方【角色身份库】中列出的任何马甲网名重合。

### 输入上下文
${contextPrompt}

### 输出格式 (JSON Array)
[
  { "author": "网名 (Handle) 或 路人昵称", "content": "评论内容..." }
]`;
            const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                body: JSON.stringify({ model: apiConfig.model, messages: [{ role: "user", content: prompt }], temperature: 0.8 }),
                signal: controller.signal,
                __sullyMeta: { appId: 'moments', appName: '朋友圈', purpose: '生成帖子评论' },
            } as RequestInit);
            if (!response.ok) throw new Error(await apiErrorMessage(response));
            const data = await safeResponseJson(response);
            if (controller.signal.aborted) return;
            const json = safeParseJSON(data.choices[0].message.content);
            if (Array.isArray(json)) {
                const comments: SocialComment[] = json
                    .filter((c: any) => {
                        const name = (c?.author || c?.authorName || '').toString().trim();
                        // Drop any AI comment that tries to impersonate the user.
                        return name && name !== socialProfile.name;
                    })
                    .map((c: any) => {
                        const authorName = c.author || c.authorName || 'Unknown';
                        let avatar = `https://api.dicebear.com/7.x/notionists/svg?seed=${authorName}`;

                        // Check if char (match by handle)
                        const char = characters.find(ch => {
                            const handles = characterHandles[ch.id] || [];
                            return handles.some(h => h.handle === authorName);
                        });

                        if (char) avatar = char.avatar;
                        return {
                            id: `cmt-${Math.random()}`,
                            authorName: authorName,
                            authorAvatar: avatar,
                            content: c.content || '...',
                            likes: Math.floor(Math.random() * 100),
                            isCharacter: !!char,
                            authorType: char ? 'character' : 'stranger',
                            authorCharId: char?.id,
                        } as SocialComment;
                    });
                updatePostInFeed(post.id, current => ({
                    ...current,
                    comments: mergeSocialComments(current.comments || [], comments),
                }));
            }
        } catch (e: any) {
            if (e?.name !== 'AbortError') addToast(`评论加载失败: ${e?.message || e}`, 'error');
        } finally {
            if (commentRequestRef.current?.controller === controller) {
                commentRequestRef.current = null;
                if (mountedRef.current) setLoadingComments(false);
            }
        }
    };

    const generateRepliesToUser = async (post: SocialPost, userContent: string) => {
        if (!apiConfig.apiKey) return;
        if (replyRequestRef.current) return;
        const controller = new AbortController();
        replyRequestRef.current = { postId: post.id, controller };
        post = feedRef.current.find(item => item.id === post.id) || post;
        setIsReplyingToUser(true);
        try {
            // Simplified handle map for replies
            let identityMap = "";
            characters.forEach(char => {
                const handles = characterHandles[char.id] || [];
                const hList = handles.map(h => `"${h.handle}"`).join(', ');
                identityMap += `- ${char.name}: ${hList}\n`;
            });

            // Tell the model who actually wrote the post — if it's the user themselves, replies
            // need to make sense as people responding to the user's own note (not strangers).
            let postAuthorInfo = `"${post.authorName}"`;
            if (post.authorType === 'user') postAuthorInfo += ' (用户本人)';
            else if (post.authorType === 'character' && post.authorCharId) {
                const c = characters.find(ch => ch.id === post.authorCharId);
                if (c) postAuthorInfo += ` (角色 ${c.name} 的马甲)`;
            } else if (post.authorName === socialProfile.name) {
                postAuthorInfo += ' (用户本人)';
            }

            const prompt = `### 任务: 回复用户的评论
**帖子楼主**: ${postAuthorInfo}
**帖子标题**: "${post.title}"
**帖子正文**:
"""
${post.content || '(楼主没写正文)'}
"""
**用户 "${socialProfile.name}" 刚在帖子下发的评论**: "${userContent}"

请基于楼主帖子的【标题 + 正文】+ 用户的评论上下文，生成 1-3 条对用户这条评论的回复，要扣题，不能脱离正文凭空发挥。
${identityMap}

### 禁令
- **绝对禁止** \`author\` 等于或近似 "${socialProfile.name}" (用户自己)。回复必须来自其他人。

### 输出格式 (JSON Array)
[
  { "author": "网名 (Handle)", "content": "回复内容..." }
]`;
            const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                body: JSON.stringify({ model: apiConfig.model, messages: [{ role: "user", content: prompt }], temperature: 0.9 }),
                signal: controller.signal,
                __sullyMeta: { appId: 'moments', appName: '朋友圈', purpose: '回复用户评论' },
            } as RequestInit);
            if (!response.ok) throw new Error(await apiErrorMessage(response));
            const data = await safeResponseJson(response);
            if (controller.signal.aborted) return;
            const json = safeParseJSON(data.choices[0].message.content);
            if (Array.isArray(json)) {
                const newReplies: SocialComment[] = json
                    .filter((c: any) => {
                        const name = (c?.author || c?.authorName || '').toString().trim();
                        return name && name !== socialProfile.name;
                    })
                    .map((c: any) => {
                        const authorName = c.author || c.authorName || 'Unknown';
                        let avatar = `https://api.dicebear.com/7.x/notionists/svg?seed=${authorName}`;

                        const char = characters.find(ch => {
                            const handles = characterHandles[ch.id] || [];
                            return handles.some(h => h.handle === authorName);
                        });

                        if (char) avatar = char.avatar;
                        return {
                            id: `cmt-reply-${Date.now()}-${Math.random()}`,
                            authorName: authorName,
                            authorAvatar: avatar,
                            content: `回复 @${socialProfile.name}: ${c.content}`,
                            likes: Math.floor(Math.random() * 10),
                            isCharacter: !!char,
                            authorType: char ? 'character' : 'stranger',
                            authorCharId: char?.id,
                        } as SocialComment;
                    });
                if (newReplies.length > 0) {
                    updatePostInFeed(post.id, current => ({
                        ...current,
                        comments: mergeSocialComments(current.comments || [], newReplies),
                    }));
                    addToast(`收到 ${newReplies.length} 条新回复`, 'info');
                }
            }
        } catch (e: any) {
            if (e?.name !== 'AbortError') addToast(`回复生成失败: ${e?.message || e}`, 'error');
        } finally {
            if (replyRequestRef.current?.controller === controller) {
                replyRequestRef.current = null;
                if (mountedRef.current) setIsReplyingToUser(false);
            }
        }
    };

    const handleCreatePost = () => {
        if (!newPostContent.trim()) return;
        const char = selectedIdentity !== 'user'
            ? characters.find(c => c.id === selectedIdentity)
            : undefined;
        const post: SocialPost = {
            id: `user-post-${Date.now()}`,
            authorName: char ? char.name : socialProfile.name, // Use Selected Identity
            authorAvatar: char ? char.avatar : myAvatarFor(),
            title: newPostTitle || '无标题',
            content: newPostContent,
            // Sticker selector stores twemoji codepoints (eg "2728"); convert to the real emoji char
            // so that the feed/detail views render an emoji instead of the raw codepoint text.
            images: [codepointToEmoji(newPostEmoji)],
            likes: 0,
            isCollected: false,
            isLiked: false,
            comments: [],
            timestamp: Date.now(),
            tags: ['朋友圈'],
            bgStyle: getRandomStyle(),
            authorType: 'user',
            ...(char ? { authorCharId: char.id } : {}),
            origin: 'moments',
        };
        prependPostsToFeed([post]);
        void publishToMastodon(post, char?.id, newPostVisibility);
        setNewPostContent(''); setNewPostTitle('');
        setIsCreateOpen(false); // Close Modal
        setActiveTab('known');
        addToast('发布成功', 'success');
    };

    const handleDeletePost = (postId: string) => {
        removePostFromFeed(postId); addToast('帖子已删除', 'success');
    };
    const handleLike = (e: any, post: SocialPost) => {
        e.stopPropagation();
        updatePostInFeed(post.id, current => ({
            ...current,
            isLiked: !current.isLiked,
            likes: current.isLiked ? current.likes - 1 : current.likes + 1,
        }));
    };

    const handleSendComment = async () => {
        if (!selectedPost || !commentInput.trim()) return;
        if (commentRequestRef.current?.postId === selectedPost.id || replyRequestRef.current) return;

        const userComment: SocialComment = {
                id: `cmt-user-${Date.now()}`,
                authorName: socialProfile.name, // Use Local Identity
                authorAvatar: myAvatarFor(selectedPost.authorCharId),
                content: commentInput.trim(),
                likes: 0,
                isCharacter: false,
                authorType: 'user' as const,
        };
        const updatedPost = updatePostInFeed(selectedPost.id, current => ({
            ...current,
            comments: mergeSocialComments(current.comments || [], [userComment]),
        }));
        if (!updatedPost) return;
        const contentToSend = commentInput;
        setCommentInput('');
        await generateRepliesToUser(updatedPost, contentToSend);
    };

    const handleOpenPost = (post: SocialPost) => {
        const livePost = feedRef.current.find(item => item.id === post.id) || post;
        setSelectedPost(livePost);
        generateComments(livePost);
    };

    const handleClosePost = () => {
        commentRequestRef.current?.controller.abort();
        commentRequestRef.current = null;
        setLoadingComments(false);
        setSelectedPost(null);
    };

    // --- Renderers ---

    // 帖子配图：mastodon 远端 http 图直显（不走代理）；本地 blobref/dataURL 走 TokenImg；
    // 都没有时沿用 emoji 大字。
    const renderPostCover = (post: SocialPost, emojiClass: string, emojiWrap = 'drop-shadow-xl filter saturate-150 transform transition-transform group-hover:scale-110 duration-500') => {
        const firstImage = post.images?.[0];
        const isHttpImage = typeof firstImage === 'string' && /^https?:\/\//i.test(firstImage);
        const isLocalImage = typeof firstImage === 'string' && (isBlobRef(firstImage) || /^data:image\//i.test(firstImage));
        const isRealImage = (post.origin === 'mastodon' && isHttpImage) || isLocalImage;
        if (isRealImage && typeof firstImage === 'string') {
            return (
                <>
                    <div className="absolute inset-0 flex items-center justify-center"><span className={emojiClass}>✨</span></div>
                    {post.origin === 'mastodon' && isHttpImage ? (
                        <img
                            src={firstImage}
                            alt={post.title}
                            loading="lazy"
                            className="absolute inset-0 w-full h-full object-cover z-10"
                            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                        />
                    ) : (
                        <TokenImg
                            value={firstImage}
                            alt={post.title}
                            loading="lazy"
                            className="absolute inset-0 w-full h-full object-cover z-10"
                            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                        />
                    )}
                </>
            );
        }
        return <div className={`relative z-10 ${emojiClass} ${emojiWrap}`}>{codepointToEmoji(firstImage)}</div>;
    };

    const fmtTime = (ts: number) => {
        const d = new Date(ts);
        const now = Date.now();
        const diffMin = Math.floor((now - ts) / 60000);
        if (diffMin < 1) return '刚刚';
        if (diffMin < 60) return `${diffMin} 分钟前`;
        if (diffMin < 60 * 24) return `${Math.floor(diffMin / 60)} 小时前`;
        return `${d.getMonth() + 1}月${d.getDate()}日`;
    };

    const isMine = (post: SocialPost) =>
        post.authorType === 'user' || (!post.authorType && post.authorName === socialProfile.name);

    const sortedFeed = [...feed].sort((a, b) => b.timestamp - a.timestamp);
    const knownPosts = sortedFeed.filter(p => !(p.tags || []).includes('发现'));
    const discoverPosts = sortedFeed.filter(p => (p.tags || []).includes('发现'));
    const visiblePosts = activeTab === 'known' ? knownPosts : discoverPosts;

    // 1. Feed Item（微信式单列行）
    const renderFeedItem = (post: SocialPost) => (
        <div key={post.id} onClick={() => handleOpenPost(post)} className="bg-white px-4 py-3 flex gap-3 border-b border-slate-100 cursor-pointer active:bg-slate-50 group relative">
            <TokenImg value={post.authorAvatar} className="w-10 h-10 rounded-md object-cover shrink-0 bg-slate-100" />
            <div className="flex-1 min-w-0">
                <div className="text-[14px] font-medium text-[#576b95] truncate">{post.authorName}</div>
                {post.title && post.title !== '无标题' && (
                    <div className="text-[14px] font-medium text-slate-800 mt-0.5 leading-snug">{post.title}</div>
                )}
                <div className="text-[14px] text-slate-800 leading-relaxed whitespace-pre-wrap break-words mt-0.5">{post.content}</div>
                {post.images && post.images.length > 0 && post.images[0] && (
                    <div className="mt-2">
                        {post.images.length === 1 ? (
                            <div className="relative w-44 h-44 bg-slate-100 rounded-sm overflow-hidden">
                                {renderPostCover(post, 'text-5xl')}
                            </div>
                        ) : (
                            <div className="grid grid-cols-3 gap-1">
                                {post.images.slice(0, 9).map((img, i) => (
                                    <div key={i} className="relative aspect-square bg-slate-100 rounded-sm overflow-hidden">
                                        {renderPostCover({ ...post, images: [img] }, 'text-3xl')}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}
                <div className="flex items-center justify-between mt-2">
                    <span className="text-[11px] text-slate-400">{fmtTime(post.timestamp)}</span>
                    <div className="flex items-center gap-4">
                        <button
                            onClick={(e) => handleLike(e, post)}
                            className="flex items-center gap-1 text-slate-400 active:scale-90 transition"
                        >
                            <Icons.Heart filled={post.isLiked} className="w-[18px] h-[18px]" />
                            {post.likes > 0 && <span className="text-[11px]">{post.likes}</span>}
                        </button>
                        <span className="flex items-center gap-1 text-slate-400">
                            <Icons.ChatBubble className="w-[18px] h-[18px]" />
                            {post.comments.length > 0 && <span className="text-[11px]">{post.comments.length}</span>}
                        </span>
                        {isMine(post) && (
                            <button
                                onClick={(e) => { e.stopPropagation(); handleDeletePost(post.id); }}
                                className="text-[11px] text-slate-300 hover:text-red-400 px-1"
                            >
                                删除
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );

    // 2. Detail Overlay
    const renderDetail = () => {
        if (!selectedPost) return null;
        return (
            <div
                className="absolute inset-0 z-[60] h-full w-full bg-white flex flex-col"
            >
                <div className="flex-1 w-full h-full flex flex-col animate-slide-up relative overflow-hidden">
                    {/* Header —— 自理安全区：--safe-top 让开刘海（带 iOS env 偶发返回 0 的 JS 兜底；非刘海设备保底 12px） */}
                    <div className="flex items-center justify-between px-4 bg-white border-b border-slate-100 shrink-0 relative z-20" style={{ paddingTop: 'max(12px, var(--safe-top))', paddingBottom: '12px' }}>
                        <button onClick={handleClosePost} className="p-2 -m-2 active:opacity-60"><Icons.Back /></button>
                        <div className="flex items-center gap-2">
                            <TokenImg value={selectedPost.authorAvatar} className="w-8 h-8 rounded-md object-cover bg-slate-100" />
                            <span className="text-sm font-bold text-slate-800">{selectedPost.authorName}</span>
                        </div>
                        <div className="w-10" />
                    </div>

                    {/* Scrollable Area */}
                    <div ref={detailScrollRef} className="flex-1 overflow-y-auto no-scrollbar pb-24 bg-white">
                        <div className="px-4 pt-4 pb-2 flex gap-3">
                            <TokenImg value={selectedPost.authorAvatar} className="w-10 h-10 rounded-md object-cover shrink-0 bg-slate-100" />
                            <div className="flex-1 min-w-0">
                                <div className="text-[14px] font-medium text-[#576b95]">{selectedPost.authorName}</div>
                                {selectedPost.title && selectedPost.title !== '无标题' && (
                                    <h1 className="text-[15px] font-bold text-slate-900 leading-snug mt-1">{selectedPost.title}</h1>
                                )}
                                <p className="text-[14px] text-slate-800 leading-relaxed whitespace-pre-wrap mt-1">{selectedPost.content}</p>
                                {selectedPost.images && selectedPost.images.length > 0 && selectedPost.images[0] && (
                                    <div className="mt-2">
                                        {selectedPost.images.length === 1 ? (
                                            <div className="relative w-52 h-52 bg-slate-100 rounded-sm overflow-hidden">
                                                {renderPostCover(selectedPost, 'text-6xl', 'drop-shadow-2xl filter saturate-125')}
                                            </div>
                                        ) : (
                                            <div className="grid grid-cols-3 gap-1">
                                                {selectedPost.images.slice(0, 9).map((img, i) => (
                                                    <div key={i} className="relative aspect-square bg-slate-100 rounded-sm overflow-hidden">
                                                        {renderPostCover({ ...selectedPost, images: [img] }, 'text-3xl')}
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                )}
                                <div className="text-[11px] text-slate-400 mt-2">{fmtTime(selectedPost.timestamp)}</div>
                            </div>
                        </div>

                        {/* Comments Section */}
                        <div className="px-4 pb-6">
                            <div className="text-[13px] font-bold text-slate-800 mb-3 flex items-center gap-2">
                                <span>评论 {selectedPost.comments.length}</span>
                                {(loadingComments || isReplyingToUser) && <div className="w-3 h-3 border-2 border-slate-300 border-t-[#07c160] rounded-full animate-spin"></div>}
                            </div>

                            <div className="bg-[#f7f7f7] rounded-md px-3 py-2 space-y-2">
                                {selectedPost.comments.length === 0 && !loadingComments && <div className="text-center text-slate-300 text-xs py-6">快来抢沙发...</div>}
                                {selectedPost.comments.map(c => (
                                    <div key={c.id} className="flex gap-2 animate-fade-in group">
                                        <TokenImg value={c.authorAvatar} className="w-7 h-7 rounded-md object-cover shrink-0 bg-slate-200" />
                                        <div className="flex-1 min-w-0">
                                            <span className="text-[12px] font-medium text-[#576b95]">{c.authorName}</span>
                                            <p className="text-[13px] text-slate-700 mt-0.5 leading-normal">{c.content}</p>
                                        </div>
                                    </div>
                                ))}
                                <div ref={commentsEndRef} />
                            </div>
                        </div>
                    </div>

                    {/* Bottom Input Bar - Absolute to sit on top of scroll area at bottom */}
                    <div className="absolute bottom-0 w-full pb-[var(--safe-bottom,0px)] z-30 pointer-events-none">
                         <div className="pointer-events-auto h-16 bg-white border-t border-slate-100 px-4 flex items-center justify-between gap-4">
                            <div className="flex-1 bg-[#f7f7f7] rounded-md px-4 py-2.5 flex items-center gap-2 focus-within:bg-white focus-within:ring-1 focus-within:ring-[#07c160]/40 transition-all border border-transparent focus-within:border-[#07c160]/40">
                                <input
                                    value={commentInput}
                                    onChange={(e) => setCommentInput(e.target.value)}
                                    onKeyDown={(e) => e.key === 'Enter' && handleSendComment()}
                                    disabled={loadingComments || isReplyingToUser}
                                    placeholder="评论"
                                    className="bg-transparent text-sm w-full outline-none text-slate-800 placeholder:text-slate-400 disabled:opacity-50"
                                />
                                {commentInput.trim() && <button disabled={loadingComments || isReplyingToUser} onClick={handleSendComment} className="text-[#07c160] font-bold text-sm animate-fade-in disabled:opacity-40 shrink-0">发送</button>}
                            </div>
                            <div className="flex gap-4 text-slate-600 shrink-0 items-center">
                                <div className="flex flex-col items-center gap-0.5">
                                    <Icons.Heart filled={selectedPost.isLiked} onClick={(e) => handleLike(e, selectedPost)} className="w-6 h-6" />
                                    <span className="text-[10px] font-medium">{selectedPost.likes}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        );
    };

    return (
        // 微信式浅色容器
        <div className="h-full w-full bg-[#ededed] flex flex-col font-sans relative text-slate-900 overflow-hidden">

            {/* --- Create Post Overlay (Full Screen) --- */}
            {isCreateOpen && (
                <div className="absolute inset-0 z-50 bg-white flex flex-col animate-slide-up">
                    {/* Create Header —— 自理安全区：外层扛 safe-top + 背景，内层保持 h-14 内容栏（同主栏，避开 border-box 吃 padding） */}
                    <div className="sticky top-0 z-20 bg-white border-b border-slate-100" style={{ paddingTop: 'var(--safe-top)' }}>
                        <div className="h-14 flex items-center justify-between px-4">
                            <button onClick={() => setIsCreateOpen(false)} className="text-slate-600 text-sm px-2 py-1">取消</button>
                            <span className="text-sm font-bold text-slate-800">发朋友圈</span>
                            <button
                                onClick={handleCreatePost}
                                disabled={!newPostContent.trim()}
                                className={`px-4 py-1.5 rounded-md text-xs font-bold text-white transition-all ${newPostContent.trim() ? 'bg-[#07c160]' : 'bg-slate-200 text-slate-400'}`}
                            >
                                发表
                            </button>
                        </div>
                    </div>

                    {/* Create Content */}
                    <div className="flex-1 overflow-y-auto no-scrollbar p-4">
                        {/* 身份选择：我 / 某角色 */}
                        <p className="text-[10px] font-bold text-slate-400 uppercase mb-2">发帖身份</p>
                        <div className="flex gap-3 overflow-x-auto pb-3 no-scrollbar">
                            <button
                                onClick={() => setSelectedIdentity('user')}
                                className={`flex flex-col items-center gap-1 shrink-0 w-14 ${selectedIdentity === 'user' ? '' : 'opacity-60'}`}
                            >
                                <TokenImg value={myAvatarFor()} className={`w-11 h-11 rounded-md object-cover bg-slate-100 ${selectedIdentity === 'user' ? 'ring-2 ring-[#07c160]' : ''}`} />
                                <span className={`text-[10px] truncate w-full text-center ${selectedIdentity === 'user' ? 'text-[#07c160] font-bold' : 'text-slate-500'}`}>我</span>
                            </button>
                            {characters.map(c => (
                                <button
                                    key={c.id}
                                    onClick={() => setSelectedIdentity(c.id)}
                                    className={`flex flex-col items-center gap-1 shrink-0 w-14 ${selectedIdentity === c.id ? '' : 'opacity-60'}`}
                                >
                                    <TokenImg value={c.avatar} className={`w-11 h-11 rounded-md object-cover bg-slate-100 ${selectedIdentity === c.id ? 'ring-2 ring-[#07c160]' : ''}`} />
                                    <span className={`text-[10px] truncate w-full text-center ${selectedIdentity === c.id ? 'text-[#07c160] font-bold' : 'text-slate-500'}`}>{c.name}</span>
                                </button>
                            ))}
                        </div>

                        {/* 可见性：默认私密 */}
                        <p className="text-[10px] font-bold text-slate-400 uppercase mb-2 mt-1">谁可以看</p>
                        <div className="flex gap-2 pb-3">
                            {([
                                { key: 'private', label: '私密' },
                                { key: 'public', label: '公开' },
                                { key: 'direct', label: '悄悄话' },
                            ] as const).map(opt => (
                                <button
                                    key={opt.key}
                                    onClick={() => setNewPostVisibility(opt.key)}
                                    className={`px-4 py-1.5 rounded-full text-xs font-bold transition-all ${newPostVisibility === opt.key ? 'bg-[#07c160] text-white' : 'bg-slate-100 text-slate-500'}`}
                                >
                                    {opt.label}
                                </button>
                            ))}
                        </div>

                        <input
                            value={newPostTitle}
                            onChange={e => setNewPostTitle(e.target.value)}
                            placeholder="标题（可选）"
                            className="text-base font-bold placeholder:text-slate-300 placeholder:font-normal outline-none mb-2 w-full text-slate-800"
                        />
                        <textarea
                            value={newPostContent}
                            onChange={e => setNewPostContent(e.target.value)}
                            placeholder="分享你此刻的想法..."
                            className="w-full h-auto min-h-[160px] resize-none outline-none text-[15px] leading-relaxed placeholder:text-slate-300"
                        />

                        {/* Sticker Selector - Flowing after text */}
                        <div className="mt-4 pt-4 border-t border-slate-50">
                            <p className="text-[10px] font-bold text-slate-400 uppercase mb-2">添加心情贴纸 (Sticker)</p>
                            <div className="flex gap-4 overflow-x-auto pb-2 no-scrollbar">
                                {STICKER_OPTIONS.map(sticker => (
                                    <button
                                        key={sticker.code}
                                        onClick={() => setNewPostEmoji(sticker.code)}
                                        className={`w-12 h-12 rounded-xl border flex items-center justify-center transition-all shrink-0 ${newPostEmoji === sticker.code ? 'border-[#07c160] bg-green-50' : 'border-slate-100'}`}
                                    >
                                        <img src={twemojiUrl(sticker.code)} alt={sticker.label} className="w-7 h-7" />
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* --- Main View --- */}
            <div className={`flex-col h-full ${selectedPost || isCreateOpen ? 'hidden' : 'flex'}`}>

                {/* 个人页头：封面 16:9 + 昵称 + 头像 + 绑定入口占位 */}
                <div className="relative shrink-0">
                    <div className="aspect-[16/9] w-full overflow-hidden bg-gradient-to-br from-slate-700 to-slate-900 relative">
                        {userProfile.momentsCover ? (
                            <TokenImg value={userProfile.momentsCover} className="w-full h-full object-cover" />
                        ) : (
                            <div className="w-full h-full bg-gradient-to-br from-slate-600 via-slate-800 to-black" />
                        )}
                        <button
                            onClick={closeApp}
                            className="absolute top-2 left-2 px-2 py-1 text-white/90 text-sm"
                            style={{ marginTop: 'var(--safe-top)' }}
                        >
                            ‹ 返回
                        </button>
                        <button
                            onClick={handleBind}
                            className="absolute px-3 py-1.5 rounded-full bg-black/30 text-white text-[11px] font-bold backdrop-blur-md active:scale-95 transition"
                            style={{ top: 'calc(var(--safe-top) + 8px)', right: '12px' }}
                        >
                            {identities.length > 0 ? `已绑 ${identities.length} 个号` : '绑定 Mastodon'}
                        </button>
                    </div>
                    <div className="absolute bottom-0 right-0 left-0 flex items-end justify-end gap-3 px-4 translate-y-1/3">
                        <span className="text-white font-bold text-[17px] drop-shadow-md pb-4">{userProfile.name}</span>
                        <TokenImg value={myAvatarFor()} className="w-16 h-16 rounded-md object-cover bg-slate-200 ring-2 ring-white/60" />
                    </div>
                </div>

                {/* 昵称行占位（头像下半截 Terrier 悬空的补偿） */}
                <div className="h-8 shrink-0 bg-white" />
                {identities.length > 0 && (
                    <div className="px-4 py-1.5 bg-white text-[11px] text-slate-500 shrink-0">
                        已绑：{identities.map(i => `@${i.acct}`).join(' · ')}
                    </div>
                )}

                {/* 双 tab：熟人 / 发现 */}
                <div className="sticky top-0 z-30 bg-white border-b border-slate-100">
                    <div className="flex">
                        <button
                            onClick={() => setActiveTab('known')}
                            className={`flex-1 py-2.5 text-[15px] transition-colors ${activeTab === 'known' ? 'text-slate-900 font-bold border-b-2 border-[#07c160]' : 'text-slate-400'}`}
                        >
                            熟人
                        </button>
                        <button
                            onClick={() => setActiveTab('discover')}
                            className={`flex-1 py-2.5 text-[15px] transition-colors ${activeTab === 'discover' ? 'text-slate-900 font-bold border-b-2 border-[#07c160]' : 'text-slate-400'}`}
                        >
                            发现
                        </button>
                    </div>
                </div>

                {/* Content Area */}
                <div className="flex-1 overflow-y-auto no-scrollbar bg-white">
                    <div className="flex items-center justify-center py-2.5 border-b border-slate-50">
                        {isRefreshing ? (
                            <div className="text-center text-xs text-[#07c160] font-bold animate-pulse flex items-center gap-2">
                                <div className="w-4 h-4 border-2 border-[#07c160] border-t-transparent rounded-full animate-spin"></div> 正在同步...
                            </div>
                        ) : (
                            <button
                                onClick={() => void handleSync(activeTab === 'known' ? 'home' : 'public')}
                                className="text-[11px] text-slate-400 hover:text-[#07c160] active:scale-95 transition-all"
                            >
                                {activeTab === 'known' ? '同步熟人时间线' : '刷发现流'} ↓
                            </button>
                        )}
                    </div>
                    {visiblePosts.length === 0 ? (
                        <EmptyState text={activeTab === 'known' ? '还没有动态，去发一条吧' : '发现流是空的，点上面同步试试'} />
                    ) : (
                        <div className="pb-24">
                            {visiblePosts.map(post => renderFeedItem(post))}
                        </div>
                    )}
                </div>

                {/* 右下角发帖按钮 */}
                {!isCreateOpen && (
                    <button
                        onClick={() => setIsCreateOpen(true)}
                        aria-label="发朋友圈"
                        className="absolute bottom-6 right-4 w-14 h-14 bg-[#07c160] text-white rounded-full flex items-center justify-center shadow-lg active:scale-95 transition-transform z-40"
                    >
                        <Icons.Plus className="w-7 h-7" />
                    </button>
                )}
            </div>

            {selectedPost && renderDetail()}
        </div>
    );
};

export default MomentsApp;
