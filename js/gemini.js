// gemini.js — ហៅ Gemini API របស់ Google (Interactions API)
//   1) ស្តាប់សំឡេង + បកប្រែ ក្នុងការហៅតែម្តង
//   2) បកប្រែអក្សរដែលវាយ
//   3) បង្កើតសំឡេងអាន (text-to-speech) — សំខាន់សម្រាប់ភាសាខ្មែរ ព្រោះ iPhone គ្មានសំឡេងខ្មែរ
//
// ពេល Google មានអ្នកប្រើច្រើន ម៉ូដែលខ្លះឆ្លើយយឺត ឬបដិសេធ (503)។ ដូច្នេះ៖
//   - បើម៉ូដែលទីមួយយឺតពេក កម្មវិធីចាប់ផ្តើមម៉ូដែលទីពីរស្របគ្នា ហើយយកចម្លើយណាមកមុន
//   - បើម៉ូដែលណាបដិសេធ ប្តូរទៅម៉ូដែលបន្ទាប់ភ្លាម
//   - ចងចាំម៉ូដែលដែលដំណើរការចុងក្រោយ ហើយសាកវាមុនគេនៅលើកក្រោយ

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';

export const TRANSLATE_MODELS = ['gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-flash-latest'];
export const TTS_MODELS = ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts', 'gemini-3.1-flash-tts-preview'];

export const VOICES = [
  { id: 'Kore', label: 'Kore (ស្រី ច្បាស់)' },
  { id: 'Aoede', label: 'Aoede (ស្រី ស្រាល)' },
  { id: 'Leda', label: 'Leda (ស្រី ក្មេង)' },
  { id: 'Sulafat', label: 'Sulafat (ស្រី កក់ក្តៅ)' },
  { id: 'Puck', label: 'Puck (ប្រុស រស់រវើក)' },
  { id: 'Charon', label: 'Charon (ប្រុស ស្ងប់)' },
  { id: 'Orus', label: 'Orus (ប្រុស មាំ)' },
  { id: 'Achird', label: 'Achird (ប្រុស រួសរាយ)' },
];

export class GeminiError extends Error {
  constructor(kind, message, { status = 0, model = '' } = {}) {
    super(message);
    this.name = 'GeminiError';
    this.kind = kind;      // badkey | quota | model | region | network | timeout | badrequest | server | parse | noaudio | aborted
    this.status = status;
    this.model = model;
    this.daily = false;
  }
}

// ម៉ូដែលខ្លះមិនទទួល thinking_level "minimal" (កម្មវិធីរៀនបន្ថែមដោយខ្លួនឯង)
const thinkingFor = new Map([['gemini-3.8-flash', 'low'], ['gemini-flash-latest', 'low']]);
const cooldownUntil = new Map(); // ម៉ូដែលដែលទើបបដិសេធ — សាកក្រោយគេមួយរយៈ
const FATAL = new Set(['badkey', 'region', 'network']);
const MAX_PARALLEL = 3;
const NEXT_HEDGE_MS = 2500;

// ម៉ូដែលដែលដំណើរការចុងក្រោយ (ចងចាំក្នុងទូរសព្ទ ២ ម៉ោង) — សាកវាមុនគេពេលបើក App លើកក្រោយ
const LAST_GOOD_KEY = 'khcn.lastgood.v1';
const lastGood = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(LAST_GOOD_KEY) || '{}');
    const fresh = (x) => (x && x.model && Date.now() - x.t < 2 * 3600e3 ? x.model : null);
    return { translate: fresh(saved.translate), tts: fresh(saved.tts) };
  } catch {
    return { translate: null, tts: null };
  }
})();

function rememberGood(kind, model) {
  lastGood[kind] = model;
  try {
    const saved = JSON.parse(localStorage.getItem(LAST_GOOD_KEY) || '{}');
    saved[kind] = model ? { model, t: Date.now() } : null;
    localStorage.setItem(LAST_GOOD_KEY, JSON.stringify(saved));
  } catch { /* រក្សាទុកមិនបាន — មិនអីទេ */ }
}

function orderModels(kind, primary, defaults) {
  const list = [lastGood[kind], primary, ...defaults].filter((m, i, a) => m && a.indexOf(m) === i);
  const now = Date.now();
  const ready = list.filter(m => !(cooldownUntil.get(m) > now));
  const cooling = list.filter(m => cooldownUntil.get(m) > now);
  return [...ready, ...cooling];
}

function toError(status, data, model) {
  const err = (data && (data.error || data)) || {};
  const message = String(err.message || err.status || err.code || `HTTP ${status}`);
  const text = (message + ' ' + JSON.stringify(err.details || '') + ' ' + String(err.code || '')).toLowerCase();
  let kind;
  if (status === 429) kind = 'quota';
  else if (status === 404) kind = 'model';
  else if (/user location is not supported|location is not supported|not available in your country/.test(text)) kind = 'region';
  else if (status === 403 && /model/.test(text) && !/api key|api_key/.test(text)) kind = 'model';
  else if (status === 401 || status === 403 || (status === 400 && /api key|api_key/.test(text))) kind = 'badkey';
  else if (status === 400 || status === 422) kind = 'badrequest';
  else if (status === 503 || /high demand|overloaded|service_unavailable/.test(text)) kind = 'busy';
  else kind = 'server';
  const e = new GeminiError(kind, message, { status, model });
  e.daily = /per ?day|perday|daily|rpd/.test(text);
  return e;
}

// ការហៅមួយដង (មានកំណត់ពេល និងអាចបោះបង់ពីខាងក្រៅ)
async function post(apiKey, body, timeoutMs, outerSignal) {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
  const onOuterAbort = () => ctrl.abort();
  if (outerSignal) {
    if (outerSignal.aborted) ctrl.abort();
    else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
  }
  const abortedError = () => (timedOut
    ? new GeminiError('timeout', 'Request timed out', { model: body.model })
    : new GeminiError('aborted', 'Cancelled', { model: body.model }));
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
      if (err && err.name === 'AbortError') throw abortedError();
      throw new GeminiError('network', (err && err.message) || 'Network error', { model: body.model });
    }
    let data = null;
    try { data = await res.json(); } catch (err) {
      if (err && err.name === 'AbortError') throw abortedError();
    }
    if (!res.ok) throw toError(res.status, data, body.model);
    if (!data) throw new GeminiError('parse', 'Empty response', { model: body.model });
    return data;
  } finally {
    clearTimeout(timer);
    if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort);
  }
}

// ហៅម្តង + បន្តបើ Gemini ប្រាប់ថា "requires_continuation" (ចម្លើយវែង)
async function interact(apiKey, body, timeoutMs, signal) {
  const hops = [await post(apiKey, body, timeoutMs, signal)];
  for (let i = 0; i < 3; i++) {
    const last = hops[hops.length - 1];
    const token = last && last.status === 'requires_continuation' && last.continuation_token;
    if (!token) break;
    hops.push(await post(apiKey, { ...body, continuation_token: token }, timeoutMs, signal));
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

// សាកម៉ូដែលមួយ៖ បើវាមិនទទួល thinking_level ដែលផ្ញើ សាកម្តងទៀតជាមួយ "low" ហើយបើនៅតែមិនបាន ផ្ញើដោយគ្មានជម្រើសបន្ថែម
async function tryModel(apiKey, model, buildBody, timeoutMs, signal) {
  let level = thinkingFor.get(model) || 'minimal';
  for (;;) {
    try {
      return await interact(apiKey, buildBody(model, level), timeoutMs, signal);
    } catch (err) {
      if (!(err instanceof GeminiError) || err.kind !== 'badrequest' || level === null) throw err;
      if (/thinking/i.test(err.message) && level !== 'low') {
        level = 'low';
        thinkingFor.set(model, 'low');
      } else {
        level = null;
      }
    }
  }
}

function moreUseful(a, b) {
  if (!a) return b;
  const rank = { quota: 5, busy: 4, model: 3, badrequest: 2, server: 1, timeout: 1, parse: 1 };
  return (rank[b.kind] || 0) >= (rank[a.kind] || 0) ? b : a;
}

// សាកម៉ូដែលជាបន្តបន្ទាប់ ហើយបើយឺត ចាប់ផ្តើមម៉ូដែលបន្ទាប់ស្របគ្នា — យកចម្លើយដែលជោគជ័យមុនគេ
// startParallel = ចំនួនម៉ូដែលដែលចាប់ផ្តើមព្រមគ្នាតាំងពីដំបូង (លឿនជាង តែប្រើ quota ច្រើនជាង)
function runHedged(kind, apiKey, models, buildBody, { hedgeMs, timeoutMs, accept, startParallel = 1 }) {
  return new Promise((resolve, reject) => {
    const outer = new AbortController();
    let next = 0;
    let running = 0;
    let done = false;
    let lastError = null;
    let hedgeTimer = null;

    const finish = (ok, value) => {
      if (done) return;
      done = true;
      clearTimeout(hedgeTimer);
      outer.abort(); // បញ្ឈប់ការហៅផ្សេងទៀតដែលនៅរង់ចាំ
      ok ? resolve(value) : reject(value);
    };
    const armHedge = () => {
      clearTimeout(hedgeTimer);
      if (next >= models.length) return;
      hedgeTimer = setTimeout(() => {
        if (running < MAX_PARALLEL) launch();
        else armHedge();
      }, next === 1 ? hedgeMs : NEXT_HEDGE_MS);
    };
    const launch = () => {
      if (done || next >= models.length) return;
      const model = models[next++];
      running += 1;
      armHedge();
      tryModel(apiKey, model, buildBody, timeoutMs, outer.signal).then((result) => {
        running -= 1;
        if (done) return;
        let value;
        try { value = accept(result, model); } catch (err) { onFail(model, err); return; }
        if (lastGood[kind] !== model) rememberGood(kind, model);
        cooldownUntil.delete(model);
        finish(true, value);
      }, (err) => {
        running -= 1;
        onFail(model, err);
      });
    };
    const onFail = (model, err) => {
      if (done) return;
      if (!(err instanceof GeminiError)) { finish(false, err); return; }
      if (err.kind === 'aborted') return;
      if (FATAL.has(err.kind)) { finish(false, err); return; }
      if (err.kind === 'quota') cooldownUntil.set(model, Date.now() + (err.daily ? 3 * 3600e3 : 60e3));
      else if (err.kind === 'model') cooldownUntil.set(model, Date.now() + 24 * 3600e3);
      else if (err.kind === 'busy') cooldownUntil.set(model, Date.now() + 45e3);
      else cooldownUntil.set(model, Date.now() + 90e3);
      if (lastGood[kind] === model) rememberGood(kind, null);
      lastError = moreUseful(lastError, err);
      if (next < models.length) launch();
      else if (running === 0) finish(false, lastError || new GeminiError('server', 'No model available'));
    };
    for (let i = 0; i < Math.min(startParallel, MAX_PARALLEL); i++) launch();
  });
}

// បើកការតភ្ជាប់ទៅ Google ជាមុន ពេលអ្នកប្រើកំពុងនិយាយ ដើម្បីឲ្យការផ្ញើសំឡេងលឿនជាង
let lastWarm = 0;
export function warmUp(apiKey) {
  if (!apiKey || Date.now() - lastWarm < 3 * 60e3) return;
  lastWarm = Date.now();
  fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', {
    headers: { 'x-goog-api-key': apiKey },
    cache: 'no-store',
  }).catch(() => { lastWarm = 0; });
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
    '- Khmer text: standard Khmer Unicode script, natural spoken Khmer as used in Cambodia today. Do not put spaces between Khmer words; use a space only where Khmer normally has one (between phrases or around numbers and foreign words).',
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

/**
 * បកប្រែសំឡេង (audioBase64) ឬអក្សរ (text)
 * from: 'km' | 'zh' — ប៊ូតុងដែលបានចុច
 * ត្រឡប់៖ { spoken, heard, translation, pinyin, model }
 */
export function translate({ apiKey, model, from, audioBase64, text, settings }) {
  const system = systemPrompt(settings);
  const input = [{ type: 'text', text: audioBase64 ? audioTask(from) : textTask(from, text) }];
  if (audioBase64) input.push({ type: 'audio', data: audioBase64, mime_type: 'audio/wav' });
  const buildBody = (m, thinking) => {
    const body = {
      model: m,
      system_instruction: system,
      input,
      response_format: { type: 'text', mime_type: 'application/json', schema: SCHEMA },
    };
    if (thinking) {
      body.generation_config = { thinking_level: thinking };
      body.store = false; // កុំឲ្យ Google រក្សាទុកសន្ទនានេះ
    }
    return body;
  };
  const accept = (result, used) => {
    const data = parseJson(outputText(result));
    if (!data || typeof data !== 'object') throw new GeminiError('parse', 'Could not read the answer', { model: used });
    const clean = (v) => (typeof v === 'string' ? v.trim() : '');
    let spoken = clean(data.spoken).toLowerCase();
    if (!['km', 'zh', 'other', 'none'].includes(spoken)) spoken = clean(data.heard) ? from : 'none';
    return { spoken, heard: clean(data.heard), translation: clean(data.translation), pinyin: clean(data.pinyin), model: used };
  };
  // ចាប់ផ្តើមម៉ូដែលពីរព្រមគ្នា ហើយបន្ថែមទីបីបើទាំងពីរយឺតជាង ២.៥ វិនាទី
  return runHedged('translate', apiKey, orderModels('translate', model, TRANSLATE_MODELS), buildBody, {
    startParallel: 2,
    hedgeMs: 2500,
    timeoutMs: 25000,
    accept,
  });
}

// ---------- បកប្រែអក្សរក្នុងរូបថត ----------

const IMAGE_SCHEMA = {
  type: 'object',
  properties: {
    lang: { type: 'string', enum: ['zh', 'km', 'other', 'none'] },
    lines: {
      type: 'array',
      maxItems: 80,
      items: {
        type: 'object',
        properties: { source: { type: 'string' }, translation: { type: 'string' }, pinyin: { type: 'string' } },
        required: ['source', 'translation', 'pinyin'],
      },
    },
    note: { type: 'string' },
  },
  required: ['lang', 'lines', 'note'],
};

function imageTask(zhScript) {
  const script = zhScript === 'traditional' ? 'Traditional' : 'Simplified';
  return [
    'Read all the text in this photo (signs, menus, labels, price tags, receipts, screenshots, handwriting).',
    `- If the text is Chinese, translate it into Khmer. If it is Khmer, translate it into Mandarin Chinese (${script} characters). Text in any other language: translate it into Khmer.`,
    '- Keep the reading order. Put words that belong together on one line (for example a product with its price).',
    '- Keep numbers, prices, sizes and units exactly as written, using Western digits and the currency sign (for example ¥25/件 becomes ¥25/ដុំ).',
    '- "lang": the main language of the text: "zh", "km", "other", or "none" if there is no readable text.',
    '- "lines": every line with "source" (the original text), "translation", and "pinyin" (Hanyu Pinyin with tone marks for the Chinese side of that line, empty if there is no Chinese).',
    '- "note": one short Khmer sentence saying what this is (for example "តារាងតម្លៃសម្លៀកបំពាក់លក់ដុំ"). If there is no text, describe the photo briefly in Khmer.',
    'Return only the JSON object.',
  ].join('\n');
}

/**
 * អានអក្សរក្នុងរូប ហើយបកប្រែ
 * ត្រឡប់៖ { lang, lines: [{ source, translation, pinyin }], note, model }
 */
export function translateImage({ apiKey, model, imageBase64, mimeType = 'image/jpeg', settings }) {
  const system = systemPrompt(settings);
  const input = [
    { type: 'text', text: imageTask(settings.zhScript) },
    { type: 'image', data: imageBase64, mime_type: mimeType, resolution: 'high' },
  ];
  const buildBody = (m, thinking) => {
    const body = {
      model: m,
      system_instruction: system,
      input,
      response_format: { type: 'text', mime_type: 'application/json', schema: IMAGE_SCHEMA },
    };
    if (thinking) {
      body.generation_config = { thinking_level: thinking };
      body.store = false;
    }
    return body;
  };
  const accept = (result, used) => {
    const data = parseJson(outputText(result));
    if (!data || typeof data !== 'object') throw new GeminiError('parse', 'Could not read the answer', { model: used });
    const clean = (v) => (typeof v === 'string' ? v.trim() : '');
    let lang = clean(data.lang).toLowerCase();
    if (!['zh', 'km', 'other', 'none'].includes(lang)) lang = 'other';
    const lines = (Array.isArray(data.lines) ? data.lines : [])
      .map(l => ({ source: clean(l && l.source), translation: clean(l && l.translation), pinyin: clean(l && l.pinyin) }))
      .filter(l => l.source || l.translation)
      .slice(0, 80);
    return { lang, lines, note: clean(data.note), model: used };
  };
  return runHedged('translate', apiKey, orderModels('translate', model, TRANSLATE_MODELS), buildBody, {
    startParallel: 2,
    hedgeMs: 4000,
    timeoutMs: 45000,
    accept,
  });
}

/**
 * បង្កើតសំឡេងអាន
 * ត្រឡប់៖ { data (base64), mimeType, sampleRate, model }
 */
export function synthesize({ apiKey, model, text, voice }) {
  const buildBody = (m, thinking) => {
    const body = {
      model: m,
      input: [{ type: 'text', text }],
      response_format: { type: 'audio', mime_type: 'audio/wav' },
      generation_config: { speech_config: [{ voice: voice || 'Kore' }] },
      store: false,
    };
    if (thinking === null) { delete body.store; body.response_format = { type: 'audio' }; }
    return body;
  };
  const accept = (result, used) => {
    const audio = outputAudio(result);
    if (!audio) throw new GeminiError('noaudio', 'No audio in the answer', { model: used });
    return { data: audio.data, mimeType: audio.mime_type || 'audio/wav', sampleRate: audio.sample_rate || 24000, model: used };
  };
  return runHedged('tts', apiKey, orderModels('tts', model, TTS_MODELS), buildBody, {
    hedgeMs: 4500,
    timeoutMs: 35000,
    accept,
  });
}
