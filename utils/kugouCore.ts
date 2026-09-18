/**
 * 酷狗概念版来源的纯函数层：搜索结果映射、hash→id、音质映射、登录态拼装。
 * 消费方：context/MusicContext.tsx（kugouApi）、apps/MusicApp.tsx、apps/music/Kugou*。
 * KuGouMusicApi 不同接口的响应字段大小写形态不一（FileHash/fileHash 等），key 全部枚举兜底；
 * 真实形态按本地探针（docs/superpowers/plans/2026-09-08-kugou-music-source.md 附录）钉住。
 */
import type { MusicQuality, Song } from '../context/MusicContext';

export type KugouQuality = '128' | '320' | 'flac' | 'high';

/** 现有 5 档音质 → 酷狗 quality 参数（/song/url/auth/merge 支持 128/320/flac/high） */
export const kugouQuality = (q: MusicQuality): KugouQuality =>
  q === 'standard' ? '128' : q === 'lossless' ? 'flac' : q === 'hires' ? 'high' : '320';

/** hash 是 32 位 hex；取前 12 位转数作兜底 id（仅用于没有 albumAudioId/mixSongID 的数据） */
export const hashToId = (hash: string): number => {
  const n = parseInt((hash || '').replace(/[^0-9a-fA-F]/g, '').slice(0, 12), 16);
  return Number.isFinite(n) ? n : 0;
};

/**
 * /search 单曲列表项 → Song。
 * id：albumAudioId 优先，其次 mixSongID，最后 hash 兜底。
 * duration：主形态为秒；个别接口给毫秒（>10000 视为毫秒折算）。
 * fee：1 = VIP/付费角标（与网易 fee===1 的 UI 语义对齐）。
 */
export const mapKugouSearchItem = (s: any): Song => {
  const hash: string = s?.FileHash || s?.fileHash || s?.hash || '';
  const albumAudioId = Number(s?.AlbumAudioID || s?.albumAudioId || s?.album_audio_id || 0) || 0;
  const mixId = Number(s?.mixSongID || s?.mixsongid || s?.MixSongID || 0) || 0;
  const dur = Number(s?.Duration || s?.duration || 0) || 0;
  const vip = s?.is_vip === 1
    || s?.trans_param?.pay_block === 1
    || (s?.pay_type && (s.pay_type.sval === 1 || s.pay_type.listen_fragment === 1));
  return {
    id: albumAudioId || mixId || hashToId(hash),
    name: s?.SongName || s?.name || s?.filename || '',
    artists: s?.SingerName || s?.singername || s?.author_name || '',
    album: s?.AlbumName || s?.albumname || s?.album_name || '',
    albumPic: s?.Image || s?.image || (Array.isArray(s?.sizable_cover) ? s.sizable_cover[0] : '') || '',
    duration: dur > 10000 ? Math.round(dur / 1000) : dur,
    fee: vip ? 1 : 0,
    source: 'kugou',
    hash,
    kugouAlbumId: String(s?.AlbumID || s?.album_id || ''),
    albumAudioId: albumAudioId || undefined,
  };
};

/** 登录后把 token/userid/dfid/auth 拼成 X-Kugou-Cookie 头的值（KuGouMusicApi 的 cookie 串格式） */
export const composeKugouCookie = (p: { token?: string; userid?: string | number; dfid?: string; auth?: string }): string =>
  (['token', 'userid', 'dfid', 'auth'] as const)
    .map(k => (p[k] != null && p[k] !== '' ? `${k}=${p[k]}` : ''))
    .filter(Boolean)
    .join('; ');

/** 从 KuGouMusicApi 响应里按多 key 兜底取值（data 内优先，顶层其次） */
export const pickKugouField = (j: any, ...keys: string[]): string => {
  for (const k of keys) {
    const v = j?.data?.[k] ?? j?.[k];
    if (v != null && v !== '') return String(v);
  }
  return '';
};
