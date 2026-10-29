// gemini.js — ហៅ Gemini API របស់ Google (Interactions API)
//   1) ស្តាប់សំឡេង + បកប្រែ ក្នុងការហៅតែម្តង
//   2) បកប្រែអក្សរដែលវាយ
//   3) បង្កើតសំឡេងអាន (text-to-speech) — សំខាន់សម្រាប់ភាសាខ្មែរ ព្រោះ iPhone គ្មានសំឡេងខ្មែរ

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';

// បើម៉ូដែលទីមួយអស់កំណត់ឥតគិតថ្លៃ (429) ឬរកមិនឃើញ (404) នឹងសាកម៉ូដែលបន្ទាប់
export const TRANSLATE_MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-flash-latest'];
export const TTS_MODELS = ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts', 'gemini-3.1-flash-tts-preview'];

export const VOICES = [
  { id: 'Kore', label: 'Kore — ស្រី ច្បាស់' },
  { id: 'Aoede', label: 'Aoede — ស្រី ស្រាល' },
  { id: 'Leda', label: 'Leda — ស្រី ក្មេង' },
  { id: 'Sulafat', label: 'Sulafat — ស្រី កក់ក្តៅ' },
  { id: 'Puck', label: 'Puck — ប្រុស រស់រវើក' },
  { id: 'Charon', label: 'Charon — ប្រុស ស្ងប់' },
  { id: 'Orus', label: 'Orus — ប្រុស មាំ' },
  { id: 'Achird', label: 'Achird — ប្រុស រួសរាយ' },
];

export class GeminiError extends Error {
  constructor(kind, message, { status = 0, model = '' } = {}) {
    super(message);
    this.name = 'GeminiError';
    this.kind = kind;      // badkey | quota | model | region | network | timeout | badrequest | server | parse | noaudio
    this.status = status;
    this.model = model;
    this.daily = false;
  }
}

// ម៉ូដែលដែលទើបតែប្រើអស់កំណត់ — រំលងមួយរយៈ
const cooldownUntil = new Map();

function modelChain(primary, all) {
  const list = [primary, ...all].filter((m, i, a) => m && a.indexOf(m) === i);
  const now = Date.now();
  const ready = list.filter(m => !(cooldownUntil.get(m) > now));
  return ready.length ? ready : list;
}

function toError(status, data, model) {
  const err = (data && (data.error || data)) || {};
  const message = String(err.message || err.status || `HTTP ${status}`);
  const text = (message + ' ' + JSON.stringify(err.details || '')).toLowerCase();
  let kind;
  if (status === 429) kind = 'quota';
  else if (status === 404) kind = 'model';
  else if (/user location is not supported|location is not supported|not available in your country/.test(text)) kind = 'region';
  else if (status === 403 && /model/.test(text) && !/api key|api_key/.test(text)) kind = 'model';
  else if (status === 401 || status === 403 || (status === 400 && /api key|api_key/.test(text))) kind = 'badkey';
  else if (status === 400 || status === 422) kind = 'badrequest';
  else kind = 'server';
  const e = new GeminiError(kind, message, { status, model });
  e.daily = /per ?day|perday|daily|rpd/.test(text);
  return e;
}

async function post(apiKey, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      if (err && err.name === 'AbortError') throw new GeminiError('timeout', 'Request timed out', { model: body.model });
      throw new GeminiError('network', (err && err.message) || 'Network error', { model: body.model });
    }
    let data = null;
    try { data = await res.json(); } catch (err) {
      if (err && err.name === 'AbortError') throw new GeminiError('timeout', 'Request timed out', { model: body.model });
    }
    if (!res.ok) throw toError(res.status, data, body.model);
    if (!data) throw new GeminiError('parse', 'Empty response', { model: body.model });
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// ហៅម្តង + បន្តបើ Gemini ប្រាប់ថា "requires_continuation" (ចម្លើយវែង)
async function interact(apiKey, body, timeoutMs) {
  const hops = [await post(apiKey, body, timeoutMs)];
  for (let i = 0; i < 3; i++) {
    const last = hops[hops.length - 1];
    const token = last && last.status === 'requires_continuation' && last.continuation_token;
    if (!token) break;
    hops.push(await post(apiKey, { ...body, continuation_token: token }, timeoutMs));
  }
  const final = hops[hops.length - 1];
  if (final.status === 'failed') {
    const msg = (final.errors && final.errors[0] && final.errors[0].message) || 'Generation failed';
    throw new GeminiError('server', msg, { model: body.model });
  }
  const steps = [];
  hops.forEach((hop, index) => {
    let s = Array.isArray(hop.steps) ? hop.steps : [];
    if (index > 0) { let k = 0; while (k < s.length && s[k] && s[k].type === 'user_input') k++; s = s.slice(k); }
    steps.push(...s);
  });
  return { ...final, steps };
}

// សាកម៉ូដែលម្តងមួយៗ រហូតដល់ជោគជ័យ
async function withModels(apiKey, primary, fallbacks, body, { simplify, timeoutMs = 45000 } = {}) {
  let lastError = null;
  for (const model of modelChain(primary, fallbacks)) {
    const attempt = { ...body, model };
    try {
      return { result: await interact(apiKey, attempt, timeoutMs), model };
    } catch (err) {
      let e = err;
      if (!(e instanceof GeminiError)) throw e;
      if (e.kind === 'badrequest' && simplify) {
        // សាកម្តងទៀតដោយគ្មានជម្រើសបន្ថែម (ម៉ូដែលខ្លះមិនស្គាល់)
        try { return { result: await interact(apiKey, simplify(attempt), timeoutMs), model }; }
        catch (e2) { if (!(e2 instanceof GeminiError)) throw e2; e = e2; }
      }
      if (e.kind === 'quota') cooldownUntil.set(model, Date.now() + (e.daily ? 3 * 3600e3 : 60e3));
      if (e.kind === 'quota' || e.kind === 'model' || e.kind === 'badrequest' || (e.kind === 'server' && e.status >= 500)) {
        lastError = e;
        continue;
      }
      throw e; // key ខុស, គ្មានអ៊ីនធឺណិត ... — ឈប់ភ្លាម
    }
  }
  throw lastError || new GeminiError('server', 'No model available');
}

// យកលទ្ធផល (អត្ថបទ ឬសំឡេង) ពីចម្លើយ — តាមរបៀបដូច SDK ផ្លូវការ
function outputContents(interaction) {
  const steps = Array.isArray(interaction.steps) ? interaction.steps : [];
  let start = 0;
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i] && steps[i].type === 'user_input') { start = i + 1; break; }
  }
  const contents = [];
  for (const s of steps.slice(start)) {
    if (s && s.type === 'model_output' && Array.isArray(s.content)) contents.push(...s.content);
  }
  if (!contents.length && Array.isArray(interaction.outputs)) contents.push(...interaction.outputs);
  return contents.filter(Boolean);
}

export function outputText(interaction) {
  return outputContents(interaction).filter(c => c.type === 'text' && typeof c.text === 'string').map(c => c.text).join('');
}

export function outputAudio(interaction) {
  const list = outputContents(interaction).filter(c => c.type === 'audio' && c.data);
  return list.length ? list[list.length - 1] : null;
}

function parseJson(text) {
  if (!text) return null;
  const tries = [text, text.replace(/^```(?:json)?\s*|\s*```$/g, '')];
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a >= 0 && b > a) tries.push(text.slice(a, b + 1));
  for (const t of tries) { try { return JSON.parse(t); } catch { /* try next */ } }
  return null;
}

// ---------- ការណែនាំសម្រាប់ Gemini ----------

const LANG = { km: 'Khmer', zh: 'Mandarin Chinese' };

const SCHEMA = {
  type: 'object',
  properties: {
    spoken: { type: 'string', enum: ['km', 'zh', 'other', 'none'] },
    heard: { type: 'string' },
    translation: { type: 'string' },
    pinyin: { type: 'string' },
  },
  required: ['spoken', 'heard', 'translation', 'pinyin'],
};

function systemPrompt({ zhScript, context }) {
  const script = zhScript === 'traditional' ? 'Traditional' : 'Simplified';
  const lines = [
    'You are a professional interpreter between Khmer (Cambodia) and Mandarin Chinese. Two people are talking face to face through a phone app: one speaks Khmer, the other speaks Mandarin.',
    'Rules:',
    '- Interpret only. Never answer questions, add comments, greetings, or explanations. If the speaker asks a question, translate the question.',
    '- Keep the meaning, tone and politeness of the speaker. Use natural everyday spoken language that a native speaker would really say, not word-for-word translation.',
    '- Keep names, numbers, prices, quantities, dates, units and brand names accurate. Write numbers with digits.',
    '- Khmer text: standard Khmer Unicode script, natural spoken Khmer as used in Cambodia today.',
    `- Chinese text: Mandarin written in ${script} Chinese characters.`,
    '- "pinyin": Hanyu Pinyin with tone marks for the Chinese sentence of this turn (the transcription if Chinese was spoken, otherwise the translation), with spaces between words. Empty string if there is no Chinese.',
    'Return only the JSON object.',
  ];
  if (context && context.trim()) lines.push(`Conversation context (use it to choose the right words): ${context.trim().slice(0, 500)}`);
  return lines.join('\n');
}

function audioTask(from) {
  const to = from === 'km' ? 'zh' : 'km';
  return [
    `This recording comes from the ${LANG[from]} speaker's button, so the speaker most likely speaks ${LANG[from]}.`,
    `1. "spoken": which language is actually spoken — "km" (Khmer), "zh" (Chinese), "other" (another language), or "none" if there is no clear speech (silence, noise, or unintelligible).`,
    '2. "heard": transcribe exactly what was said, in the script of the spoken language. Empty if "none".',
    `3. "translation": interpret it into ${LANG[to]}. Exception: if the speaker actually spoke ${LANG[to]}, interpret it into ${LANG[from]} instead. Empty if "none".`,
    '4. "pinyin": as described in the rules.',
  ].join('\n');
}

function textTask(from, text) {
  const to = from === 'km' ? 'zh' : 'km';
  return [
    `The ${LANG[from]} speaker typed the text below.`,
    `Set "spoken" to the language of the text ("km", "zh" or "other"), "heard" to the text unchanged, and "translation" to its interpretation into ${LANG[to]} (or into ${LANG[from]} if the text is already ${LANG[to]}).`,
    'Text:',
    '"""',
    text,
    '"""',
  ].join('\n');
}

function dropExtras(body) {
  const copy = { ...body };
  delete copy.store;
  delete copy.generation_config;
  return copy;
}

/**
 * បកប្រែសំឡេង (audioBase64) ឬអក្សរ (text)
 * from: 'km' | 'zh' — ប៊ូតុងដែលបានចុច
 * ត្រឡប់៖ { spoken, heard, translation, pinyin, model }
 */
export async function translate({ apiKey, model, from, audioBase64, text, settings }) {
  const input = [{ type: 'text', text: audioBase64 ? audioTask(from) : textTask(from, text) }];
  if (audioBase64) input.push({ type: 'audio', data: audioBase64, mime_type: 'audio/wav' });
  const body = {
    model,
    system_instruction: systemPrompt(settings),
    input,
    generation_config: { thinking_level: 'minimal' },
    response_format: { type: 'text', mime_type: 'application/json', schema: SCHEMA },
    store: false, // កុំឲ្យ Google រក្សាទុកសន្ទនានេះ
  };
  const { result, model: used } = await withModels(apiKey, model, TRANSLATE_MODELS, body, { simplify: dropExtras, timeoutMs: 45000 });
  const data = parseJson(outputText(result));
  if (!data || typeof data !== 'object') throw new GeminiError('parse', 'Could not read the answer', { model: used });
  const clean = (v) => (typeof v === 'string' ? v.trim() : '');
  let spoken = clean(data.spoken).toLowerCase();
  if (!['km', 'zh', 'other', 'none'].includes(spoken)) spoken = clean(data.heard) ? from : 'none';
  return {
    spoken,
    heard: clean(data.heard),
    translation: clean(data.translation),
    pinyin: clean(data.pinyin),
    model: used,
  };
}

/**
 * បង្កើតសំឡេងអាន
 * ត្រឡប់៖ { data (base64), mimeType, sampleRate, model }
 */
export async function synthesize({ apiKey, model, text, voice }) {
  const body = {
    model,
    input: [{ type: 'text', text }],
    response_format: { type: 'audio', mime_type: 'audio/wav' },
    generation_config: { speech_config: [{ voice: voice || 'Kore' }] },
    store: false,
  };
  const simplify = (b) => { const c = { ...b }; delete c.store; c.response_format = { type: 'audio' }; return c; };
  const { result, model: used } = await withModels(apiKey, model, TTS_MODELS, body, { simplify, timeoutMs: 60000 });
  const audio = outputAudio(result);
  if (!audio) throw new GeminiError('noaudio', 'No audio in the answer', { model: used });
  return { data: audio.data, mimeType: audio.mime_type || 'audio/wav', sampleRate: audio.sample_rate || 24000, model: used };
}
