// store.js — រក្សាទុកការកំណត់ និងប្រវត្តិសន្ទនា ក្នុងទូរសព្ទ (localStorage)
// ទិន្នន័យនៅតែក្នុងទូរសព្ទនេះ មិនផ្ញើទៅកន្លែងណាទេ។

const SETTINGS_KEY = 'khcn.settings.v1';
const HISTORY_KEY = 'khcn.history.v1';
const MAX_HISTORY = 200;

export const GUEST_LANGS = ['zh', 'vi'];            // ភាសាភ្ញៀវ៖ ចិន វៀតណាម
const MESSAGE_LANGS = ['km', ...GUEST_LANGS, 'other']; // 'other' = រូបថតភាសាផ្សេង

export const DEFAULT_SETTINGS = {
  apiKey: '',
  model: 'gemini-3.6-flash',          // ស្តាប់ + បកប្រែ
  ttsModel: 'gemini-3.8-flash-tts',   // បង្កើតសំឡេង
  guest: 'zh',                        // ភាសាភ្ញៀវ៖ 'zh' ចិន | 'vi' វៀតណាម
  kmVoice: 'Kore',                    // សំឡេងខ្មែរ (Gemini)
  guestEngine: 'device',              // សំឡេងភ្ញៀវ៖ 'device' = សំឡេង iPhone, 'gemini' = សំឡេង Gemini
  guestVoice: 'Puck',
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
    // កំណែ ១.២ ចុះក្រោម ហៅសំឡេងភ្ញៀវថា zhEngine / zhVoice
    if (saved.guestEngine === undefined) saved.guestEngine = saved.zhEngine;
    if (saved.guestVoice === undefined) saved.guestVoice = saved.zhVoice;
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (saved[k] !== undefined && typeof saved[k] === typeof DEFAULT_SETTINGS[k]) out[k] = saved[k];
    }
    if (!GUEST_LANGS.includes(out.guest)) out.guest = DEFAULT_SETTINGS.guest;
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
    return list
      .filter(m => m && m.id && m.status === 'done' && MESSAGE_LANGS.includes(m.from))
      .map(m => (GUEST_LANGS.includes(m.guest) ? m : { ...m, guest: 'zh' })); // សារមុនកំណែ ១.៣ ជាសន្ទនាចិន
  } catch {
    return [];
  }
}

const MAX_PHOTO_THUMBS = 30; // រក្សារូបតូចតែ ៣០ រូបចុងក្រោយ (កុំឲ្យពេញអង្គចងចាំ)

export function saveHistory(messages) {
  const done = messages.filter(m => m.status === 'done').slice(-MAX_HISTORY);
  let thumbs = 0;
  const out = [];
  for (let i = done.length - 1; i >= 0; i--) {
    const { id, from, guest, source, target, pinyin, ts, via, status, kind, lines, note, lang } = done[i];
    const item = { id, from, guest, source, target, pinyin, ts, via, status };
    if (kind === 'photo') {
      Object.assign(item, { kind, lines, note, lang, thumb: '' });
      if (done[i].thumb && thumbs < MAX_PHOTO_THUMBS) { item.thumb = done[i].thumb; thumbs += 1; }
    }
    out.unshift(item);
  }
  return write(HISTORY_KEY, JSON.stringify(out));
}
