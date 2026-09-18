import { describe, it, expect } from 'vitest';
import { kugouQuality, hashToId, mapKugouSearchItem, composeKugouCookie, pickKugouField, kugouUrlErrorText } from './kugouCore';

describe('kugouQuality', () => {
  it('五档映射到酷狗 quality 参数', () => {
    expect(kugouQuality('standard')).toBe('128');
    expect(kugouQuality('higher')).toBe('320');
    expect(kugouQuality('exhigh')).toBe('320');
    expect(kugouQuality('lossless')).toBe('flac');
    expect(kugouQuality('hires')).toBe('high');
  });
});

describe('hashToId', () => {
  it('取前 12 位 hex 转数，非法输入返回 0', () => {
    expect(hashToId('0123456789abcdef0123456789abcdef')).toBe(parseInt('0123456789ab', 16));
    expect(hashToId('')).toBe(0);
    expect(hashToId('!!!')).toBe(0);
  });
});

describe('mapKugouSearchItem', () => {
  // 真实 /search 响应项（2026-09-18 线上探针实测：晴天）。
  // 另见 track/all/new 项（小写 hash/name 带 .mp3 后缀/singerinfo[]）与 everyday/fm 项
  // （songname/author_name/album_name），都在下面的用例里覆盖。
  const SAMPLE = {
    FileHash: 'B3A52A7A958BF0AED0EBFBA2E9A818B7',
    SongName: '晴天',
    SingerName: '周杰伦',
    AlbumName: '叶惠美',
    AlbumID: '966846',
    MixSongID: '32100650',
    Audioid: 20505418,
    Duration: 269,
    Price: 200,
    trans_param: { union_cover: 'http://imge.kugou.com/stdmusic/{size}/20230920/abc.jpg' },
  };
  it('主形态字段映射', () => {
    const s = mapKugouSearchItem(SAMPLE);
    expect(s).toMatchObject({
      id: 20505418, name: '晴天', artists: '周杰伦', album: '叶惠美',
      duration: 269, fee: 1, source: 'kugou',
      hash: 'B3A52A7A958BF0AED0EBFBA2E9A818B7',
      kugouAlbumId: '966846', albumAudioId: 20505418,
    });
    // albumPic 封面模板 {size} 替换；http→https 由 UI 层 toHttps 做
    expect(s.albumPic).toBe('http://imge.kugou.com/stdmusic/480/20230920/abc.jpg');
  });
  it('MixSongID（大写 M）参与 id 兜底', () => {
    expect(mapKugouSearchItem({ ...SAMPLE, MixSongID: 42, Audioid: undefined, Price: 0 }).id).toBe(42);
    expect(mapKugouSearchItem({ FileHash: SAMPLE.FileHash, SongName: 'x' }).id).toBe(hashToId(SAMPLE.FileHash));
  });
  it('VIP 标记 → fee=1（is_vip / pay_block / Price 付费价任一成立）', () => {
    expect(mapKugouSearchItem({ ...SAMPLE, is_vip: 1 }).fee).toBe(1);
    expect(mapKugouSearchItem({ ...SAMPLE, trans_param: { pay_block: 1 } }).fee).toBe(1);
    expect(mapKugouSearchItem({ ...SAMPLE, Price: 0, is_vip: 0 } as any).fee).toBe(0);
  });
  it('毫秒时长折算成秒', () => {
    expect(mapKugouSearchItem({ ...SAMPLE, Duration: 269000 }).duration).toBe(269);
  });
  it('track/all/new 项：小写 hash、name 去 .mp3 后缀、singerinfo 歌手、albuminfo 专辑、timelen 毫秒', () => {
    const s = mapKugouSearchItem({
      hash: 'EC237E183F2DF9371BDC946B48F3E36E',
      name: "The Cat's Whiskers - Get It Back.mp3",
      singerinfo: [{ type: 2, name: 'TCW' }],
      albuminfo: { name: 'ANTHEM' },
      album_id: '90124609',
      mixsongid: 616762064,
      timelen: 200542,
      cover: 'http://imge.kugou.com/stdmusic/{size}/20240321/x.jpg',
    });
    expect(s).toMatchObject({
      id: 616762064, name: "The Cat's Whiskers - Get It Back", artists: 'TCW', album: 'ANTHEM',
      duration: 201, fee: 0, source: 'kugou', hash: 'EC237E183F2DF9371BDC946B48F3E36E',
      kugouAlbumId: '90124609',
    });
    expect(s.albumPic).toBe('http://imge.kugou.com/stdmusic/480/20240321/x.jpg');
  });
  it('everyday/fm 项：songname/author_name/album_name', () => {
    const s = mapKugouSearchItem({
      hash: 'C28F23069CA89C3C481217BECAAEF3A4',
      songname: 'Girlfriends',
      author_name: 'Boys World',
      album_name: 'GRL',
      album_audio_id: 277812729,
      mixsongid: 84357782,
    });
    expect(s).toMatchObject({
      id: 277812729, name: 'Girlfriends', artists: 'Boys World', album: 'GRL',
      hash: 'C28F23069CA89C3C481217BECAAEF3A4',
    });
  });
});

describe('composeKugouCookie', () => {
  it('固定顺序拼装，空值跳过，段之间无空格（上游 cookieToJson 不 trim）', () => {
    expect(composeKugouCookie({ token: 't', userid: 7, dfid: 'd', auth: 'a' })).toBe('token=t;userid=7;dfid=d;auth=a');
    expect(composeKugouCookie({ token: 't' })).toBe('token=t');
    expect(composeKugouCookie({})).toBe('');
  });
});

describe('pickKugouField', () => {
  it('data 内优先，多 key 兜底', () => {
    expect(pickKugouField({ data: { token: 'T' } }, 'token', 'qrcode')).toBe('T');
    expect(pickKugouField({ dfid: 'D' }, 'token', 'dfid')).toBe('D');
    expect(pickKugouField({}, 'token')).toBe('');
  });
});

describe('kugouUrlErrorText', () => {
  it('实测 errcode 映射', () => {
    expect(kugouUrlErrorText(152, true)).toBe('需要登录酷狗（我的 → 登录酷狗）');
    expect(kugouUrlErrorText(20010, true)).toBe('酷狗登录失效，请重新扫码登录');
    expect(kugouUrlErrorText(20018, true)).toBe('酷狗登录失效，请重新扫码登录');
    expect(kugouUrlErrorText(20028, true)).toBe('酷狗要求验证（更换网络/重试）');
    expect(kugouUrlErrorText(20031, true)).toBe('这首歌需要酷狗 VIP');
    expect(kugouUrlErrorText(null, true)).toBe('这首歌暂无可用音源（可能需 VIP）');
    expect(kugouUrlErrorText(null, false)).toBe('需要登录酷狗（我的 → 登录酷狗）');
  });
});
