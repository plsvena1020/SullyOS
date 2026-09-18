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
  const albumAudioId = Number(s?.AlbumAudioID || s?.albumAudioId || s?.album_audio_id || s?.Audioid || s?.audio_id || 0) || 0;
  const mixId = Number(s?.mixSongID || s?.MixSongID || s?.mixsongid || 0) || 0;
  const dur = Number(s?.Duration || s?.duration || s?.timelen || 0) || 0;
  const singerArr = (Array.isArray(s?.singerinfo) ? s.singerinfo : Array.isArray(s?.Singers) ? s.Singers : [])
    .map((x: any) => x?.name).filter(Boolean);
  const vip = s?.is_vip === 1
    || s?.trans_param?.pay_block === 1
    || (s?.pay_type && (s.pay_type.sval === 1 || s.pay_type.listen_fragment === 1))
    || Number(s?.Price ?? s?.price ?? 0) > 0; // 实测：酷狗把付费曲标 Price（晴天 Price=200）
  const rawName = s?.SongName || s?.official_songname || s?.songname || s?.name || s?.filename || '';
  return {
    id: albumAudioId || mixId || hashToId(hash),
    name: String(rawName).replace(/\.(mp3|flac|ogg|m4a|wav|ape)$/i, ''), // track/new 等接口的 name 自带 .mp3 后缀
    artists: s?.SingerName || s?.singername || s?.author_name || singerArr.join(' / ') || '',
    album: s?.AlbumName || s?.albumname || s?.album_name || s?.albuminfo?.name || '',
    albumPic: kugouCover(s?.Image || s?.image || s?.cover || s?.trans_param?.union_cover || (Array.isArray(s?.sizable_cover) ? s.sizable_cover[0] : '') || ''),
    duration: dur > 10000 ? Math.round(dur / 1000) : dur,
    fee: vip ? 1 : 0,
    source: 'kugou',
    hash,
    kugouAlbumId: String(s?.AlbumID || s?.album_id || ''),
    albumAudioId: albumAudioId || undefined,
  };
};

/** 酷狗封面模板 URL（如 trans_param.union_cover）里的 {size} 占位替换成实际尺寸 */
export const kugouCover = (url: string): string => (url || '').replace(/{size}/gi, '480');

/** 登录后把 token/userid/dfid/auth 拼成 X-Kugou-Cookie 头的值（KuGouMusicApi 的 cookie 串格式）。
 * 注意：用 ';' 无空格拼接——上游 cookieToJson 解析时不对 key 做 trim，'; ' 里的
 * 空格会让 ' userid'/' dfid' 等键带前导空格而被丢掉，导致登录态在服务端失效（2026-09-18 实测）。 */
export const composeKugouCookie = (p: { token?: string; userid?: string | number; dfid?: string; auth?: string }): string =>
  (['token', 'userid', 'dfid', 'auth'] as const)
    .map(k => (p[k] != null && p[k] !== '' ? `${k}=${p[k]}` : ''))
    .filter(Boolean)
    .join(';');

/** 从 KuGouMusicApi 响应里按多 key 兜底取值（data 内优先，顶层其次） */
export const pickKugouField = (j: any, ...keys: string[]): string => {
  for (const k of keys) {
    const v = j?.data?.[k] ?? j?.[k];
    if (v != null && v !== '') return String(v);
  }
  return '';
};
