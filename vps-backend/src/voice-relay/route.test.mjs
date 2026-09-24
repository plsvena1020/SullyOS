// vps-backend/src/voice-relay/route.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from './run.js'; // 本任务导出 createServer({port}) 以便测随机端口

test('unknown api path → 404', async () => {
  const { url, close } = await createServer({ port: 0 });
  const r = await fetch(url + '/api/minimax/music');
  assert.equal(r.status, 404);
  await close();
});

test('OPTIONS preflight carries proxy headers', async () => {
  const { url, close } = await createServer({ port: 0 });
  const r = await fetch(url + '/api/minimax/t2a', {
    method: 'OPTIONS',
    headers: { Origin: 'https://ethernet.bot.cd', 'Access-Control-Request-Headers': 'Authorization, xi-api-key' },
  });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  await close();
});

test('GET /api/health → 200', async () => {
  const { url, close } = await createServer({ port: 0 });
  const r = await fetch(url + '/api/health');
  assert.equal(r.status, 200);
  await close();
});

// Task 2: 7 handler tests (mock upstream via globalThis.fetch; localhost always passthrough).
function stubUpstream(mockFn) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (u, init) => {
    const s = String(u);
    if (s.startsWith('http://127.0.0.1:') || s.startsWith('http://localhost:')) return orig(s, init);
    return mockFn(s, init);
  };
  return () => { globalThis.fetch = orig; };
}

const jsonUpstream = (status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

test('t2a without key → 400 without echo', async () => {
  const { url, close } = await createServer({ port: 0 });
  try {
    const r = await fetch(url + '/api/minimax/t2a', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 400);
    const text = await r.text();
    assert.ok(!text.includes('sk-') && !text.includes('Bearer'));
  } finally { await close(); }
});

test('t2a forwards JSON + group_id, relays status/body', async () => {
  let seen = null;
  const restore = stubUpstream(async (u, init) => {
    seen = { u, init };
    return jsonUpstream(200, { ok: true });
  });
  const { url, close } = await createServer({ port: 0 });
  try {
    const r = await fetch(url + '/api/minimax/t2a', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer K', 'X-MiniMax-Group-Id': 'G1' },
      body: JSON.stringify({ text: 'hi', model: 'speech-02-hd' }),
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
    assert.equal(seen.u, 'https://api.minimaxi.com/v1/t2a_v2');
    assert.equal(seen.init.headers.Authorization, 'Bearer K');
    assert.equal(JSON.parse(seen.init.body).group_id, 'G1');
  } finally { restore(); await close(); }
});

test('voice-clone without key → 400; with key forwards to /v1/voice_clone', async () => {
  const { url, close } = await createServer({ port: 0 });
  try {
    const r0 = await fetch(url + '/api/minimax/voice-clone', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r0.status, 400);
    await r0.text();
    let seen = null;
    const restore = stubUpstream(async (u, init) => { seen = { u, init }; return jsonUpstream(200, { cloned: 1 }); });
    try {
      const r = await fetch(url + '/api/minimax/voice-clone', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer K' },
        body: JSON.stringify({ voice_id: 'v1', file_id: 'f1', model: 'speech-02-hd' }),
      });
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { cloned: 1 });
      assert.equal(seen.u, 'https://api.minimaxi.com/v1/voice_clone');
      assert.equal(seen.init.headers.Authorization, 'Bearer K');
    } finally { restore(); }
  } finally { await close(); }
});

test('upload forwards raw multipart body untouched', async () => {
  const boundary = '----t';
  const rawStr = `--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nfile-test\r\n--${boundary}--\r\n`;
  let seen = null;
  const restore = stubUpstream(async (u, init) => { seen = { u, init }; return jsonUpstream(200, { uploaded: true }); });
  const { url, close } = await createServer({ port: 0 });
  try {
    const r = await fetch(url + '/api/minimax/upload', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, Authorization: 'Bearer K' },
      body: rawStr,
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { uploaded: true });
    assert.equal(seen.u, 'https://api.minimaxi.com/v1/files/upload');
    assert.ok(String(seen.init.headers['Content-Type']).includes(`boundary=${boundary}`));
    assert.ok(Buffer.from(seen.init.body).equals(Buffer.from(rawStr)));
  } finally { restore(); await close(); }
});

test('upload without key → 400', async () => {
  const { url, close } = await createServer({ port: 0 });
  try {
    const r = await fetch(url + '/api/minimax/upload', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
    assert.equal(r.status, 400);
    await r.text();
  } finally { await close(); }
});

test('get-voice forwards JSON to /v1/get_voice', async () => {
  let seen = null;
  const restore = stubUpstream(async (u, init) => { seen = { u, init }; return jsonUpstream(200, { voices: [] }); });
  const { url, close } = await createServer({ port: 0 });
  try {
    const r = await fetch(url + '/api/minimax/get-voice', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer K' },
      body: JSON.stringify({ voice_id: 'v1' }),
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { voices: [] });
    assert.equal(seen.u, 'https://api.minimaxi.com/v1/get_voice');
  } finally { restore(); await close(); }
});

test('fishaudio without key → 400 without echo; default model s2.1-pro', async () => {
  const { url, close } = await createServer({ port: 0 });
  try {
    const r0 = await fetch(url + '/api/fishaudio/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r0.status, 400);
    const t0 = await r0.text();
    assert.ok(!t0.includes('sk-') && !t0.includes('Bearer'));
    let seen = null;
    const restore = stubUpstream(async (u, init) => {
      seen = { u, init };
      return new Response(Buffer.from([1, 2, 3, 4]), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
    });
    try {
      const r = await fetch(url + '/api/fishaudio/tts', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer K' },
        body: JSON.stringify({ text: 'hi' }),
      });
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('content-type'), 'audio/mpeg');
      assert.deepEqual(Array.from(new Uint8Array(await r.arrayBuffer())), [1, 2, 3, 4]);
      assert.equal(seen.u, 'https://api.fish.audio/v1/tts');
      assert.equal(seen.init.headers.model, 's2.1-pro');
      assert.equal(seen.init.headers.Authorization, 'Bearer K');
    } finally { restore(); }
  } finally { await close(); }
});

test('elevenlabs missing voice_id → 400; success forwards key + default format', async () => {
  const { url, close } = await createServer({ port: 0 });
  try {
    const r0 = await fetch(url + '/api/elevenlabs/tts', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'xi-api-key': 'K' }, body: '{}',
    });
    assert.equal(r0.status, 400);
    await r0.text();
    const r0b = await fetch(url + '/api/elevenlabs/tts?voice_id=abc123XYZ_01', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(r0b.status, 400);
    const t0b = await r0b.text();
    assert.ok(!t0b.includes('sk-') && !t0b.includes('Bearer'));
    let seen = null;
    const restore = stubUpstream(async (u, init) => {
      seen = { u, init };
      return new Response(Buffer.from([9, 8, 7]), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
    });
    try {
      const r = await fetch(url + '/api/elevenlabs/tts?voice_id=abc123XYZ_01', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'xi-api-key': 'K' },
        body: JSON.stringify({ text: 'hi' }),
      });
      assert.equal(r.status, 200);
      assert.deepEqual(Array.from(new Uint8Array(await r.arrayBuffer())), [9, 8, 7]);
      assert.ok(seen.u.startsWith('https://api.elevenlabs.io/v1/text-to-speech/abc123XYZ_01/stream'));
      assert.ok(seen.u.includes('output_format=mp3_44100_128'));
      assert.equal(seen.init.headers['xi-api-key'], 'K');
    } finally { restore(); }
  } finally { await close(); }
});

test('bake-voice runs T2A→upload→clone and returns file/voice ids', async () => {
  const calls = [];
  const hexAudio = Buffer.from('fake-audio-bytes').toString('hex');
  const restore = stubUpstream(async (u, init) => {
    calls.push(u);
    if (u.endsWith('/v1/t2a_v2')) return jsonUpstream(200, { base_resp: { status_code: 0 }, data: { audio: hexAudio } });
    if (u.endsWith('/v1/files/upload')) return jsonUpstream(200, { file: { file_id: 'FILE123' } });
    if (u.endsWith('/v1/voice_clone')) return jsonUpstream(200, { base_resp: { status_code: 0 }, ok: true });
    return jsonUpstream(500, { error: 'unexpected upstream' });
  });
  const { url, close } = await createServer({ port: 0 });
  try {
    const r = await fetch(url + '/api/minimax/bake-voice', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'K', voiceId: 'my_voice_01', model: 'speech-2.8-hd', ttsPayload: { voice_setting: { voice_id: 'v1' } } }),
    });
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.success, true);
    assert.equal(data.file_id, 'FILE123');
    assert.equal(data.voice_id, 'my_voice_01');
    assert.deepEqual(calls, [
      'https://api.minimaxi.com/v1/t2a_v2',
      'https://api.minimaxi.com/v1/files/upload',
      'https://api.minimaxi.com/v1/voice_clone',
    ]);
  } finally { restore(); await close(); }
});

test('bake-voice missing apiKey → 500 Missing apiKey', async () => {
  const restore = stubUpstream(async () => jsonUpstream(200, {}));
  const { url, close } = await createServer({ port: 0 });
  try {
    const r = await fetch(url + '/api/minimax/bake-voice', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voiceId: 'v', ttsPayload: {} }),
    });
    assert.equal(r.status, 500);
    const data = await r.json();
    assert.ok(String(data.error).includes('Missing apiKey'));
  } finally { restore(); await close(); }
});
