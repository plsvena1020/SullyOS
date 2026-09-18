/**
 * 酷狗概念版「我的」主页
 * - 未登录: KugouLoginPanel（扫码 / 手机验证码）
 * - 已登录: 用户信息 + 我喜欢(特殊歌单) + 每日推荐 + 我的歌单(展开拉曲目) + 私人FM + 最近在听
 * 响应字段用多 key 兜底（KuGouMusicApi 各接口形态不一）；首次真机登录后按实际响应校准
 * mapKugouPlaylistItem / pickSongArray（见 CALIBRATE 注释）。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useOS } from '../../context/OSContext';
import { useMusic, kugouApi, toHttps, Song } from '../../context/MusicContext';
import { mapKugouSearchItem } from '../../utils/kugouCore';
import {
  C, Sparkle, MizuHeader, BokehBg, MiniPlayer, SongRow,
} from './MusicUI';
import { MagnifyingGlass, Gear } from '@phosphor-icons/react';
import KugouLoginPanel from './KugouLoginPanel';

interface Props {
  onBack: () => void;
  onOpenPlayer: () => void;
  onOpenSearch?: () => void;
  onOpenSettings?: () => void;
  onVisitChar?: (charId: string) => void;
}

interface KugouPlaylist {
  listid: string;
  name: string;
  pic: string;
  count: number;
}

/** CALIBRATE: /user/playlist 列表项 → KugouPlaylist（首次真机登录后按实际响应校准 key） */
const mapKugouPlaylistItem = (it: any): KugouPlaylist => ({
  listid: String(it?.listid || it?.id || it?.global_collection_id || ''),
  name: it?.name || it?.specialname || '',
  pic: it?.pic || it?.picurl || it?.imgurl || it?.img || '',
  count: Number(it?.count || it?.trackcount || it?.sourcecount || 0),
});

/** CALIBRATE: 各列表端点的歌曲数组取数（info/lists/songs/data 逐一兜底） */
const pickSongArray = (r: any): any[] =>
  r?.data?.info || r?.data?.lists || r?.data?.songs || (Array.isArray(r?.data) ? r.data : []) || [];

const toSongRows = (arr: any[]): Song[] =>
  arr
    .map((it: any) => mapKugouSearchItem(it?.song || it))
    .filter((s: Song) => s.hash)
    .map((s: Song) => ({ ...s, albumPic: toHttps(s.albumPic) }));

const fmtDur = (s: number): string => {
  if (!isFinite(s) || s < 0) s = 0;
  return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
};

const KugouProfilePage: React.FC<Props> = ({ onBack, onOpenPlayer, onOpenSearch, onOpenSettings }) => {
  const { addToast } = useOS();
  const { cfg, setCfg, current, playing, playSong, togglePlay, nextSong, prevSong } = useMusic();

  const [nickname, setNickname] = useState('');
  const [avatar, setAvatar] = useState('');
  const [isVipUser, setIsVipUser] = useState(false);
  const [playlists, setPlaylists] = useState<KugouPlaylist[]>([]);
  const [likes, setLikes] = useState<KugouPlaylist | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [playlistSongs, setPlaylistSongs] = useState<Song[]>([]);
  const [everydaySongs, setEverydaySongs] = useState<Song[]>([]);
  const [recentSongs, setRecentSongs] = useState<Song[]>([]);
  const [fmSongs, setFmSongs] = useState<Song[]>([]);
  const [loadingFm, setLoadingFm] = useState(false);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!cfg.kugouCookie) return;
    setLoading(true);
    try {
      const [detail, vip, pl, everyday, recent] = await Promise.all([
        kugouApi.userDetail(cfg).catch(() => null),
        kugouApi.userVipDetail(cfg).catch(() => null),
        kugouApi.userPlaylist(cfg).catch(() => null),
        kugouApi.everydayRecommend(cfg).catch(() => null),
        kugouApi.lastestSongsListen(cfg).catch(() => null),
      ]);
      setNickname((detail && (detail.data?.nickname || detail.data?.uname || detail.data?.username)) || '酷狗用户');
      setAvatar((detail && (detail.data?.avatar || detail.data?.user_avatar || detail.data?.head)) || '');
      setIsVipUser(!!(vip && (vip.data?.is_vip === 1 || vip.data?.vip_type > 0)));
      const items: KugouPlaylist[] = (pl?.data?.data || pl?.data?.info || pl?.data?.lists || []).map(mapKugouPlaylistItem);
      const likePl = items.find(p => /我喜欢/.test(p.name)) || null;
      setLikes(likePl);
      setPlaylists(items.filter(p => p.listid && p !== likePl));
      setEverydaySongs(toSongRows(pickSongArray(everyday)));
      setRecentSongs(toSongRows(pickSongArray(recent)));
    } finally {
      setLoading(false);
    }
  }, [cfg]);

  useEffect(() => { reload(); }, [reload]);

  // 私人 FM 是随机接口，不进并行 reload，按钮触发拉取
  const loadFm = useCallback(async () => {
    setLoadingFm(true);
    try {
      const r = await kugouApi.personalFm(cfg);
      const songs = toSongRows(pickSongArray(r));
      setFmSongs(songs);
      if (!songs.length) addToast('猜你喜欢暂时没有数据', 'info');
    } catch (e: any) {
      addToast(`FM 加载失败：${e.message}`, 'error');
    } finally {
      setLoadingFm(false);
    }
  }, [cfg, addToast]);

  const expandPlaylist = useCallback(async (p: KugouPlaylist) => {
    if (expandedId === p.listid) { setExpandedId(null); return; }
    setExpandedId(p.listid);
    setPlaylistSongs([]);
    try {
      const r = await kugouApi.playlistTrackAllNew(cfg, p.listid, 1, 100);
      const songs = toSongRows(pickSongArray(r));
      setPlaylistSongs(songs);
      if (!songs.length) addToast('歌单没有可播放的曲目', 'info');
    } catch (e: any) {
      addToast(`歌单加载失败：${e.message}`, 'error');
      setExpandedId(null);
    }
  }, [expandedId, cfg, addToast]);

  const onPlay = useCallback((song: Song) => { playSong(song); }, [playSong]);

  /* ── 未登录：登录面板 ── */
  if (!cfg.kugouCookie) {
    return (
      <KugouLoginPanel
        onBack={onBack}
        onLoggedIn={async (kugouCookie) => {
          setCfg({ ...cfg, kugouCookie });
          addToast('酷狗登录成功', 'success');
        }}
      />
    );
  }

  const renderSongRows = (songs: Song[]) => (
    <div className="px-1">
      {songs.map(s => (
        <SongRow key={`${s.source}:${s.id}:${s.hash}`}
          name={s.name} artists={s.artists} album={s.album} albumPic={s.albumPic}
          duration={fmtDur(s.duration)} isVip={s.fee === 1}
          isActive={current?.id === s.id}
          onClick={() => onPlay(s)} />
      ))}
    </div>
  );

  return (
    <div className="flex flex-col h-full relative"
      style={{ background: `linear-gradient(180deg, #ffffff 0%, ${C.bg} 50%, ${C.bgDeep} 100%)` }}>
      <BokehBg />
      <MizuHeader
        title="我的 · 酷狗"
        onBack={onBack}
        right={
          <div className="flex items-center gap-1">
            {onOpenSearch && (
              <button onClick={onOpenSearch} className="p-1.5 rounded-full transition-all" style={{ color: C.primary }}>
                <MagnifyingGlass size={16} weight="bold" />
              </button>
            )}
            {onOpenSettings && (
              <button onClick={onOpenSettings} className="p-1.5 rounded-full transition-all" style={{ color: C.primary }}>
                <Gear size={16} weight="bold" />
              </button>
            )}
          </div>
        }
      />

      <div className="flex-1 overflow-y-auto px-4 pb-24 pt-3 relative z-10 shizuku-scrollbar">
        {/* 用户卡 */}
        <div className="rounded-2xl p-3.5 shizuku-glass flex items-center gap-3" style={{ boxShadow: `0 2px 16px ${C.glow}08` }}>
          {avatar
            ? <img src={toHttps(avatar)} alt="" className="w-12 h-12 rounded-full object-cover" />
            : <div className="w-12 h-12 rounded-full flex items-center justify-center" style={{ background: `linear-gradient(135deg, ${C.primary}, ${C.accent})` }}>
                <Sparkle size={18} color="white" delay={0} />
              </div>}
          <div className="flex-1 min-w-0">
            <div className="text-sm truncate" style={{ color: C.text }}>{nickname}</div>
            <div className="text-[10px] mt-0.5" style={{ color: C.muted }}>
              {isVipUser ? '概念版 VIP' : '免费账户'} · 音质 {cfg.quality}
            </div>
          </div>
        </div>

        {/* 我喜欢（酷狗无独立 like 接口，走用户歌单里的特殊歌单；找不到就不显示） */}
        {likes && (
          <div className="mt-4">
            <div className="text-[11px] tracking-wider mb-1.5 flex items-center gap-1.5" style={{ color: C.muted }}>
              <Sparkle size={8} color={C.sakura} delay={0} /> 我喜欢 {likes.count ? `(${likes.count})` : ''}
            </div>
            <button onClick={() => expandPlaylist(likes)}
              className="w-full rounded-2xl p-3 shizuku-glass flex items-center gap-3 text-left">
              {likes.pic
                ? <img src={toHttps(likes.pic)} alt="" className="w-10 h-10 rounded-xl object-cover" />
                : <div className="w-10 h-10 rounded-xl" style={{ background: `linear-gradient(135deg, ${C.sakura}40, ${C.lavender}40)` }} />}
              <div className="flex-1 text-xs" style={{ color: C.text }}>{expandedId === likes.listid ? '收起' : '展开播放'}</div>
            </button>
            {expandedId === likes.listid && renderSongRows(playlistSongs)}
          </div>
        )}

        {/* 每日推荐 */}
        {everydaySongs.length > 0 && (
          <div className="mt-4">
            <div className="text-[11px] tracking-wider mb-1.5 flex items-center gap-1.5" style={{ color: C.muted }}>
              <Sparkle size={8} color={C.glow} delay={0.3} /> 每日推荐
            </div>
            {renderSongRows(everydaySongs)}
          </div>
        )}

        {/* 我的歌单 */}
        <div className="mt-4">
          <div className="text-[11px] tracking-wider mb-1.5 flex items-center gap-1.5" style={{ color: C.muted }}>
            <Sparkle size={8} color={C.lavender} delay={0.6} /> 我的歌单 {playlists.length ? `(${playlists.length})` : ''}
          </div>
          {playlists.map(p => (
            <div key={p.listid}>
              <button onClick={() => expandPlaylist(p)}
                className="w-full rounded-2xl p-3 mb-1.5 shizuku-glass flex items-center gap-3 text-left">
                {p.pic
                  ? <img src={toHttps(p.pic)} alt="" className="w-10 h-10 rounded-xl object-cover" />
                  : <div className="w-10 h-10 rounded-xl" style={{ background: C.glass }} />}
                <div className="flex-1 min-w-0">
                  <div className="text-xs truncate" style={{ color: C.text }}>{p.name || '未命名歌单'}</div>
                  <div className="text-[9px] mt-0.5" style={{ color: C.faint }}>{p.count || ''} 首</div>
                </div>
                <div className="text-[10px]" style={{ color: C.muted }}>{expandedId === p.listid ? '收起' : '展开'}</div>
              </button>
              {expandedId === p.listid && renderSongRows(playlistSongs)}
            </div>
          ))}
          {!playlists.length && !loading && (
            <div className="text-[10px] italic px-1" style={{ color: C.faint }}>还没有歌单</div>
          )}
        </div>

        {/* 私人 FM（猜你喜欢） */}
        <div className="mt-4">
          <button onClick={loadFm} disabled={loadingFm}
            className="w-full rounded-2xl p-3 shizuku-glass flex items-center gap-3 text-left disabled:opacity-60">
            <Sparkle size={16} color={C.lavender} delay={0} />
            <div className="flex-1 text-xs" style={{ color: C.text }}>
              {loadingFm ? '加载中...' : '私人 FM · 猜你喜欢'}
            </div>
            <div className="text-[10px]" style={{ color: C.muted }}>{fmSongs.length ? '刷新' : '开启'}</div>
          </button>
          {fmSongs.length > 0 && renderSongRows(fmSongs)}
        </div>

        {/* 最近在听 */}
        {recentSongs.length > 0 && (
          <div className="mt-4">
            <div className="text-[11px] tracking-wider mb-1.5 flex items-center gap-1.5" style={{ color: C.muted }}>
              <Sparkle size={8} color={C.sakura} delay={0.9} /> 最近在听
            </div>
            {renderSongRows(recentSongs)}
          </div>
        )}
      </div>

      {current && (
        <MiniPlayer
          name={current.name} artists={current.artists} albumPic={current.albumPic}
          playing={playing}
          onTap={onOpenPlayer} onPrev={prevSong} onToggle={togglePlay} onNext={nextSong}
        />
      )}
    </div>
  );
};

export default KugouProfilePage;
