// vps-backend/src/voice-relay/run.js
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const PORT = Number(process.env.VOICE_RELAY_PORT || 8839);
const HOST = '127.0.0.1';

const ALLOW_HEADERS = ['Authorization', 'xi-api-key', 'model', 'X-MiniMax-Region', 'X-MiniMax-Group-Id', 'Content-Type', 'Accept'];

export function applyCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', ALLOW_HEADERS.join(', '));
  res.setHeader('Access-Control-Max-Age', '86400');
}

export function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export const ROUTES = {}; // Task 2 填充：'POST /api/minimax/t2a' -> handler

const DOMESTIC_BASE = 'https://api.minimaxi.com';
const OVERSEAS_BASE = 'https://api.minimax.io';
const normKey = (v) => String(v || '').trim().replace(/^Bearer\s+/i, '').trim();

function minimaxBase(h) {
  const region = String(h['x-minimax-region'] || process.env.MINIMAX_REGION || '').trim().toLowerCase();
  return region === 'overseas' ? OVERSEAS_BASE : DOMESTIC_BASE;
}

function parseJsonBody(raw) {
  if (!raw.length) return { ok: true, body: {} };
  try {
    return { ok: true, body: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false, body: null };
  }
}

async function t2a(req, res, url, deps = {}) {
  const f = deps.fetch ?? globalThis.fetch;
  const raw = await readBody(req);
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) return sendJson(res, 400, { error: 'Invalid JSON' });
  const body = parsed.body;
  const h = req.headers;
  const key = normKey(h.authorization) || normKey(h['x-minimax-api-key']);
  if (!key) return sendJson(res, 400, { error: 'Missing API key. Provide Authorization or x-minimax-api-key.' });
  const base = minimaxBase(h);
  const gid = [body.group_id, h['x-minimax-group-id'], process.env.MINIMAX_GROUP_ID].map((v) => String(v || '').trim()).find(Boolean) || '';
  const out = { ...body };
  if (gid && !out.group_id) out.group_id = gid;
  const upstream = await f(base + '/v1/t2a_v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(out),
  });
  const text = await upstream.text();
  res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
  res.end(text);
}
ROUTES['POST /api/minimax/t2a'] = t2a;

async function voiceClone(req, res, url, deps = {}) {
  const f = deps.fetch ?? globalThis.fetch;
  const raw = await readBody(req);
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) return sendJson(res, 400, { error: 'Invalid JSON' });
  const h = req.headers;
  const key = normKey(h.authorization) || normKey(h['x-minimax-api-key']);
  if (!key) return sendJson(res, 400, { error: 'Missing API key.' });
  const upstream = await f(minimaxBase(h) + '/v1/voice_clone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(parsed.body),
  });
  const text = await upstream.text();
  res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
  res.end(text);
}
ROUTES['POST /api/minimax/voice-clone'] = voiceClone;

async function upload(req, res, url, deps = {}) {
  const f = deps.fetch ?? globalThis.fetch;
  const raw = await readBody(req);
  const h = req.headers;
  const key = normKey(h.authorization) || normKey(h['x-minimax-api-key']);
  if (!key) return sendJson(res, 400, { error: 'Missing API key.' });
  // raw passthrough: never JSON.parse multipart bodies.
  const contentType = h['content-type'] || '';
  const upstream = await f(minimaxBase(h) + '/v1/files/upload', {
    method: 'POST',
    headers: { 'Content-Type': contentType, Authorization: `Bearer ${key}` },
    body: raw,
  });
  const text = await upstream.text();
  res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
  res.end(text);
}
ROUTES['POST /api/minimax/upload'] = upload;

async function getVoice(req, res, url, deps = {}) {
  const f = deps.fetch ?? globalThis.fetch;
  const raw = await readBody(req);
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) return sendJson(res, 400, { error: 'Invalid JSON' });
  const h = req.headers;
  const key = normKey(h.authorization) || normKey(h['x-minimax-api-key']);
  if (!key) return sendJson(res, 400, { error: 'Missing API key. Provide Authorization or x-minimax-api-key.' });
  const upstream = await f(minimaxBase(h) + '/v1/get_voice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(parsed.body),
  });
  const text = await upstream.text();
  res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
  res.end(text);
}
ROUTES['POST /api/minimax/get-voice'] = getVoice;

// bake-voice: three-step orchestration ported from api/minimax/_bakeVoiceCore.ts (plain JS, no TS import).
const CLONE_SOURCE_TEXT = '在一个阳光明媚的早晨，小鸟在枝头欢快地歌唱，微风轻轻拂过脸庞，带来了花朵的芬芳。远处的山峦在薄雾中若隐若现，宛如一幅水墨画。人们漫步在林荫小道上，享受着这难得的宁静时光。孩子们在草地上奔跑嬉戏，笑声回荡在空气中，让人感到无比温暖和幸福。';

function resolveMinimaxUrls(parts) {
  const norm = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
  const region = norm(parts.bodyRegion) || norm(parts.headerRegion) || norm(parts.envRegion);
  const base = region === 'overseas' ? OVERSEAS_BASE : DOMESTIC_BASE;
  return {
    t2a: `${base}/v1/t2a_v2`,
    upload: `${base}/v1/files/upload`,
    clone: `${base}/v1/voice_clone`,
  };
}

async function runBakeVoiceInternal(input, deps = {}) {
  const f = deps.fetch ?? globalThis.fetch;
  const { apiKey, voiceId, model, ttsPayload, groupId } = input;
  if (!apiKey) throw new Error('Missing apiKey');
  if (!voiceId) throw new Error('Missing voiceId');
  if (!ttsPayload) throw new Error('Missing ttsPayload');
  const envRegion = typeof process !== 'undefined' ? process.env.MINIMAX_REGION : '';
  const urls = resolveMinimaxUrls({ bodyRegion: input.region, headerRegion: input.regionHeader, envRegion });
  const t2aBody = {
    ...ttsPayload,
    text: CLONE_SOURCE_TEXT,
    stream: false,
    output_format: 'url',
    audio_setting: { format: 'mp3', sample_rate: 32000, bitrate: 128000, channel: 1 },
  };
  if (groupId) t2aBody.group_id = groupId;
  const t2aRes = await f(urls.t2a, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(t2aBody),
  });
  const t2aData = await t2aRes.json();
  const t2aStatus = t2aData?.base_resp?.status_code;
  if (typeof t2aStatus === 'number' && t2aStatus !== 0) {
    throw new Error(`T2A failed: ${t2aData?.base_resp?.status_msg || 'unknown'}`);
  }
  const audioRaw = t2aData?.data?.audio;
  if (!audioRaw || typeof audioRaw !== 'string') {
    throw new Error('T2A returned no audio');
  }
  let audioBuffer;
  if (/^https?:\/\//i.test(audioRaw.trim())) {
    const audioRes = await f(audioRaw.trim());
    if (!audioRes.ok) throw new Error(`Audio download failed: HTTP ${audioRes.status}`);
    audioBuffer = Buffer.from(await audioRes.arrayBuffer());
  } else {
    audioBuffer = Buffer.from(audioRaw.trim().replace(/^0x/i, ''), 'hex');
  }
  const boundary = `----BakeVoice${Date.now()}`;
  const multipartBody = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice_sample.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`),
    audioBuffer,
    Buffer.from('\r\n'),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nvoice_clone\r\n`),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
  const uploadRes = await f(urls.upload, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: multipartBody,
  });
  const uploadData = await uploadRes.json();
  const fileId = uploadData?.file?.file_id;
  if (!fileId) {
    throw new Error(`Upload failed: ${uploadData?.base_resp?.status_msg || JSON.stringify(uploadData)}`);
  }
  const cloneRes = await f(urls.clone, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      file_id: fileId,
      voice_id: voiceId,
      model: model || 'speech-2.8-hd',
      text: '你好，这是固定后的声音，听听看效果怎么样？',
      need_noise_reduction: false,
      need_volumn_normalization: true,
    }),
  });
  const cloneData = await cloneRes.json();
  const cloneStatus = cloneData?.base_resp?.status_code;
  if (typeof cloneStatus === 'number' && cloneStatus !== 0) {
    throw new Error(`Clone failed: ${cloneData?.base_resp?.status_msg || JSON.stringify(cloneData)}`);
  }
  return { file_id: fileId, voice_id: voiceId, clone_data: cloneData };
}

async function bakeVoice(req, res, url, deps = {}) {
  const raw = await readBody(req);
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) return sendJson(res, 400, { error: 'Invalid JSON' });
  const body = parsed.body || {};
  const h = req.headers;
  const headerRegion = typeof h['x-minimax-region'] === 'string' ? h['x-minimax-region'] : '';
  try {
    const result = await runBakeVoiceInternal(
      { apiKey: body.apiKey, voiceId: body.voiceId, model: body.model, ttsPayload: body.ttsPayload, groupId: body.groupId, region: body.region, regionHeader: headerRegion },
      deps,
    );
    sendJson(res, 200, { success: true, ...result });
  } catch (e) {
    sendJson(res, 500, { error: e?.message || 'bake-voice failed' });
  }
}
ROUTES['POST /api/minimax/bake-voice'] = bakeVoice;

const FISH_UPSTREAM = 'https://api.fish.audio/v1/tts';
const FISH_DEFAULT_MODEL = 's2.1-pro';

async function fishaudioTts(req, res, url, deps = {}) {
  const f = deps.fetch ?? globalThis.fetch;
  const raw = await readBody(req);
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) return sendJson(res, 400, { error: 'Invalid JSON' });
  const h = req.headers;
  const key = normKey(h.authorization);
  if (!key) return sendJson(res, 400, { error: 'Missing API key. Provide Authorization header.' });
  const headerModel = typeof h.model === 'string' ? h.model.trim() : '';
  const envModel = typeof process.env.FISH_MODEL === 'string' ? process.env.FISH_MODEL.trim() : '';
  const model = headerModel || envModel || FISH_DEFAULT_MODEL;
  const upstream = await f(FISH_UPSTREAM, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, model },
    body: JSON.stringify(parsed.body),
  });
  const contentType = upstream.headers.get('content-type') || 'audio/mpeg';
  if (!upstream.ok) {
    const errText = await upstream.text();
    res.writeHead(upstream.status, { 'Content-Type': contentType.includes('json') ? 'application/json' : 'text/plain' });
    res.end(errText);
    return;
  }
  const buf = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': String(buf.length) });
  res.end(buf);
}
ROUTES['POST /api/fishaudio/tts'] = fishaudioTts;

const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1/text-to-speech';
const DEFAULT_OUTPUT_FORMAT = 'mp3_44100_128';

function normalizeVoiceId(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  return /^[A-Za-z0-9_-]{8,64}$/.test(value) ? value : '';
}

function normalizeOutputFormat(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  return /^[a-z0-9_]{3,32}$/.test(value) ? value : DEFAULT_OUTPUT_FORMAT;
}

async function elevenlabsTts(req, res, url, deps = {}) {
  const f = deps.fetch ?? globalThis.fetch;
  const raw = await readBody(req);
  const h = req.headers;
  const apiKey = String(h['xi-api-key'] || '').trim();
  const voiceId = normalizeVoiceId(url.searchParams.get('voice_id'));
  const outputFormat = normalizeOutputFormat(url.searchParams.get('output_format'));
  if (!apiKey) return sendJson(res, 400, { error: 'Missing API key. Provide xi-api-key header.' });
  if (!voiceId) return sendJson(res, 400, { error: 'Missing or invalid voice_id.' });
  const upstream = await f(
    `${ELEVENLABS_BASE}/${encodeURIComponent(voiceId)}/stream?output_format=${encodeURIComponent(outputFormat)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'audio/mpeg', 'xi-api-key': apiKey },
      body: raw.length ? raw : '{}',
    },
  );
  const contentType = upstream.headers.get('content-type') || 'audio/mpeg';
  if (!upstream.ok) {
    const errorText = await upstream.text();
    res.writeHead(upstream.status, { 'Content-Type': contentType.includes('json') ? 'application/json' : 'text/plain; charset=utf-8' });
    res.end(errorText);
    return;
  }
  const audio = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': String(audio.length) });
  res.end(audio);
}
ROUTES['POST /api/elevenlabs/tts'] = elevenlabsTts;

export function createServer({ port = PORT } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      applyCors(req, res);
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/api/health') {
        sendJson(res, 200, { ok: true });
        return;
      }
      const fn = ROUTES[`${req.method} ${url.pathname}`];
      if (!fn) { sendJson(res, 404, { error: 'Not Found' }); return; }
      await fn(req, res, url);
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Proxy request failed' });
    }
  });
  return new Promise((resolve) => {
    server.listen(port, HOST, () => {
      resolve({ url: `http://${HOST}:${server.address().port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

const isMain = (() => {
  try {
    return !!process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMain) {
  createServer().then(({ url }) => console.log('voice-relay on ' + url));
}
