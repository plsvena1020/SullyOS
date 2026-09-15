import React, { useEffect, useState } from 'react';
import type { CharacterProfile, RealtimeConfig } from '../../types';
import { HIDDEN_APP_NAMES, INSTALLED_APPS } from '../../constants';
import { getPlatformBridge } from '../../utils/platform/bridge';
import { outboxCount } from '../../utils/platform/appActivity/queue';
import {
  clearPerspectiveQueue,
} from '../../utils/perspectiveTelemetry';
import {
  clearPerspectiveSessions,
} from '../../utils/perspective';
import {
  ensurePerspectiveDevice,
  getPerspectiveDeviceId,
  getPerspectiveRuntimeAuth,
  isPerspectivePaused,
  resetPerspectiveDevice,
  revokePerspectiveRoleToken,
  setPerspectivePaused,
} from '../../utils/perspectiveTokens';

export interface PerspectivePanelProps {
  realtimeConfig: RealtimeConfig;
  updateRealtimeConfig: (patch: Partial<RealtimeConfig>) => void;
  addToast: (message: string, type?: 'success' | 'error' | 'info') => void;
  characters: CharacterProfile[];
  /** 写回配置后的统一收尾（清缓存 + 同步主动消息），由 Settings 提供。 */
  onPersist: (next: RealtimeConfig) => void;
}

const baseUrlOf = (rc: RealtimeConfig): string =>
  (rc.perspectiveWorkerUrl || '').trim().replace(/\/+$/, '');

export default function PerspectivePanel({
  realtimeConfig,
  updateRealtimeConfig,
  addToast,
  characters,
  onPersist,
}: PerspectivePanelProps): React.JSX.Element {
  const caps = getPlatformBridge().capabilities;
  const [draftUrl, setDraftUrl] = useState(realtimeConfig.perspectiveWorkerUrl || '');
  const [draftDays, setDraftDays] = useState(String(realtimeConfig.perspectiveDays ?? 7));
  const [draftInterval, setDraftInterval] = useState(String(realtimeConfig.perspectiveMinIntervalSec ?? 60));
  const [draftSummary, setDraftSummary] = useState(!!realtimeConfig.perspectiveSummaryEnabled);
  const [draftThreshold, setDraftThreshold] = useState(String(realtimeConfig.perspectiveSummaryThreshold ?? 500));
  const [excludedApps, setExcludedApps] = useState<string[]>(() =>
    Array.isArray(realtimeConfig.perspectiveExcludedApps) ? [...realtimeConfig.perspectiveExcludedApps] : [],
  );
  const [extraExclude, setExtraExclude] = useState('');
  const [pairingCode, setPairingCode] = useState('');
  const [pairing, setPairing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState('');
  const [deviceId, setDeviceId] = useState<string | null>(() => getPerspectiveDeviceId());
  const [deviceName, setDeviceName] = useState('');
  const [paused, setPaused] = useState(() => isPerspectivePaused());
  const [queueDepth, setQueueDepth] = useState<number | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmLegacy, setConfirmLegacy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    outboxCount()
      .then((n) => {
        if (!cancelled) setQueueDepth(n);
      })
      .catch(() => {
        if (!cancelled) setQueueDepth(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshQueue = () => {
    outboxCount()
      .then(setQueueDepth)
      .catch(() => setQueueDepth(null));
  };

  const saveBasics = () => {
    const url = draftUrl.trim().replace(/\/+$/, '');
    const patch: Partial<RealtimeConfig> = {
      perspectiveEnabled: realtimeConfig.perspectiveEnabled,
      perspectiveWorkerUrl: url,
      perspectiveDays: Math.min(Math.max(parseInt(draftDays, 10) || 7, 1), 30),
      perspectiveMinIntervalSec: Math.max(parseInt(draftInterval, 10) || 0, 0),
      perspectiveSummaryEnabled: draftSummary,
      perspectiveSummaryThreshold: Math.max(parseInt(draftThreshold, 10) || 500, 10),
      perspectiveExcludedApps: [...excludedApps],
    };
    updateRealtimeConfig(patch);
    onPersist({ ...realtimeConfig, ...patch });
    addToast('透视窗配置已保存', 'success');
  };

  const toggleEnabled = (on: boolean) => {
    const patch: Partial<RealtimeConfig> = { perspectiveEnabled: on };
    updateRealtimeConfig(patch);
    onPersist({ ...realtimeConfig, ...patch });
  };

  const doPair = async () => {
    const base = draftUrl.trim().replace(/\/+$/, '');
    if (!base) {
      addToast('请先填写 Worker 地址', 'error');
      return;
    }
    if (!pairingCode.trim()) {
      addToast('请填写配对码', 'error');
      return;
    }
    setPairing(true);
    try {
      const r = await ensurePerspectiveDevice(base, {
        pairingCode: pairingCode.trim(),
        deviceName: deviceName.trim() || undefined,
      });
      if (!r) {
        addToast('配对失败：配对码无效或网络不可达', 'error');
        return;
      }
      setDeviceId(r.deviceId);
      setPairingCode('');
      const patch: Partial<RealtimeConfig> = { perspectiveWorkerUrl: base };
      updateRealtimeConfig(patch);
      onPersist({ ...realtimeConfig, ...patch });
      addToast('设备配对成功', 'success');
    } finally {
      setPairing(false);
    }
  };

  const doTest = async () => {
    const base = baseUrlOf(realtimeConfig) || draftUrl.trim().replace(/\/+$/, '');
    if (!base) {
      setTestResult('请先填写 Worker 地址');
      return;
    }
    setTesting(true);
    setTestResult('连接中…');
    try {
      const res = await fetch(`${base}/health`);
      if (!res.ok) {
        setTestResult(`连接失败：HTTP ${res.status}`);
        return;
      }
      const body = (await res.json()) as { retentionDays?: number };
      setTestResult(`已连接（保留 ${body.retentionDays ?? '?'} 天）`);
    } catch (e: any) {
      setTestResult(`不可达：${e?.message || '网络错误'}`);
    } finally {
      setTesting(false);
    }
  };

  const doQr = async () => {
    const base = draftUrl.trim().replace(/\/+$/, '');
    if (!base || !pairingCode.trim()) {
      addToast('生成二维码需要 Worker 地址和配对码', 'error');
      return;
    }
    try {
      const QRCode = (await import('qrcode')).default;
      const payload = `sullypv1:${btoa(unescape(encodeURIComponent(JSON.stringify({ url: base, pairingCode: pairingCode.trim() }))))}`;
      setQrDataUrl(await QRCode.toDataURL(payload));
    } catch {
      addToast('二维码生成失败', 'error');
    }
  };

  const doClearMine = async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      setTimeout(() => setConfirmClear(false), 5000);
      return;
    }
    setConfirmClear(false);
    const base = baseUrlOf(realtimeConfig);
    const auth = getPerspectiveRuntimeAuth();
    if (!base || !auth.token) {
      addToast('尚未配对，无可清空的云端记录', 'info');
      return;
    }
    setBusy(true);
    try {
      const r = await clearPerspectiveSessions(realtimeConfig, auth, {});
      await clearPerspectiveQueue();
      refreshQueue();
      addToast(r.ok ? `已清空本设备云端记录（${r.deleted} 段）与本地队列` : `清空失败：${r.message || r.reason}`, r.ok ? 'success' : 'error');
    } finally {
      setBusy(false);
    }
  };

  const doClearLegacy = async () => {
    if (!confirmLegacy) {
      setConfirmLegacy(true);
      setTimeout(() => setConfirmLegacy(false), 5000);
      return;
    }
    setConfirmLegacy(false);
    const base = baseUrlOf(realtimeConfig);
    if (!base || !pairingCode.trim()) {
      addToast('清理旧数据需要 Worker 地址和配对码', 'error');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`${base}/admin/purge-default`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${pairingCode.trim()}` },
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; deletedSessions?: number };
      addToast(
        body.ok ? `已清理旧默认设备数据（${body.deletedSessions ?? 0} 段）` : '清理失败：凭据无效',
        body.ok ? 'success' : 'error',
      );
    } catch (e: any) {
      addToast(`清理失败：${e?.message || '网络错误'}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const doReset = async () => {
    if (!confirmReset) {
      setConfirmReset(true);
      setTimeout(() => setConfirmReset(false), 5000);
      return;
    }
    setConfirmReset(false);
    await resetPerspectiveDevice();
    await clearPerspectiveQueue().catch(() => undefined);
    setDeviceId(null);
    refreshQueue();
    addToast('已重置本机设备身份（需重新配对）', 'success');
  };

  const revokeChar = async (charId: string, charName: string) => {
    const base = baseUrlOf(realtimeConfig);
    if (!base) return;
    await revokePerspectiveRoleToken(base, charId);
    addToast(`已吊销 ${charName} 的透视窗令牌`, 'success');
  };

  const enabledChars = characters.filter((c) => c.perspectiveEnabled);
  const capabilityNote =
    caps.runtime === 'android'
      ? 'Android 版：可记录 SullyOS 内部 App 与系统前台应用（需“使用情况访问”权限）。'
      : caps.runtime === 'windows'
        ? 'Windows 版：可记录 SullyOS 内部 App 与前台进程（仅进程身份，不含窗口标题）。'
        : 'Web 版：仅记录 SullyOS 内部 App（如聊天、小红书），系统应用记录需要 Android / Windows 安装版。';

  return (
    <div className="bg-cyan-50/60 p-4 rounded-2xl space-y-3">
      <div className="flex items-center justify-between min-h-[44px]">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-cyan-700">透视窗</span>
          <span className="text-[9px] bg-cyan-100 text-cyan-700 px-1.5 py-0.5 rounded-full">自建 Worker</span>
        </div>
        <label className="relative inline-flex items-center cursor-pointer min-h-[44px]">
          <input
            type="checkbox"
            checked={!!realtimeConfig.perspectiveEnabled}
            onChange={(e) => toggleEnabled(e.target.checked)}
            className="sr-only peer"
            aria-label="透视窗总开关"
          />
          <div className="w-11 h-6 bg-slate-200 peer-focus:ring-2 peer-focus:ring-cyan-400 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[10px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-cyan-500" />
        </label>
      </div>
      <p className="text-[10px] text-cyan-700/70 leading-relaxed">
        开启后，被授权的角色可以查看你的应用使用记录（用了哪些应用、大概用了多久）。{capabilityNote}仅应用身份与时长，不含聊天内容、窗口标题与网址。
      </p>

      {realtimeConfig.perspectiveEnabled && (
        <div className="space-y-3">
          <div>
            <label htmlFor="pv-worker-url" className="text-[10px] font-bold text-slate-400 uppercase block mb-1">
              Worker 地址
            </label>
            <input
              id="pv-worker-url"
              value={draftUrl}
              onChange={(e) => setDraftUrl(e.target.value)}
              className="w-full bg-white/80 border border-cyan-200 rounded-xl px-3 py-2 text-sm font-mono"
              placeholder="https://xxx.workers.dev"
              inputMode="url"
            />
          </div>

          <div className="flex gap-2">
            <button
              onClick={doTest}
              disabled={testing}
              className="flex-1 py-2 min-h-[44px] bg-cyan-100 text-cyan-700 text-xs font-bold rounded-xl active:scale-95 transition-transform disabled:opacity-60"
            >
              {testing ? '测试中…' : '测试连接'}
            </button>
            <button
              onClick={refreshQueue}
              className="flex-1 py-2 min-h-[44px] bg-slate-100 text-slate-600 text-xs font-bold rounded-xl active:scale-95 transition-transform"
            >
              刷新队列{queueDepth != null ? `（${queueDepth}）` : ''}
            </button>
          </div>
          {testResult && <p className="text-[11px] text-slate-600 leading-relaxed">{testResult}</p>}

          <div className="bg-white/60 rounded-xl p-3 space-y-2">
            <p className="text-[11px] font-bold text-slate-500">
              本机设备：{deviceId ? `${deviceId.slice(0, 8)}…` : '未配对'}
            </p>
            {!deviceId && (
              <div className="space-y-2">
                <div>
                  <label htmlFor="pv-pair-code" className="text-[10px] font-bold text-slate-400 uppercase block mb-1">
                    配对码
                  </label>
                  <input
                    id="pv-pair-code"
                    type="password"
                    value={pairingCode}
                    onChange={(e) => setPairingCode(e.target.value)}
                    className="w-full bg-white/80 border border-cyan-200 rounded-xl px-3 py-2 text-sm font-mono"
                    placeholder="在 Worker 侧配置的配对码"
                  />
                </div>
                <div>
                  <label htmlFor="pv-device-name" className="text-[10px] font-bold text-slate-400 uppercase block mb-1">
                    设备名称（可选）
                  </label>
                  <input
                    id="pv-device-name"
                    value={deviceName}
                    onChange={(e) => setDeviceName(e.target.value)}
                    className="w-full bg-white/80 border border-cyan-200 rounded-xl px-3 py-2 text-sm"
                    placeholder="我的手机"
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={doPair}
                    disabled={pairing}
                    className="flex-1 py-2 min-h-[44px] bg-cyan-500 text-white text-xs font-bold rounded-xl active:scale-95 transition-transform disabled:opacity-60"
                  >
                    {pairing ? '配对中…' : '配对'}
                  </button>
                  <button
                    onClick={doQr}
                    className="flex-1 py-2 min-h-[44px] bg-slate-100 text-slate-600 text-xs font-bold rounded-xl active:scale-95 transition-transform"
                  >
                    生成配对二维码
                  </button>
                </div>
                {qrDataUrl && <img src={qrDataUrl} alt="透视窗配对二维码" className="w-32 h-32 mx-auto rounded-xl" />}
              </div>
            )}
            {deviceId && (
              <div className="flex items-center justify-between min-h-[44px]">
                <span className="text-[11px] font-bold text-slate-500">暂停采集（保留已记录）</span>
                <label className="relative inline-flex items-center cursor-pointer min-h-[44px]">
                  <input
                    type="checkbox"
                    checked={paused}
                    onChange={(e) => {
                      setPaused(e.target.checked);
                      setPerspectivePaused(e.target.checked);
                    }}
                    className="sr-only peer"
                    aria-label="暂停透视窗采集"
                  />
                  <div className="w-11 h-6 bg-slate-200 peer-focus:ring-2 peer-focus:ring-cyan-400 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[10px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-amber-500" />
                </label>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor="pv-days" className="text-[10px] font-bold text-slate-400 uppercase block mb-1">
                可查天数上限
              </label>
              <input
                id="pv-days"
                type="number"
                min="1"
                max="30"
                value={draftDays}
                onChange={(e) => setDraftDays(e.target.value)}
                className="w-full bg-white/80 border border-cyan-200 rounded-xl px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="pv-interval" className="text-[10px] font-bold text-slate-400 uppercase block mb-1">
                查询间隔（秒）
              </label>
              <input
                id="pv-interval"
                type="number"
                min="0"
                value={draftInterval}
                onChange={(e) => setDraftInterval(e.target.value)}
                className="w-full bg-white/80 border border-cyan-200 rounded-xl px-3 py-2 text-sm"
              />
            </div>
          </div>
          <div className="flex items-center justify-between min-h-[44px]">
            <label htmlFor="pv-summary" className="text-[11px] font-bold text-slate-500">
              数据量大时自动总结（省 token）
            </label>
            <input
              id="pv-summary"
              type="checkbox"
              checked={draftSummary}
              onChange={(e) => setDraftSummary(e.target.checked)}
              className="w-5 h-5 accent-cyan-500"
            />
          </div>
          {draftSummary && (
            <div>
              <label htmlFor="pv-threshold" className="text-[10px] font-bold text-slate-400 uppercase block mb-1">
                总结触发阈值（段）
              </label>
              <input
                id="pv-threshold"
                type="number"
                min="10"
                value={draftThreshold}
                onChange={(e) => setDraftThreshold(e.target.value)}
                className="w-full bg-white/80 border border-cyan-200 rounded-xl px-3 py-2 text-sm"
              />
            </div>
          )}
          <button
            onClick={saveBasics}
            className="w-full py-2 min-h-[44px] bg-cyan-500 text-white text-xs font-bold rounded-xl active:scale-95 transition-transform"
          >
            保存透视窗配置
          </button>

          <div className="bg-white/60 rounded-xl p-3 space-y-2">
            <p className="text-[11px] font-bold text-slate-500">
              不记录的 App（{excludedApps.length}）— 勾选后这些应用的使用不会进入本地队列，也不会上传
            </p>
            <div className="max-h-44 overflow-y-auto space-y-1 pr-1">
              {INSTALLED_APPS.map((app) => {
                const checked = excludedApps.includes(app.id);
                return (
                  <label key={app.id} className="flex items-center gap-2 min-h-[44px] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        setExcludedApps((prev) =>
                          e.target.checked ? [...prev, app.id] : prev.filter((x) => x !== app.id),
                        );
                      }}
                      className="w-5 h-5 accent-cyan-500 shrink-0"
                    />
                    <span className="text-xs text-slate-600">{app.name}</span>
                  </label>
                );
              })}
              {Object.entries(HIDDEN_APP_NAMES).map(([id, name]) => {
                if (INSTALLED_APPS.some((a) => a.id === id)) return null;
                const checked = excludedApps.includes(id);
                return (
                  <label key={id} className="flex items-center gap-2 min-h-[44px] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        setExcludedApps((prev) =>
                          e.target.checked ? [...prev, id] : prev.filter((x) => x !== id),
                        );
                      }}
                      className="w-5 h-5 accent-cyan-500 shrink-0"
                    />
                    <span className="text-xs text-slate-600">{name}</span>
                  </label>
                );
              })}
            </div>
            <div className="flex gap-2">
              <input
                value={extraExclude}
                onChange={(e) => setExtraExclude(e.target.value)}
                className="flex-1 bg-white/80 border border-cyan-200 rounded-xl px-3 py-2 min-h-[44px] text-sm font-mono"
                placeholder="其他：包名/进程名/显示名，如 com.tencent.mm"
              />
              <button
                onClick={() => {
                  const key = extraExclude.trim();
                  if (!key || excludedApps.includes(key)) return;
                  setExcludedApps((prev) => [...prev, key]);
                  setExtraExclude('');
                }}
                className="px-4 min-h-[44px] bg-slate-100 text-slate-600 text-xs font-bold rounded-xl active:scale-95 transition-transform"
              >
                添加
              </button>
            </div>
            {excludedApps.filter(
              (x) => !INSTALLED_APPS.some((a) => a.id === x) && !(x in HIDDEN_APP_NAMES),
            ).length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {excludedApps
                  .filter((x) => !INSTALLED_APPS.some((a) => a.id === x) && !(x in HIDDEN_APP_NAMES))
                  .map((x) => (
                    <button
                      key={x}
                      onClick={() => setExcludedApps((prev) => prev.filter((y) => y !== x))}
                      title="点击移除"
                      className="px-2 py-1.5 min-h-[36px] bg-slate-100 text-slate-600 text-[11px] font-mono rounded-lg active:scale-95 transition-transform"
                    >
                      {x} ✕
                    </button>
                  ))}
              </div>
            )}
            <p className="text-[10px] text-slate-400 leading-relaxed">
              排除在采集端执行：被排除的应用不创建会话。记得点「保存透视窗配置」。
            </p>
          </div>
          <p className="text-[10px] text-cyan-700/70 leading-relaxed">
            记录保留 30 天（Worker 每日清理）。总结走主聊天 API，产出缓存后角色查总结秒回。
          </p>

          {enabledChars.length > 0 && (
            <div className="bg-white/60 rounded-xl p-3 space-y-2">
              <p className="text-[11px] font-bold text-slate-500">已授权角色（{enabledChars.length}）</p>
              {enabledChars.map((c) => (
                <div key={c.id} className="flex items-center justify-between min-h-[44px]">
                  <span className="text-xs text-slate-600">{c.name}</span>
                  <button
                    onClick={() => revokeChar(c.id, c.name)}
                    className="px-3 py-2 min-h-[44px] bg-red-50 text-red-600 text-[11px] font-bold rounded-xl active:scale-95 transition-transform"
                  >
                    吊销令牌
                  </button>
                </div>
              ))}
              <p className="text-[10px] text-slate-400 leading-relaxed">
                在各角色的聊天设置里开关透视窗授权；关闭即吊销令牌。
              </p>
            </div>
          )}

          <div className="space-y-2">
            <button
              onClick={doClearMine}
              disabled={busy}
              className="w-full py-2 min-h-[44px] bg-red-50 text-red-600 text-xs font-bold rounded-xl active:scale-95 transition-transform disabled:opacity-60"
            >
              {confirmClear ? '再次点击确认清空本设备记录' : '清空本设备记录'}
            </button>
            <button
              onClick={doClearLegacy}
              disabled={busy}
              className="w-full py-2 min-h-[44px] bg-slate-100 text-slate-600 text-xs font-bold rounded-xl active:scale-95 transition-transform disabled:opacity-60"
            >
              {confirmLegacy ? '再次点击确认清理旧默认设备数据' : '清理旧默认设备数据'}
            </button>
            <button
              onClick={doReset}
              disabled={busy}
              className="w-full py-2 min-h-[44px] bg-slate-100 text-slate-600 text-xs font-bold rounded-xl active:scale-95 transition-transform disabled:opacity-60"
            >
              {confirmReset ? '再次点击确认重置本机身份' : '重置本机设备身份'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
