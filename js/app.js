// app.js — ផ្នែកសំខាន់របស់កម្មវិធី
// ភ្ជាប់ប៊ូតុង → ថតសំឡេង → Gemini បកប្រែ → បង្ហាញ និងអានឲ្យឮ
// អ្នកប្រើនិយាយខ្មែរ (ខាងឆ្វេង) — ភ្ញៀវនិយាយចិន ឬវៀតណាម (ខាងស្តាំ ប្តូរបាននៅខាងលើ)

import { loadSettings, saveSettings, loadHistory, saveHistory, GUEST_LANGS } from './store.js';
import { Recorder } from './recorder.js';
import { translate, translateImage, synthesize, warmUp, VOICES, GeminiError } from './gemini.js';
import { unlockAudio, stopAll, playUrl, audioToUrl, speakDevice, deviceVoiceFor } from './speaker.js';

const VERSION = '1.3.0';
const WAVE_BARS = 22;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ភាសាដែលកម្មវិធីស្គាល់
//   mark = អក្សរក្នុងរង្វង់តូច, glyph = អក្សរធំលើប៊ូតុង, khmer = ឈ្មោះភាសាជាអក្សរខ្មែរ
//   talk/text = ពាក្យដែលបង្ហាញជាភាសារបស់អ្នកនិយាយ
const LANGS = {
  km: {
    mark: 'ខ', glyph: 'ខ', name: 'ខ្មែរ', khmer: 'ខ្មែរ',
    talk: { idle: 'ចុចហើយនិយាយ', starting: 'កំពុងបើកមីក្រូហ្វូន…', listening: 'ចុចដើម្បីបញ្ចប់' },
    text: {
      translating: 'កំពុងបកប្រែ',
      notClear: 'ស្តាប់មិនច្បាស់ទេ។ សូមនិយាយម្តងទៀត។',
      noSound: 'មិនឮសំឡេងទេ។ សូមនិយាយឲ្យជិតមីក្រូហ្វូន។',
      failed: 'មានបញ្ហា។ សូមនិយាយម្តងទៀត។',
      play: 'ស្តាប់',
    },
  },
  zh: {
    mark: '中', glyph: '中', name: '中文', khmer: 'ចិន',
    talk: { idle: '按下说话', starting: '正在打开麦克风…', listening: '再按一次结束' },
    text: {
      translating: '正在翻译',
      notClear: '没听清楚，请再说一次。',
      noSound: '没有听到声音，请再说一次。',
      failed: '出错了，请再试一次。',
      play: '播放',
      hero: '各说各的语言，马上就能沟通',
      howto: '按下说中文，会翻译成高棉语并读出来',
      paneEmpty: '按「中」说中文，会翻译成高棉语。',
      typeHint: 'វាយភាសាខ្មែរ ឬ 中文…',
    },
  },
  vi: {
    mark: 'Vi', glyph: 'Việt', name: 'Tiếng Việt', khmer: 'វៀតណាម',
    talk: { idle: 'Nhấn để nói', starting: 'Đang mở micro…', listening: 'Nhấn lần nữa để dừng' },
    text: {
      translating: 'Đang dịch',
      notClear: 'Nghe chưa rõ, vui lòng nói lại.',
      noSound: 'Không nghe thấy tiếng nói, vui lòng nói lại.',
      failed: 'Có lỗi, vui lòng thử lại.',
      play: 'Nghe',
      hero: 'Mỗi người nói tiếng của mình, hiểu nhau ngay',
      howto: 'Nhấn rồi nói tiếng Việt, ứng dụng dịch sang tiếng Khmer và đọc to.',
      paneEmpty: 'Nhấn “Việt” rồi nói tiếng Việt, ứng dụng sẽ dịch sang tiếng Khmer.',
      typeHint: 'វាយភាសាខ្មែរ ឬ វៀតណាម…',
    },
  },
};

const state = {
  settings: loadSettings(),
  messages: loadHistory(),
  rec: null,            // ការថតដែលកំពុងដំណើរការ { lang, recorder, phase }
  speakingId: null,     // សារដែលកំពុងអាន
  loadingAudioId: null, // សារដែលកំពុងរង់ចាំសំឡេងពី Gemini
};

const audioCache = new Map();   // id សារ → blob URL សំឡេង Gemini (មិនបាច់ហៅម្តងទៀតពេលចុចស្តាប់)
const pendingAudio = new Map(); // id សារ → WAV base64 (សម្រាប់ "សាកម្តងទៀត")
const pendingImage = new Map(); // id សារ → JPEG base64 របស់រូបថត (សម្រាប់ "សាកម្តងទៀត")
let speakToken = 0;
let speakChain = Promise.resolve();

const els = {
  app: $('#app'),
  topbar: $('.topbar'),
  btnGuest: $('#btn-guest'),
  brandGuestMark: $('#brand-guest-mark'),
  brandGuestName: $('#brand-guest-name'),
  glowGuest: $('.glow-guest'),
  chat: $('#chat'),
  face: $('#face'),
  paneGuestWrap: $('.pane-guest'),
  paneGuest: $('#pane-guest'),
  paneKm: $('#pane-km'),
  dock: $('#dock'),
  toast: $('#toast'),
  scrim: $('#scrim'),
  composer: $('#composer'),
  composerText: $('#composer-text'),
  composerDir: $('#composer-dir'),
  settings: $('#settings'),
  guestSheet: $('#guest-sheet'),
  guestList: $('#guest-list'),
  photoInput: $('#photo-input'),
};

// ================= ជំនួយតូចៗ =================

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === '') continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function icon(id) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

function dots() {
  return h('span', { class: 'dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'));
}

// lang="…" សម្រាប់ពុម្ពអក្សរត្រឹមត្រូវ (វៀតណាមប្រើពុម្ពអក្សរ iPhone ដែលមានសញ្ញាគ្រប់)
function langAttr(lang) {
  if (lang === 'km') return 'km';
  if (lang === 'zh') return state.settings.zhScript === 'traditional' ? 'zh-TW' : 'zh-CN';
  if (lang === 'vi') return 'vi';
  return null;
}

// ភាសានៃការបកប្រែ៖ ខ្មែរ → ភាសាភ្ញៀវ, ភាសាផ្សេងទាំងអស់ → ខ្មែរ
function toLang(m) { return m.from === 'km' ? m.guest : 'km'; }

function sideOf(lang) { return lang === 'km' ? 'km' : 'guest'; }

function langName(code) {
  return h('span', { lang: langAttr(code) }, LANGS[code].name);
}

// «ខ្មែរ → Tiếng Việt»
function pairLabel(from, to) {
  const parts = LANGS[from] ? [langName(from), ' → '] : ['→ '];
  parts.push(langName(to));
  return parts;
}

function clock(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isStandalone() {
  return window.navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
}

// អក្សរដែលវាយ៖ មានអក្សរខ្មែរ = អ្នកប្រើ, គ្មាន = ភ្ញៀវ (ចិន វៀតណាម…), null បើគ្មានអក្សរសោះ
function typedSide(text) {
  if (/[ក-៿᧠-᧿]/.test(text)) return 'km';
  return /\p{L}/u.test(text) ? 'guest' : null;
}

let toastTimer = null;
function toast(content, ms = 3800, lang = null) {
  els.toast.replaceChildren(...[].concat(content));
  if (lang) els.toast.setAttribute('lang', lang);
  else els.toast.removeAttribute('lang');
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, ms);
}

function shorten(text, n = 140) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function errorText(err) {
  if (err instanceof GeminiError) {
    switch (err.kind) {
      case 'badkey': return 'API key មិនត្រឹមត្រូវ ឬមិនទាន់ដំណើរការ។ សូមពិនិត្យ key ក្នុងការកំណត់។';
      case 'quota': return 'ប្រើលើសកំណត់ឥតគិតថ្លៃរបស់ Gemini ហើយ។ សូមរង់ចាំបន្តិច រួចសាកម្តងទៀត។';
      case 'busy': return 'Gemini រវល់ខ្លាំងនៅពេលនេះ។ សូមចុច «សាកម្តងទៀត» បន្តិចទៀត។';
      case 'model': return `រកមិនឃើញម៉ូដែល ${err.model}។ សូមប្តូរម៉ូដែលក្នុងការកំណត់។`;
      case 'region': return 'Gemini មិនបម្រើទីតាំងនេះទេ (ចិន ហុងកុង)។ សូមប្រើ roaming ស៊ីមខ្មែរ ឬ eSIM/VPN ដែលចេញតាមសិង្ហបុរី ឬកម្ពុជា។';
      case 'network': return 'មិនអាចភ្ជាប់ទៅ Google Gemini បានទេ។ សូមពិនិត្យអ៊ីនធឺណិត។ បើនៅប្រទេសចិន ត្រូវប្រើ roaming ស៊ីមខ្មែរ ឬ eSIM/VPN។';
      case 'timeout': return 'អ៊ីនធឺណិតយឺតពេក។ សូមសាកម្តងទៀត។';
      case 'parse': return 'ចម្លើយពី Gemini មិនត្រឹមត្រូវ។ សូមសាកម្តងទៀត។';
      case 'noaudio': return 'Gemini មិនបានផ្ញើសំឡេងមកវិញទេ។';
      default: return `Gemini មានបញ្ហា៖ ${shorten(err.message)}`;
    }
  }
  return `មានបញ្ហា៖ ${shorten(err && err.message)}`;
}

function micErrorText(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'សូមអនុញ្ញាតមីក្រូហ្វូន (Allow)។ បើបានបដិសេធរួច៖ Settings → Apps → Safari → Microphone → Allow';
  }
  if (name === 'NotFoundError') return 'រកមិនឃើញមីក្រូហ្វូនទេ។';
  return 'មិនអាចបើកមីក្រូហ្វូនបានទេ។ សូមសាកម្តងទៀត។';
}

// ================= បង្ហាញសារ =================

function render(scrollToEnd = false) {
  renderChat(scrollToEnd);
  if (state.settings.view === 'face') renderFace();
}

function renderChat(scrollToEnd) {
  const el = els.chat;
  const nearEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  const last = state.messages.length - 1;
  const items = state.messages.length
    ? state.messages.map((m, i) => (m.kind === 'photo' ? photoCard(m, i === last) : chatBubble(m, i === last)))
    : [emptyState()];
  el.replaceChildren(...items);
  if (scrollToEnd || nearEnd) el.scrollTop = el.scrollHeight;
}

function emptyState() {
  const g = state.settings.guest;
  const G = LANGS[g];
  const box = h('div', { class: 'empty' },
    h('div', { class: 'hero-mark', 'aria-hidden': 'true' },
      h('span', { 'data-lang': 'km' }, 'ខ'), h('span', { 'data-lang': g, lang: langAttr(g) }, G.mark)),
    h('h2', { class: 'hero-title' }, 'និយាយភាសាខ្លួនឯង', h('br'), 'យល់គ្នាភ្លាមៗ'),
    h('p', { class: 'hero-sub', lang: langAttr(g) }, G.text.hero),
  );
  if (!state.settings.apiKey) {
    const card = h('div', { class: 'setup-card' },
      h('div', { class: 'setup-step' }, h('span', { class: 'setup-num' }, '1'),
        h('div', {}, h('b', {}, 'ដាក់ Gemini API key'), h('p', {}, 'ចម្លង key រួចចុច «បិទភ្ជាប់ key» ក្នុងការកំណត់។ ធ្វើតែម្តងគត់។'))));
    if (isIOS() && !isStandalone()) {
      card.append(h('div', { class: 'setup-step' }, h('span', { class: 'setup-num' }, '2'),
        h('div', {}, h('b', {}, 'ដំឡើងជា App'), h('p', {}, 'ក្នុង Safari ចុច Share រួចជ្រើស «Add to Home Screen»។'))));
    }
    card.append(h('button', { class: 'btn btn-primary', type: 'button', 'data-action': 'open-settings' }, icon('i-paste'), 'ដាក់ API key'));
    box.append(card);
    return box;
  }
  box.append(h('div', { class: 'howto' },
    h('div', { class: 'howto-row' }, h('span', { class: 'g', 'data-lang': 'km', 'aria-hidden': 'true' }, 'ខ'),
      h('span', {}, `ចុច ហើយនិយាយខ្មែរ។ កម្មវិធីបកប្រែជា${G.khmer} ហើយអានឲ្យឮ។`)),
    h('div', { class: 'howto-row', lang: langAttr(g) }, h('span', { class: 'g', 'data-lang': g, 'aria-hidden': 'true' }, G.mark),
      h('span', {}, G.text.howto)),
    h('div', { class: 'howto-row' }, h('span', { class: 'g c', 'aria-hidden': 'true' }, icon('i-camera')),
      h('span', {}, 'ថតរូប ស្លាកតម្លៃ ម៉ឺនុយ ឬផ្លាកសញ្ញា ដើម្បីបកប្រែអក្សរក្នុងរូប។')),
    h('div', { class: 'howto-row' }, h('span', { class: 'g c', 'aria-hidden': 'true' }, icon('i-lang')),
      h('span', {}, 'ប្តូរភាសាភ្ញៀវ (ចិន ឬ វៀតណាម)៖ ចុចឈ្មោះភាសានៅខាងលើ។'))));
  if (isIOS() && !isStandalone()) {
    box.append(h('div', { class: 'tip' }, icon('i-share'),
      h('span', {}, 'ដំឡើងជា App៖ ក្នុង Safari ចុចប៊ូតុង Share រួចជ្រើស «Add to Home Screen»។')));
  }
  return box;
}

function playButton(m, to) {
  return h('button', { type: 'button', class: 'msg-play', 'data-action': 'play', 'data-lang': to, 'aria-label': 'ស្តាប់ការបកប្រែ' }, icon('i-speaker'));
}

function chatBubble(m, isLatest) {
  const to = toLang(m);
  const L = LANGS[m.from] || LANGS.km;
  const classes = ['msg', `msg-${sideOf(m.from)}`];
  if (isLatest) classes.push('is-latest');
  if (m.status === 'pending') classes.push('is-pending');
  if (m.status === 'error') classes.push('is-error');
  if (state.speakingId === m.id) classes.push('is-speaking');
  if (state.loadingAudioId === m.id) classes.push('is-loading-audio');
  const art = h('article', { class: classes.join(' '), 'data-id': m.id, 'data-lang': m.from },
    h('span', { class: 'msg-avatar', 'aria-hidden': 'true', lang: langAttr(m.from) }, L.mark));
  const body = h('div', { class: 'msg-body' });
  art.append(body);
  const pinyin = state.settings.showPinyin && m.pinyin ? h('p', { class: 'msg-pinyin', lang: 'zh-Latn-pinyin' }, m.pinyin) : null;

  if (isLatest && m.status === 'done') body.append(h('p', { class: 'msg-chip' }, pairLabel(m.from, to)));
  body.append(h('p', { class: 'msg-src', lang: langAttr(m.from) }, m.source || '…'));
  if (pinyin && m.from === 'zh' && m.status === 'done') body.append(pinyin);

  if (m.status === 'pending') {
    body.append(
      h('div', { class: 'skeleton', 'aria-hidden': 'true' }, h('i'), h('i')),
      h('p', { class: 'msg-dst', lang: langAttr(m.from) }, L.text.translating, dots()));
    return art;
  }
  if (m.status === 'error') {
    body.append(h('p', { class: 'msg-dst', role: 'alert' }, m.error));
    body.append(h('div', { class: 'msg-actions' },
      h('button', { type: 'button', 'data-action': 'retry' }, icon('i-retry'), 'សាកម្តងទៀត'),
      h('button', { type: 'button', 'data-action': 'delete', 'aria-label': 'លុបសារនេះ' }, icon('i-trash'))));
    return art;
  }
  body.append(h('p', { class: 'msg-dst', lang: langAttr(to) }, m.target));
  if (pinyin && to === 'zh') body.append(pinyin);
  body.append(h('div', { class: 'msg-actions' },
    playButton(m, to),
    h('button', { type: 'button', 'data-action': 'copy', 'aria-label': 'ចម្លងការបកប្រែ' }, icon('i-copy')),
    h('span', { class: 'msg-meta' }, clock(m.ts))));
  return art;
}

// កាតរូបថត៖ រូបតូច + បន្ទាត់អក្សរដើម និងការបកប្រែ
function photoCard(m, isLatest) {
  const to = toLang(m);
  const classes = ['msg', 'msg-photo'];
  if (isLatest) classes.push('is-latest');
  if (m.status === 'pending') classes.push('is-pending');
  if (m.status === 'error') classes.push('is-error');
  if (state.speakingId === m.id) classes.push('is-speaking');
  if (state.loadingAudioId === m.id) classes.push('is-loading-audio');
  const body = h('div', { class: 'msg-body' });
  const art = h('article', { class: classes.join(' '), 'data-id': m.id }, body);

  body.append(h('p', { class: 'msg-chip' }, icon('i-camera'), 'រូបថត', m.status === 'done' ? [' ', pairLabel(m.from, to)] : null));
  if (m.thumb) {
    body.append(h('button', { type: 'button', class: 'photo-thumb', 'data-action': 'zoom', 'aria-label': 'ពង្រីករូប' },
      h('img', { src: m.thumb, alt: 'រូបថតដែលត្រូវបកប្រែ' })));
  }

  if (m.status === 'pending') {
    body.append(
      h('div', { class: 'skeleton', 'aria-hidden': 'true' }, h('i'), h('i')),
      h('p', { class: 'msg-dst' }, 'កំពុងអានអក្សរក្នុងរូប', dots()));
    return art;
  }
  if (m.status === 'error') {
    body.append(h('p', { class: 'msg-dst', role: 'alert' }, m.error));
    body.append(h('div', { class: 'msg-actions' },
      h('button', { type: 'button', 'data-action': 'retry' }, icon('i-retry'), 'សាកម្តងទៀត'),
      h('button', { type: 'button', 'data-action': 'delete', 'aria-label': 'លុបសារនេះ' }, icon('i-trash'))));
    return art;
  }

  if (m.note) body.append(h('p', { class: 'photo-note' }, m.note));
  const lines = Array.isArray(m.lines) ? m.lines : [];
  if (lines.length) {
    const known = LANGS[m.from] ? m.from : null;
    body.append(h('ol', { class: 'photo-lines' }, lines.map(l => h('li', {},
      h('p', { class: 'pl-src', lang: langAttr(m.from), 'data-lang': known }, l.source),
      h('p', { class: 'pl-dst', lang: langAttr(to) }, l.translation),
      state.settings.showPinyin && l.pinyin ? h('p', { class: 'msg-pinyin', lang: 'zh-Latn-pinyin' }, l.pinyin) : null))));
  } else {
    body.append(h('p', { class: 'photo-empty' }, 'រកមិនឃើញអក្សរក្នុងរូបនេះទេ។'));
  }
  body.append(h('div', { class: 'msg-actions' },
    lines.length ? playButton(m, to) : null,
    lines.length ? h('button', { type: 'button', 'data-action': 'copy', 'aria-label': 'ចម្លងការបកប្រែ' }, icon('i-copy')) : null,
    h('span', { class: 'msg-meta' }, clock(m.ts))));
  return art;
}

function renderFace() {
  renderPane(els.paneGuest, state.settings.guest);
  renderPane(els.paneKm, 'km');
}

function paneEmptyText(lang) {
  if (lang === 'km') return `ចុច «ខ» ហើយនិយាយខ្មែរ ដើម្បីបកប្រែជាភាសា${LANGS[state.settings.guest].khmer}។`;
  return LANGS[lang].text.paneEmpty;
}

function renderPane(el, lang) {
  const items = state.messages.map(m => faceItem(m, lang)).filter(Boolean);
  if (!items.length) items.push(h('p', { class: 'pane-empty' }, paneEmptyText(lang)));
  el.replaceChildren(...items);
  el.scrollTop = el.scrollHeight;
}

function facePlay(lang) {
  return h('button', { type: 'button', class: 'fmsg-play', 'data-action': 'play', 'aria-label': LANGS[lang].text.play }, icon('i-speaker'));
}

// ពាក់កណ្តាលអេក្រង់នីមួយៗ៖ ការបកប្រែសម្រាប់អ្នកនៅខាងនោះ (ធំ) និងពាក្យរបស់ខ្លួន (តូច)
function faceItem(m, lang) {
  const forMe = toLang(m) === lang; // ការបកប្រែជាភាសារបស់ខាងនេះ
  const mine = m.from === lang;     // ខាងនេះជាអ្នកនិយាយ ឬថតរូប
  if (!forMe && !mine) return null; // សន្ទនាភាសាផ្សេង (ឧ. ចិន ពេលភ្ញៀវឥឡូវនិយាយវៀតណាម)
  const speaking = state.speakingId === m.id ? ' is-speaking' : '';
  if (m.kind === 'photo') {
    if (m.status !== 'done' || !m.target) return null;
    if (forMe) return h('div', { class: `fmsg fmsg-photo${speaking}`, lang: langAttr(lang), 'data-id': m.id }, m.target, facePlay(lang));
    return h('div', { class: 'fmsg fmsg-mine', lang: langAttr(lang) }, icon('i-camera'), ' ', m.source.split('\n')[0]);
  }
  if (m.status === 'pending') {
    return h('div', { class: mine ? 'fmsg fmsg-mine fmsg-wait' : 'fmsg fmsg-wait' }, mine && m.source ? m.source : '', dots());
  }
  if (m.status === 'error') {
    return mine ? h('div', { class: 'fmsg fmsg-mine' }, LANGS[lang].text.failed) : null;
  }
  if (mine) return h('div', { class: 'fmsg fmsg-mine', lang: langAttr(lang) }, m.source);
  return h('div', { class: `fmsg${speaking}`, lang: langAttr(lang), 'data-id': m.id }, m.target, facePlay(lang));
}

function updateSpeakingUI() {
  $$('[data-id]').forEach(el => {
    el.classList.toggle('is-speaking', el.dataset.id === state.speakingId);
    el.classList.toggle('is-loading-audio', el.dataset.id === state.loadingAudioId);
  });
}

// ================= សារ =================

function newId() {
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function addMessage({ from, via, source = '', ...extra }) {
  const msg = {
    id: newId(), from, requested: from, guest: state.settings.guest, via, source,
    target: '', pinyin: '', ts: Date.now(), status: 'pending', error: '', ...extra,
  };
  state.messages.push(msg);
  render(true);
  return msg;
}

function findMessage(id) { return state.messages.find(m => m.id === id); }

function removeMessage(id) {
  state.messages = state.messages.filter(m => m.id !== id);
  pendingAudio.delete(id);
  pendingImage.delete(id);
  const url = audioCache.get(id);
  if (url) { URL.revokeObjectURL(url); audioCache.delete(id); }
  persist();
  render();
}

function persist() { saveHistory(state.messages); }

async function runTranslation(msg) {
  const s = state.settings;
  const asked = msg.requested || msg.from; // ប៊ូតុងដែលបានចុច
  msg.status = 'pending';
  msg.error = '';
  render(true);
  try {
    const r = await translate({
      apiKey: s.apiKey,
      model: s.model,
      from: asked,
      guest: msg.guest,
      audioBase64: msg.via === 'voice' ? pendingAudio.get(msg.id) : undefined,
      text: msg.via === 'text' ? msg.source : undefined,
      settings: s,
    });
    if (!findMessage(msg.id)) return; // ត្រូវបានលុបពេលរង់ចាំ
    if (r.spoken === 'none' || !r.heard || !r.translation) {
      removeMessage(msg.id);
      toast(LANGS[asked].text.notClear, 3800, langAttr(asked));
      return;
    }
    if (r.spoken === 'km' || r.spoken === msg.guest) msg.from = r.spoken; // ចុចប៊ូតុងខុស ក៏នៅតែត្រូវ
    if (msg.via === 'voice') msg.source = r.heard;
    msg.target = r.translation;
    msg.pinyin = r.pinyin;
    msg.status = 'done';
    pendingAudio.delete(msg.id);
    persist();
    render(true);
    if (s.autoSpeak) queueSpeak(msg);
  } catch (err) {
    if (!findMessage(msg.id)) return;
    msg.status = 'error';
    msg.error = errorText(err);
    render(true);
    if (err instanceof GeminiError && err.kind === 'badkey') toast(msg.error, 6000);
  }
}

// ================= ថតរូបបកប្រែ =================

// បើករូប (ទាំងរូបពី iPhone ដែលបង្វិល) ជារូបដែលគូរលើ canvas បាន
async function loadImage(file) {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* សាកវិធីខាងក្រោម */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// បង្រួមរូប ដើម្បីផ្ញើលឿន (ជ្រុងវែងបំផុត maxSide px)
function toJpeg(source, maxSide, quality) {
  const w = source.naturalWidth || source.width;
  const hgt = source.naturalHeight || source.height;
  const scale = Math.min(1, maxSide / Math.max(w, hgt));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(hgt * scale));
  const g = canvas.getContext('2d');
  g.fillStyle = '#FFFFFF';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

function openPhotoPicker() {
  unlockAudio();
  cancelRecording();
  if (!state.settings.apiKey) {
    toast('សូមដាក់ Gemini API key ជាមុនសិន។');
    openSettings(true);
    return;
  }
  els.photoInput.value = '';
  els.photoInput.click();
}

async function onPhotoChosen() {
  const file = els.photoInput.files && els.photoInput.files[0];
  if (!file) return;
  stopSpeaking();
  let full;
  let thumb;
  try {
    const source = await loadImage(file);
    full = toJpeg(source, 1600, 0.82);
    thumb = toJpeg(source, 360, 0.7);
    if (source.close) source.close();
  } catch {
    toast('មិនអាចបើករូបនេះបានទេ។ សូមសាករូបផ្សេង។');
    return;
  }
  const msg = addMessage({ from: 'other', via: 'photo', kind: 'photo', thumb, lines: [], note: '', lang: '' });
  pendingImage.set(msg.id, full.slice(full.indexOf(',') + 1));
  runPhoto(msg);
}

async function runPhoto(msg) {
  const s = state.settings;
  msg.status = 'pending';
  msg.error = '';
  render(true);
  try {
    const r = await translateImage({ apiKey: s.apiKey, model: s.model, imageBase64: pendingImage.get(msg.id), guest: s.guest, settings: s });
    if (!findMessage(msg.id)) return;
    msg.guest = s.guest;                            // អក្សរខ្មែរក្នុងរូប បកប្រែជាភាសាភ្ញៀវនេះ
    msg.lang = r.lang;
    msg.from = LANGS[r.lang] ? r.lang : 'other';    // ភាសាដើមនៃអក្សរក្នុងរូប
    msg.lines = r.lines;
    msg.note = r.note;
    msg.source = r.lines.map(l => l.source).join('\n');
    msg.target = r.lines.map(l => l.translation).join('\n');
    msg.status = 'done';
    pendingImage.delete(msg.id);
    persist();
    render(true);
  } catch (err) {
    if (!findMessage(msg.id)) return;
    msg.status = 'error';
    msg.error = errorText(err);
    render(true);
    if (err instanceof GeminiError && err.kind === 'badkey') toast(msg.error, 6000);
  }
}

// ================= ការអានឲ្យឮ =================

function useDeviceVoice(lang) {
  if (!('speechSynthesis' in window)) return false;
  if (lang === 'km') return !!deviceVoiceFor('km'); // iPhone បច្ចុប្បន្នគ្មានសំឡេងខ្មែរ → ប្រើ Gemini
  if (state.settings.guestEngine !== 'device') return false;
  // iPhone ពេលខ្លះផ្ទុកបញ្ជីសំឡេងយឺត — បើបញ្ជីនៅទទេ ប្រើសំឡេងដើមរបស់ iPhone
  return !!deviceVoiceFor(lang) || speechSynthesis.getVoices().length === 0;
}

function stopSpeaking() {
  speakToken += 1;
  stopAll();
  state.speakingId = null;
  state.loadingAudioId = null;
  updateSpeakingUI();
}

function queueSpeak(msg) {
  const token = speakToken;
  speakChain = speakChain
    .then(() => (token === speakToken ? speakMessage(msg, token) : null))
    .catch(() => {});
}

async function speakMessage(msg, token = speakToken) {
  const s = state.settings;
  const lang = toLang(msg); // ភាសានៃការបកប្រែ
  const text = msg.target.length > 900 ? `${msg.target.slice(0, 900)}…` : msg.target; // រូបថតវែង៖ អានតែផ្នែកដើម
  if (!text) return;
  try {
    if (useDeviceVoice(lang)) {
      state.speakingId = msg.id;
      updateSpeakingUI();
      try {
        await speakDevice(text, lang, s.rate);
        return;
      } catch {
        if (token !== speakToken) return;
        // សំឡេងក្នុងទូរសព្ទមិនដំណើរការ → ប្រើសំឡេង Gemini ជំនួស
        state.speakingId = null;
      }
    }
    let url = audioCache.get(msg.id);
    if (!url) {
      state.loadingAudioId = msg.id;
      updateSpeakingUI();
      const audio = await synthesize({ apiKey: s.apiKey, model: s.ttsModel, text, voice: lang === 'km' ? s.kmVoice : s.guestVoice });
      url = audioToUrl(audio.data, audio.mimeType, audio.sampleRate);
      audioCache.set(msg.id, url);
      if (state.loadingAudioId === msg.id) state.loadingAudioId = null;
      if (token !== speakToken || !findMessage(msg.id)) return; // អ្នកប្រើបានចាប់ផ្តើមអ្វីផ្សេង
    }
    state.speakingId = msg.id;
    updateSpeakingUI();
    await playUrl(url);
  } catch (err) {
    if (err && err.name === 'NotAllowedError') toast('ចុចរូប 🔊 ដើម្បីស្តាប់។');
    else if (err instanceof GeminiError && err.kind === 'quota') toast('សំឡេងអានប្រើអស់កំណត់ឥតគិតថ្លៃសម្រាប់ពេលនេះ — សូមអានអក្សរជំនួស។', 5000);
    else if (err instanceof GeminiError && err.kind === 'busy') toast('សំឡេងអាន Gemini រវល់ — សូមចុចរូប 🔊 ម្តងទៀតបន្តិចទៀត។', 5000);
    else if (err instanceof GeminiError) toast(errorText(err), 5000);
    else if (token === speakToken) toast('មិនអាចចាក់សំឡេងបានទេ។');
  } finally {
    if (state.speakingId === msg.id) state.speakingId = null;
    if (state.loadingAudioId === msg.id) state.loadingAudioId = null;
    updateSpeakingUI();
  }
}

// ================= មីក្រូហ្វូន =================

const levels = new Array(WAVE_BARS).fill(0); // កម្រិតសំឡេងថ្មីៗ សម្រាប់គូររលក
let talkTimer = null;

function setTalkState(lang, phase) {
  $$('.talk').forEach(btn => {
    const mine = lang && btn.dataset.lang === lang;
    const p = mine ? phase : 'idle';
    btn.dataset.state = p;
    btn.disabled = !!lang && !mine;
    const hint = $('.talk-hint', btn);
    if (hint) hint.textContent = LANGS[btn.dataset.lang].talk[p];
    btn.setAttribute('aria-pressed', p === 'listening' ? 'true' : 'false');
    const wave = $('.wave', btn);
    if (mine && wave && wave.childElementCount !== WAVE_BARS) {
      wave.replaceChildren(...Array.from({ length: WAVE_BARS }, () => h('i')));
    }
  });

  // ប៊ូតុងដែលកំពុងស្តាប់ពង្រីកធំ ហើយពន្លឺពណ៌នៅខាងក្រោយភ្លឺតាមសំឡេង
  const root = document.documentElement;
  if (lang) els.dock.dataset.active = lang;
  else delete els.dock.dataset.active;
  if (lang && phase === 'listening') root.dataset.listening = sideOf(lang);
  else delete root.dataset.listening;
  root.style.setProperty('--level', '0');
  levels.fill(0);
  paintWave(lang);

  clearInterval(talkTimer);
  if (lang && phase === 'listening') {
    const started = Date.now();
    const tick = () => {
      const s = Math.floor((Date.now() - started) / 1000);
      const text = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      $$(`.talk[data-lang="${lang}"] .talk-time`).forEach(t => { t.textContent = text; });
    };
    tick();
    talkTimer = setInterval(tick, 500);
  }
}

// គូររលកសំឡេង៖ កណ្តាល = សំឡេងថ្មីបំផុត, គែម = សំឡេងមុនៗ
function paintWave(lang) {
  if (!lang) return;
  const half = (WAVE_BARS - 1) / 2;
  $$(`.talk[data-lang="${lang}"] .wave`).forEach(wave => {
    const bars = wave.children;
    for (let i = 0; i < bars.length; i++) {
      const d = Math.abs(i - half) / half;
      const value = levels[WAVE_BARS - 1 - Math.round(d * (WAVE_BARS - 1))] || 0;
      bars[i].style.transform = `scaleY(${(0.12 + value * 0.88 * (1 - d * 0.35)).toFixed(3)})`;
    }
  });
}

function setLevel(lang, level) {
  levels.push(level);
  levels.shift();
  document.documentElement.style.setProperty('--level', level.toFixed(3));
  paintWave(lang);
}

async function onTalk(lang) {
  unlockAudio();
  if (state.rec) {
    if (state.rec.lang === lang && state.rec.phase === 'listening') finishRecording();
    return;
  }
  if (!state.settings.apiKey) {
    toast('សូមដាក់ Gemini API key ជាមុនសិន។');
    openSettings(true);
    return;
  }
  if (!Recorder.isSupported()) {
    const secure = window.isSecureContext;
    toast(secure ? 'កម្មវិធីរុករកនេះមិនអាចថតសំឡេងបានទេ។' : 'ត្រូវបើកកម្មវិធីតាម https:// ទើបប្រើមីក្រូហ្វូនបាន។', 6000);
    return;
  }
  stopSpeaking();
  const recorder = new Recorder({
    autoStop: state.settings.autoStop,
    onLevel: (lv) => setLevel(lang, lv),
    onAutoStop: () => { if (state.rec && state.rec.recorder === recorder) finishRecording(); },
  });
  state.rec = { lang, recorder, phase: 'starting', watchdog: null };
  setTalkState(lang, 'starting');
  warmUp(state.settings.apiKey); // បើកការតភ្ជាប់ទៅ Google ខណៈពេលអ្នកកំពុងនិយាយ
  try {
    await recorder.start();
  } catch (err) {
    if (state.rec && state.rec.recorder === recorder) state.rec = null;
    setTalkState(null);
    toast(micErrorText(err), 6500);
    return;
  }
  if (!state.rec || state.rec.recorder !== recorder) { recorder.cancel(); return; }
  state.rec.phase = 'listening';
  setTalkState(lang, 'listening');
  // បើមីក្រូហ្វូនមិនផ្ញើសំឡេងសោះ (iPhone ខ្លះ) — បោះបង់ ហើយប្រាប់ឲ្យចុចម្តងទៀត
  state.rec.watchdog = setTimeout(() => {
    if (state.rec && state.rec.recorder === recorder && recorder.elapsedMs === 0) {
      cancelRecording();
      toast('មីក្រូហ្វូនមិនទាន់ដំណើរការ។ សូមចុចម្តងទៀត។');
    }
  }, 2000);
}

function finishRecording() {
  const rec = state.rec;
  if (!rec || rec.phase !== 'listening') return;
  clearTimeout(rec.watchdog);
  state.rec = null;
  setTalkState(null);
  const clip = rec.recorder.stop();
  if (!clip || !clip.heard || clip.seconds < 0.35) {
    toast(LANGS[rec.lang].text.noSound, 3800, langAttr(rec.lang));
    return;
  }
  const msg = addMessage({ from: rec.lang, via: 'voice' });
  pendingAudio.set(msg.id, clip.base64);
  runTranslation(msg);
}

function cancelRecording() {
  const rec = state.rec;
  if (!rec) return;
  clearTimeout(rec.watchdog);
  state.rec = null;
  rec.recorder.cancel();
  setTalkState(null);
}

// ================= សកម្មភាពលើសារ =================

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { readonly: true, style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
  }
  toast('បានចម្លង');
}

function onMessageAction(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === 'open-settings') { openSettings(true); return; }
  const holder = btn.closest('[data-id]');
  const msg = holder && findMessage(holder.dataset.id);
  if (!msg) return;
  unlockAudio();
  if (action === 'play') {
    if (state.speakingId === msg.id || state.loadingAudioId === msg.id) { stopSpeaking(); return; }
    stopSpeaking();
    speakMessage(msg, speakToken);
  } else if (action === 'copy') {
    copyText(msg.target);
  } else if (action === 'retry') {
    if (msg.kind === 'photo') {
      if (!pendingImage.has(msg.id)) {
        removeMessage(msg.id);
        toast('សូមថតរូបម្តងទៀត។');
        return;
      }
      runPhoto(msg);
      return;
    }
    if (msg.via === 'voice' && !pendingAudio.has(msg.id)) {
      removeMessage(msg.id);
      toast('សូមនិយាយម្តងទៀត។');
      return;
    }
    runTranslation(msg);
  } else if (action === 'zoom') {
    btn.classList.toggle('is-open');
  } else if (action === 'delete') {
    removeMessage(msg.id);
  }
}

// ================= របៀបបង្ហាញ =================

function applyView() {
  const face = state.settings.view === 'face';
  els.app.dataset.view = face ? 'face' : 'chat';
  els.topbar.hidden = face;
  els.chat.hidden = face;
  els.dock.hidden = face;
  els.face.hidden = !face;
  render(true);
}

function setView(view) {
  cancelRecording();
  state.settings.view = view;
  saveSettings(state.settings);
  applyView();
}

// ================= ភាសាភ្ញៀវ (ចិន ឬ វៀតណាម) =================

// ប្តូរប៊ូតុង ពណ៌ និងអក្សរខាងភ្ញៀវ តាមភាសាដែលបានជ្រើស
function applyGuest() {
  const g = state.settings.guest;
  const L = LANGS[g];
  const attr = langAttr(g);
  $$('.talk-guest').forEach((btn) => {
    btn.dataset.lang = g;
    btn.setAttribute('lang', attr);
    $('.talk-glyph', btn).textContent = L.glyph;
    $('.talk-name', btn).textContent = L.name;
    $('.talk-hint', btn).textContent = L.talk.idle;
  });
  for (const el of [els.paneGuestWrap, els.brandGuestMark, els.brandGuestName]) {
    el.dataset.lang = g;
    el.setAttribute('lang', attr);
  }
  els.brandGuestMark.textContent = L.mark;
  els.brandGuestName.textContent = L.name;
  els.glowGuest.dataset.lang = g;
  els.btnGuest.setAttribute('aria-label', `ភាសាភ្ញៀវ៖ ${L.name} — ចុចដើម្បីប្តូរ`);
  els.composerText.placeholder = L.text.typeHint;
  document.title = `បកប្រែ ខ្មែរ ⇄ ${L.name}`;
  render();
}

function openGuestPicker() {
  cancelRecording();
  const current = state.settings.guest;
  els.guestList.replaceChildren(...GUEST_LANGS.map((code) => {
    const L = LANGS[code];
    const on = code === current;
    return h('button', { type: 'button', class: 'row lang-opt', 'data-guest': code, 'data-lang': code, 'aria-pressed': on ? 'true' : 'false' },
      h('span', { class: 'lang-mark', lang: langAttr(code), 'aria-hidden': 'true' }, L.mark),
      h('span', { class: 'lang-text' }, h('b', { lang: langAttr(code) }, L.name), h('small', {}, `ភាសា${L.khmer}`)),
      on ? icon('i-check') : null);
  }));
  els.scrim.hidden = false;
  els.guestSheet.hidden = false;
}

function setGuest(code) {
  closeSheets();
  if (!GUEST_LANGS.includes(code) || code === state.settings.guest) return;
  stopSpeaking();
  update({ guest: code });
  applyGuest();
  toast(['ភ្ញៀវនិយាយ ', langName(code)]);
}

// ================= វាយអក្សរ =================

function openComposer() {
  cancelRecording();
  els.scrim.hidden = false;
  els.composer.hidden = false;
  updateComposerDir();
  els.composerText.focus();
}

function closeSheets() {
  els.scrim.hidden = true;
  els.composer.hidden = true;
  els.settings.hidden = true;
  els.guestSheet.hidden = true;
}

function typedFrom(text) {
  return typedSide(text) === 'guest' ? state.settings.guest : 'km';
}

function updateComposerDir() {
  const from = typedFrom(els.composerText.value);
  els.composerDir.replaceChildren(...pairLabel(from, from === 'km' ? state.settings.guest : 'km'));
}

function sendTyped() {
  const text = els.composerText.value.trim();
  if (!text) { els.composerText.focus(); return; }
  if (!state.settings.apiKey) { closeSheets(); openSettings(true); return; }
  unlockAudio();
  stopSpeaking();
  els.composerText.value = '';
  closeSheets();
  const msg = addMessage({ from: typedFrom(text), via: 'text', source: text });
  runTranslation(msg);
}

// ================= ការកំណត់ =================

const F = {
  key: $('#set-key'),
  keyShow: $('#btn-key-show'),
  keyPaste: $('#btn-key-paste'),
  keyTest: $('#btn-key-test'),
  keyResult: $('#key-result'),
  autospeak: $('#set-autospeak'),
  kmVoice: $('#set-kmvoice'),
  guestEngine: $('#set-guestengine'),
  guestVoice: $('#set-guestvoice'),
  guestVoiceRow: $('#row-guestvoice'),
  rate: $('#set-rate'),
  zhScript: $$('input[name="zhscript"]'),
  pinyin: $('#set-pinyin'),
  context: $('#set-context'),
  autostop: $('#set-autostop'),
  model: $('#set-model'),
  ttsModel: $('#set-ttsmodel'),
  clear: $('#btn-clear'),
  version: $('#app-version'),
};

function fillVoiceSelect(select) {
  select.replaceChildren(...VOICES.map(v => h('option', { value: v.id }, v.label)));
}

function ensureOption(select, value) {
  if (value && ![...select.options].some(o => o.value === value)) select.append(h('option', { value }, value));
  select.value = value;
}

function loadSettingsForm() {
  const s = state.settings;
  F.key.value = s.apiKey;
  F.autospeak.checked = s.autoSpeak;
  ensureOption(F.kmVoice, s.kmVoice);
  F.guestEngine.value = s.guestEngine;
  ensureOption(F.guestVoice, s.guestVoice);
  F.guestVoiceRow.hidden = s.guestEngine !== 'gemini';
  F.rate.value = String(s.rate);
  F.zhScript.forEach(r => { r.checked = r.value === s.zhScript; });
  F.pinyin.checked = s.showPinyin;
  F.context.value = s.context;
  F.autostop.checked = s.autoStop;
  ensureOption(F.model, s.model);
  ensureOption(F.ttsModel, s.ttsModel);
  F.version.textContent = `កំណែ ${VERSION}`;
}

function update(patch, { clearAudio = false, rerender = false } = {}) {
  Object.assign(state.settings, patch);
  saveSettings(state.settings);
  if (clearAudio) {
    audioCache.forEach(url => URL.revokeObjectURL(url));
    audioCache.clear();
  }
  if (rerender) render();
}

function openSettings(focusKey = false) {
  cancelRecording();
  loadSettingsForm();
  F.keyResult.textContent = '';
  F.keyResult.className = 'key-result';
  els.scrim.hidden = false;
  els.settings.hidden = false;
  if (focusKey && !state.settings.apiKey) F.key.focus();
}

function bindSettings() {
  fillVoiceSelect(F.kmVoice);
  fillVoiceSelect(F.guestVoice);

  F.key.addEventListener('input', () => {
    update({ apiKey: F.key.value.trim() });
    F.keyResult.textContent = '';
  });
  F.key.addEventListener('change', () => render());
  F.keyShow.addEventListener('click', () => {
    const show = F.key.type === 'password';
    F.key.type = show ? 'text' : 'password';
    F.keyShow.textContent = show ? 'លាក់' : 'បង្ហាញ';
  });
  F.keyPaste.addEventListener('click', pasteKey);
  F.keyTest.addEventListener('click', testKey);
  F.autospeak.addEventListener('change', () => update({ autoSpeak: F.autospeak.checked }));
  F.kmVoice.addEventListener('change', () => update({ kmVoice: F.kmVoice.value }, { clearAudio: true }));
  F.guestEngine.addEventListener('change', () => {
    update({ guestEngine: F.guestEngine.value }, { clearAudio: true });
    F.guestVoiceRow.hidden = F.guestEngine.value !== 'gemini';
  });
  F.guestVoice.addEventListener('change', () => update({ guestVoice: F.guestVoice.value }, { clearAudio: true }));
  F.rate.addEventListener('change', () => update({ rate: Number(F.rate.value) || 1 }));
  F.zhScript.forEach(r => r.addEventListener('change', () => { if (r.checked) update({ zhScript: r.value }, { rerender: true }); }));
  F.pinyin.addEventListener('change', () => update({ showPinyin: F.pinyin.checked }, { rerender: true }));
  F.context.addEventListener('input', () => update({ context: F.context.value }));
  F.autostop.addEventListener('change', () => update({ autoStop: F.autostop.checked }));
  F.model.addEventListener('change', () => update({ model: F.model.value }));
  F.ttsModel.addEventListener('change', () => update({ ttsModel: F.ttsModel.value }, { clearAudio: true }));

  let armTimer = null;
  F.clear.addEventListener('click', () => {
    if (!F.clear.classList.contains('is-armed')) {
      F.clear.classList.add('is-armed');
      $('span', F.clear).textContent = 'ចុចម្តងទៀតដើម្បីលុប';
      armTimer = setTimeout(disarm, 3500);
      return;
    }
    disarm();
    stopSpeaking();
    state.messages = [];
    pendingAudio.clear();
    pendingImage.clear();
    audioCache.forEach(url => URL.revokeObjectURL(url));
    audioCache.clear();
    persist();
    render();
    toast('បានលុបប្រវត្តិទាំងអស់');
  });
  function disarm() {
    clearTimeout(armTimer);
    F.clear.classList.remove('is-armed');
    $('span', F.clear).textContent = 'លុបប្រវត្តិទាំងអស់';
  }
}

// បិទភ្ជាប់ key ពី clipboard ហើយសាកល្បងភ្លាម
async function pasteKey() {
  let text = '';
  try { text = (await navigator.clipboard.readText()) || ''; } catch { text = ''; }
  text = text.replace(/^[\s`'"]+|[\s`'"]+$/g, '');
  if (!text) {
    F.key.focus();
    toast('ចុចឲ្យយូរលើប្រអប់ key ហើយជ្រើស Paste');
    return;
  }
  F.key.value = text;
  update({ apiKey: text });
  testKey();
}

async function testKey() {
  const key = F.key.value.trim();
  F.keyResult.className = 'key-result';
  if (!key) { F.keyResult.textContent = 'សូមបិទភ្ជាប់ key ជាមុនសិន។'; F.keyResult.classList.add('bad'); return; }
  update({ apiKey: key });
  F.keyTest.disabled = true;
  F.keyResult.textContent = 'កំពុងសាកល្បង…';
  const guest = state.settings.guest;
  try {
    const r = await translate({ apiKey: key, model: state.settings.model, from: 'km', guest, text: 'សួស្តី', settings: state.settings });
    F.keyResult.replaceChildren('ដំណើរការល្អ៖ សួស្តី → ', h('span', { lang: langAttr(guest) }, r.translation || '?'), ` (${r.model})`);
    F.keyResult.classList.add('ok');
    render();
  } catch (err) {
    if (err instanceof GeminiError && err.kind === 'busy') {
      F.keyResult.textContent = 'Key ត្រឹមត្រូវ ប៉ុន្តែ Gemini កំពុងរវល់ខ្លាំង។ សូមសាកម្តងទៀតបន្តិចទៀត។';
    } else {
      F.keyResult.textContent = errorText(err);
      F.keyResult.classList.add('bad');
    }
    render();
  } finally {
    F.keyTest.disabled = false;
  }
}

// ================= ចាប់ផ្តើម =================

function init() {
  $$('.talk').forEach(btn => btn.addEventListener('click', () => onTalk(btn.dataset.lang)));
  $('#btn-type').addEventListener('click', openComposer);
  $('#btn-photo').addEventListener('click', openPhotoPicker);
  els.photoInput.addEventListener('change', onPhotoChosen);
  els.btnGuest.addEventListener('click', openGuestPicker);
  els.guestList.addEventListener('click', (e) => {
    const opt = e.target.closest('[data-guest]');
    if (opt) setGuest(opt.dataset.guest);
  });
  $('#btn-face').addEventListener('click', () => setView('face'));
  $('#btn-face-exit').addEventListener('click', () => setView('chat'));
  $('#btn-settings').addEventListener('click', () => openSettings(false));
  els.scrim.addEventListener('click', closeSheets);
  $$('[data-close]').forEach(b => b.addEventListener('click', closeSheets));
  els.chat.addEventListener('click', onMessageAction);
  els.face.addEventListener('click', onMessageAction);

  els.composerText.addEventListener('input', updateComposerDir);
  els.composerText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      sendTyped();
    }
  });
  $('#composer-send').addEventListener('click', sendTyped);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheets(); });

  // iPhone៖ បើកសោសំឡេងពេលប៉ះអេក្រង់លើកដំបូង
  document.addEventListener('touchend', unlockAudio, { once: true, passive: true });
  document.addEventListener('click', unlockAudio, { once: true });

  // ចេញពី App ពេលកំពុងថត → បោះបង់
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { cancelRecording(); stopSpeaking(); }
  });

  // iPhone៖ រុញផ្ទាំងវាយអក្សរឡើងពីលើក្តារចុច
  if (window.visualViewport) {
    const vv = window.visualViewport;
    const fit = () => {
      const keyboard = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      els.composer.style.bottom = keyboard > 40 ? `${Math.round(keyboard)}px` : '';
    };
    vv.addEventListener('resize', fit);
    vv.addEventListener('scroll', fit);
  }

  bindSettings();
  applyGuest();
  applyView();

  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* ដំណើរការបានដោយគ្មាន offline */ });
  }
}

init();
