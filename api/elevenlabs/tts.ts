/**
 * ElevenLabs TTS 代理（Vercel serverless）。
 * Key 由客户端请求头或部署环境变量提供；代理只转发，不记录 Key 与待合成文本。
 */
const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1/text-to-speech';
const DEFAULT_OUTPUT_FORMAT = 'mp3_44100_128';

function setCors(res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,xi-api-key');
}

function normalizeApiKey(raw?: string): string {
  return (raw || '').trim();
}

function normalizeVoiceId(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  return /^[A-Za-z0-9_-]{8,64}$/.test(value) ? value : '';
}

function normalizeOutputFormat(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  return /^[a-z0-9_]{3,32}$/.test(value) ? value : DEFAULT_OUTPUT_FORMAT;
}

export default async function handler(req: any, res: any) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  try {
    const incomingKey = typeof req.headers['xi-api-key'] === 'string' ? req.headers['xi-api-key'] : '';
    const envKey = typeof process.env.ELEVENLABS_API_KEY === 'string' ? process.env.ELEVENLABS_API_KEY : '';
    const apiKey = normalizeApiKey(incomingKey) || normalizeApiKey(envKey);
    const voiceId = normalizeVoiceId(req.query?.voice_id);
    const outputFormat = normalizeOutputFormat(req.query?.output_format);

    if (!apiKey) {
      res.status(400).json({ error: 'Missing API key. Provide xi-api-key or ELEVENLABS_API_KEY.' });
      return;
    }
    if (!voiceId) {
      res.status(400).json({ error: 'Missing or invalid voice_id.' });
      return;
    }

    const upstream = await fetch(
      `${ELEVENLABS_BASE}/${encodeURIComponent(voiceId)}/stream?output_format=${encodeURIComponent(outputFormat)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
          'xi-api-key': apiKey,
        },
        body: typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}),
      },
    );

    const contentType = upstream.headers.get('content-type') || 'audio/mpeg';
    if (!upstream.ok) {
      const errorText = await upstream.text();
      res.status(upstream.status);
      res.setHeader('Content-Type', contentType.includes('json') ? 'application/json' : 'text/plain; charset=utf-8');
      res.send(errorText);
      return;
    }

    const audio = Buffer.from(await upstream.arrayBuffer());
    res.status(200);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', String(audio.length));
    res.send(audio);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'ElevenLabs proxy request failed' });
  }
}
