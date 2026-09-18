/**
 * 酷狗概念版登录面板
 * - 扫码登录 (/login/qr/key 直接返回 key + 渲染好的二维码图, /login/qr/check 轮询, status=4 返回 token)
 * - 手机验证码登录 (/captcha/sent → /login/cellphone)
 * 登录成功后串 /register/dev(拿 dfid) + /user/verify(拿 auth)，拼成 kugouCookie 存进配置。
 * 多登录态并存：在这登录不会把手机上的概念版挤下线（设备管理是独立的显式接口）。
 * 注意：必须用酷狗概念版 App 扫码（worker 上游 platform=lite，token 与标准版不通用）。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useOS } from '../../context/OSContext';
import { useMusic, kugouApi } from '../../context/MusicContext';
import { composeKugouCookie, pickKugouField } from '../../utils/kugouCore';
import { C, Sparkle, MizuHeader, BokehBg } from './MusicUI';

type Mode = 'qr' | 'phone';

interface Props {
  onBack: () => void;
  onLoggedIn: (kugouCookie: string) => void;
}

const KugouLoginPanel: React.FC<Props> = ({ onBack, onLoggedIn }) => {
  const { addToast } = useOS();
  const { cfg } = useMusic();
  const [mode, setMode] = useState<Mode>('qr');

  /* ── 登录收尾：register/dev 拿 dfid → user/verify 拿 auth → 拼 kugouCookie ── */
  const postLogin = useCallback(async (token: string, userid: string) => {
    let dfid = '';
    let auth = '';
    const baseCookie = composeKugouCookie({ token, userid });
    try {
      const reg = await kugouApi.registerDev({ ...cfg, kugouCookie: baseCookie });
      dfid = pickKugouField(reg, 'dfid');
    } catch { /* 拿不到就留空，song/url 的 merge 接口会自动生成随机 dfid */ }
    try {
      const verify = await kugouApi.userVerify({ ...cfg, kugouCookie: composeKugouCookie({ token, userid, dfid }) });
      auth = pickKugouField(verify, 'auth');
    } catch { /* 拿不到 auth 只影响 VIP 音质，免费歌不受影响 */ }
    return composeKugouCookie({ token, userid, dfid, auth });
  }, [cfg]);

  /* ── 扫码 ── */
  const [qrImg, setQrImg] = useState('');
  const [qrStatus, setQrStatus] = useState<'idle' | 'waiting' | 'scanned' | 'expired' | 'done'>('idle');
  const pollRef = useRef<number | null>(null);
  const stopPoll = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };

  const startQr = useCallback(async () => {
    stopPoll();
    setQrStatus('waiting');
    setQrImg('');
    try {
      // 本地探针实测：/login/qr/key 直接返回 key（data.qrcode）+ 渲染好的二维码图（data.qrcode_img）
      const keyRes = await kugouApi.loginQrKey(cfg);
      const key = pickKugouField(keyRes, 'qrcode', 'key');
      if (!key) throw new Error('无法获取 key');
      const img = keyRes?.data?.qrcode_img || pickKugouField(keyRes, 'qrcode_img', 'qrimg', 'image');
      if (!img) throw new Error('无法生成二维码');
      setQrImg(img.startsWith('data:') ? img : `data:image/png;base64,${img}`);

      pollRef.current = window.setInterval(async () => {
        try {
          const r = await kugouApi.loginQrCheck(cfg, key);
          const code = Number(r?.data?.status ?? r?.status ?? -1);
          if (code === 0) { setQrStatus('expired'); stopPoll(); }
          else if (code === 1) { setQrStatus('waiting'); }
          else if (code === 2) { setQrStatus('scanned'); }
          else if (code === 4) {
            stopPoll();
            setQrStatus('done');
            const token = pickKugouField(r, 'token');
            const userid = pickKugouField(r, 'userid');
            if (!token) { addToast('登录信息没拿全，请重试。', 'error'); return; }
            onLoggedIn(await postLogin(token, userid));
          }
        } catch { /* transient — 下次再试 */ }
      }, 2500);
    } catch (e: any) {
      setQrStatus('idle');
      addToast(`扫码失败：${e.message}`, 'error');
    }
  }, [cfg, addToast, onLoggedIn, postLogin]);

  useEffect(() => {
    if (mode === 'qr' && qrStatus === 'idle') startQr();
    return () => { stopPoll(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  /* ── 手机验证码 ── */
  const [phone, setPhone] = useState('');
  const [captcha, setCaptcha] = useState('');
  const [sending, setSending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [loggingIn, setLoggingIn] = useState(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = window.setTimeout(() => setCooldown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const sendCaptcha = useCallback(async () => {
    if (!/^\d{11}$/.test(phone)) { addToast('请输入 11 位手机号', 'error'); return; }
    setSending(true);
    try {
      await kugouApi.captchaSent(cfg, phone);
      addToast('验证码已发送', 'success');
      setCooldown(60);
    } catch (e: any) {
      addToast(`发送失败：${e.message}`, 'error');
    } finally {
      setSending(false);
    }
  }, [phone, cfg, addToast]);

  const doLogin = useCallback(async () => {
    if (!/^\d{11}$/.test(phone) || !captcha.trim()) { addToast('手机号和验证码都要填', 'error'); return; }
    setLoggingIn(true);
    try {
      const r = await kugouApi.loginCellphone(cfg, phone, captcha.trim());
      const token = pickKugouField(r, 'token');
      const userid = pickKugouField(r, 'userid');
      if (!token) throw new Error('登录响应里没有 token');
      onLoggedIn(await postLogin(token, userid));
    } catch (e: any) {
      addToast(`登录失败：${e.message}`, 'error');
    } finally {
      setLoggingIn(false);
    }
  }, [phone, captcha, cfg, addToast, onLoggedIn, postLogin]);

  const statusText: Record<string, string> = {
    idle: '准备中...', waiting: '请用酷狗概念版 App 扫描上方二维码',
    scanned: '已扫描，请在手机上确认', expired: '二维码已过期，请刷新',
    done: '登录中...',
  };

  return (
    <div className="flex flex-col h-full relative"
      style={{ background: `linear-gradient(180deg, #ffffff 0%, ${C.bg} 50%, ${C.bgDeep} 100%)` }}>
      <BokehBg />
      <MizuHeader title="登录酷狗" onBack={onBack} />

      {/* Mode switcher */}
      <div className="mx-4 mt-3 flex items-center gap-1 shizuku-glass rounded-full p-1 relative z-10">
        {([
          { k: 'qr' as const, label: '扫码' },
          { k: 'phone' as const, label: '手机号' },
        ]).map(t => (
          <button key={t.k} onClick={() => setMode(t.k)}
            className="flex-1 py-1.5 rounded-full text-[11px] tracking-wider transition-all"
            style={{
              background: mode === t.k ? `linear-gradient(135deg, ${C.primary}, ${C.accent})` : 'transparent',
              color: mode === t.k ? 'white' : C.muted,
            }}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 relative z-10 shizuku-scrollbar">
        {/* ── 扫码 ── */}
        {mode === 'qr' && (
          <div className="flex flex-col items-center">
            <div className="relative rounded-3xl p-4 shizuku-glass-strong"
              style={{ boxShadow: `0 8px 40px ${C.glow}20` }}>
              {qrImg ? (
                <img src={qrImg} alt="qr" className="w-48 h-48 rounded-xl" />
              ) : (
                <div className="w-48 h-48 rounded-xl flex items-center justify-center"
                  style={{ background: C.glass }}>
                  <span className="w-5 h-5 border-2 rounded-full animate-spin"
                    style={{ borderColor: `${C.faint}40`, borderTopColor: C.primary }} />
                </div>
              )}
              <div className="absolute -top-1 -right-1"><Sparkle size={12} color={C.glow} delay={0} /></div>
              <div className="absolute -bottom-1 -left-1"><Sparkle size={10} color={C.sakura} delay={0.7} /></div>
            </div>
            <div className="mt-4 text-center">
              <div className="text-[11px] tracking-wide" style={{ color: C.primary }}>
                {statusText[qrStatus]}
              </div>
              {qrStatus === 'expired' && (
                <button onClick={startQr}
                  className="mt-3 px-4 py-1.5 rounded-full text-[10px] text-white"
                  style={{ background: `linear-gradient(135deg, ${C.primary}, ${C.accent})` }}>
                  刷新二维码
                </button>
              )}
              <div className="text-[9px] mt-2 italic max-w-[220px] mx-auto" style={{ color: C.faint }}>
                打开酷狗概念版 App → 我的 → 右上角扫一扫
              </div>
            </div>
          </div>
        )}

        {/* ── 手机号 ── */}
        {mode === 'phone' && (
          <div className="space-y-3 max-w-[320px] mx-auto">
            <div className="rounded-2xl p-3 shizuku-glass">
              <div className="text-[10px] mb-1.5 tracking-wider" style={{ color: C.muted }}>手机号 (仅中国)</div>
              <input
                className="w-full rounded-xl px-3 py-2 outline-none text-sm shizuku-glass"
                style={{ color: C.text }}
                placeholder="13800138000"
                value={phone} onChange={e => setPhone(e.target.value.replace(/\D/g, '').slice(0, 11))}
                inputMode="numeric"
              />
            </div>
            <div className="rounded-2xl p-3 shizuku-glass">
              <div className="text-[10px] mb-1.5 tracking-wider flex justify-between" style={{ color: C.muted }}>
                <span>验证码</span>
                <button
                  onClick={sendCaptcha}
                  disabled={sending || cooldown > 0}
                  className="text-[10px] disabled:opacity-40"
                  style={{ color: C.accent }}
                >
                  {sending ? '发送中...' : cooldown > 0 ? `${cooldown}s 后重发` : '获取验证码'}
                </button>
              </div>
              <input
                className="w-full rounded-xl px-3 py-2 outline-none text-sm shizuku-glass tracking-widest"
                style={{ color: C.text }}
                placeholder="6 位验证码"
                value={captcha} onChange={e => setCaptcha(e.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
              />
            </div>
            <button
              onClick={doLogin}
              disabled={loggingIn}
              className="w-full py-3 rounded-2xl text-sm text-white tracking-wider relative overflow-hidden disabled:opacity-60"
              style={{ background: `linear-gradient(135deg, ${C.primary}, ${C.accent})`, boxShadow: `0 3px 18px ${C.glow}30` }}
            >
              <span className="relative z-10">{loggingIn ? '登录中...' : '登录'}</span>
            </button>
            <div className="text-[9px] text-center italic" style={{ color: C.faint }}>
              多登录态并存，登录这里不会把你手机上的概念版挤下线
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default KugouLoginPanel;
