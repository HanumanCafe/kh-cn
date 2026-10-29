// store.js — រក្សាទុកការកំណត់ និងប្រវត្តិសន្ទនា ក្នុងទូរសព្ទ (localStorage)
// ទិន្នន័យនៅតែក្នុងទូរសព្ទនេះ មិនផ្ញើទៅកន្លែងណាទេ។

const SETTINGS_KEY = 'khcn.settings.v1';
const HISTORY_KEY = 'khcn.history.v1';
const MAX_HISTORY = 200;

export const DEFAULT_SETTINGS = {
  apiKey: '',
  model: 'gemini-3.8-flash',          // ស្តាប់ + បកប្រែ
  ttsModel: 'gemini-3.8-flash-tts',   // បង្កើតសំឡេង
  kmVoice: 'Kore',                    // សំឡេងខ្មែរ (Gemini)
  zhEngine: 'device',                 // 'device' = សំឡេង iPhone, 'gemini' = សំឡេង Gemini
  zhVoice: 'Puck',
  rate: 1,                            // ល្បឿនសំឡេង iPhone
  autoSpeak: true,
  autoStop: true,
  showPinyin: true,
  zhScript: 'simplified',             // 'simplified' | 'traditional'
  context: '',
  view: 'chat',                       // 'chat' | 'face'
};

function read(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}

export function loadSettings() {
  const out = { ...DEFAULT_SETTINGS };
  try {
    const saved = JSON.parse(read(SETTINGS_KEY) || '{}');
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (saved[k] !== undefined && typeof saved[k] === typeof DEFAULT_SETTINGS[k]) out[k] = saved[k];
    }
  } catch { /* ការកំណត់ខូច — ប្រើតម្លៃដើម */ }
  return out;
}

export function saveSettings(settings) {
  return write(SETTINGS_KEY, JSON.stringify(settings));
}

export function loadHistory() {
  try {
    const list = JSON.parse(read(HISTORY_KEY) || '[]');
    if (!Array.isArray(list)) return [];
    // យកតែសារដែលបកប្រែរួច (សារកំពុងរង់ចាំ ឬខូច មិនរក្សាទុកទេ)
    return list.filter(m => m && m.id && m.status === 'done' && (m.from === 'km' || m.from === 'zh'));
  } catch {
    return [];
  }
}

export function saveHistory(messages) {
  const done = messages
    .filter(m => m.status === 'done')
    .slice(-MAX_HISTORY)
    .map(({ id, from, source, target, pinyin, ts, via, status }) => ({ id, from, source, target, pinyin, ts, via, status }));
  return write(HISTORY_KEY, JSON.stringify(done));
}
