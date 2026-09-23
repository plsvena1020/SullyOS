// worker/sullyos-home/src/speak.ts
export async function speakFallback(trySpeak: () => Promise<string>) {
  try {
    const url = await trySpeak();
    return { audioUrl: url, fallback: false };
  } catch {
    return { audioUrl: null, fallback: true };
  }
}
