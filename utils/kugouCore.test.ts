import { describe, it, expect } from 'vitest';
import { kugouQuality, hashToId, mapKugouSearchItem, composeKugouCookie, pickKugouField } from './kugouCore';

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
  // 主形态字段。Task 0 探针/真机校准若发现真实字段名不同：更新这里 + kugouCore 的 key 枚举，两者必须同步改。
  const SAMPLE = {
    FileHash: '0123456789abcdef0123456789abcdef',
    SongName: '晴天',
    SingerName: '周杰伦',
    AlbumName: '叶惠美',
    AlbumID: '12345',
    AlbumAudioID: 6873491,
    Duration: 269,
    Image: 'http://imge.kugou.com/xxx.jpg',
  };
  it('主形态字段映射', () => {
    const s = mapKugouSearchItem(SAMPLE);
    expect(s).toMatchObject({
      id: 6873491, name: '晴天', artists: '周杰伦', album: '叶惠美',
      duration: 269, fee: 0, source: 'kugou',
      hash: '0123456789abcdef0123456789abcdef',
      kugouAlbumId: '12345', albumAudioId: 6873491,
    });
    // albumPic 原样透传，http→https 由 UI 层 toHttps 做
    expect(s.albumPic).toBe('http://imge.kugou.com/xxx.jpg');
  });
  it('无 AlbumAudioID 用 mixSongID，再无则 hash 兜底', () => {
    expect(mapKugouSearchItem({ ...SAMPLE, AlbumAudioID: undefined, mixSongID: 42 }).id).toBe(42);
    expect(mapKugouSearchItem({ FileHash: SAMPLE.FileHash, SongName: 'x' }).id).toBe(parseInt('0123456789ab', 16));
  });
  it('VIP 标记 → fee=1（列表角标语义与网易 fee===1 对齐）', () => {
    expect(mapKugouSearchItem({ ...SAMPLE, is_vip: 1 }).fee).toBe(1);
    expect(mapKugouSearchItem({ ...SAMPLE, trans_param: { pay_block: 1 } }).fee).toBe(1);
  });
  it('毫秒时长折算成秒', () => {
    expect(mapKugouSearchItem({ ...SAMPLE, Duration: 269000 }).duration).toBe(269);
  });
});

describe('composeKugouCookie', () => {
  it('固定顺序拼装，空值跳过', () => {
    expect(composeKugouCookie({ token: 't', userid: 7, dfid: 'd', auth: 'a' })).toBe('token=t; userid=7; dfid=d; auth=a');
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
