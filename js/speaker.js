// speaker.js — ចាក់សំឡេងចេញ៖ សំឡេង Gemini (ឯកសារ WAV) ឬ សំឡេងដែលមានស្រាប់ក្នុង iPhone
import { setAudioSession, encodeWav } from './recorder.js';

let player = null;     // <audio> តែមួយ ប្រើឡើងវិញ (iPhone អនុញ្ញាតបន្ទាប់ពី "unlock")
let unlocked = false;
let current = null;    // សំឡេងដែលកំពុងចាក់

function getPlayer() {
  if (!player) {
    player = new Audio();
    player.setAttribute('playsinline', '');
    player.preload = 'auto';
  }
  return player;
}

// iPhone មិនឲ្យចាក់សំឡេងទេ លុះត្រាតែអ្នកប្រើបានចុចអ្វីមួយម្តង។
// ហៅមុខងារនេះពេលចុចលើកដំបូង ដើម្បី "បើកសោ" សំឡេង។
export function unlockAudio() {
  if (unlocked) return;
  unlocked = true;
  const p = getPlayer();
  try {
    const silent = encodeWav(new Float32Array(800), 16000);
    p.src = URL.createObjectURL(new Blob([silent], { type: 'audio/wav' }));
    const r = p.play();
    if (r && r.catch) r.catch(() => { unlocked = false; });
  } catch { unlocked = false; }
  try {
    if ('speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      window.speechSynthesis.speak(u);
    }
  } catch { /* ignore */ }
}

export function stopAll() {
  if (current) {
    const c = current;
    current = null;
    c.stop();
  }
  try { if ('speechSynthesis' in window && (speechSynthesis.speaking || speechSynthesis.pending)) speechSynthesis.cancel(); } catch { /* ignore */ }
}

export function isPlaying() { return !!current; }

// ចាក់ឯកសារសំឡេង (blob URL)
export function playUrl(url) {
  stopAll();
  setAudioSession('playback');
  const p = getPlayer();
  return new Promise((resolve, reject) => {
    let settled = false;
    let guard = null;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      p.removeEventListener('ended', onEnd);
      p.removeEventListener('error', onErr);
      if (current === handle) current = null;
      err ? reject(err) : resolve();
    };
    const onEnd = () => finish();
    const onErr = () => finish(new Error('audio-error'));
    const handle = { stop: () => { try { p.pause(); } catch { /* ignore */ } finish(); } };
    current = handle;
    p.addEventListener('ended', onEnd);
    p.addEventListener('error', onErr);
    p.src = url;
    try { p.currentTime = 0; } catch { /* ignore */ }
    const r = p.play();
    const armGuard = () => {
      // ការពារករណី iPhone មិនផ្ញើ "ended"
      const seconds = Number.isFinite(p.duration) && p.duration > 0 ? p.duration : 30;
      guard = setTimeout(() => finish(), seconds * 1000 + 2500);
    };
    if (r && r.then) r.then(armGuard, err => finish(err));
    else armGuard();
  });
}

// បំលែង base64 ពី Gemini ទៅជា blob URL ដែលចាក់បាន
export function audioToUrl(base64, mimeType = 'audio/wav', sampleRate = 24000) {
  const bin = atob(base64);
  let bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const mime = (mimeType || '').toLowerCase();
  // ប្រសិនបើ Gemini ផ្ញើ PCM ទទេ (audio/l16) យើងបន្ថែម header WAV ខ្លួនឯង
  if (mime.includes('l16') || mime.includes('pcm')) {
    const rateMatch = /rate=(\d+)/.exec(mime);
    const rate = rateMatch ? Number(rateMatch[1]) : (sampleRate || 24000);
    const samples = new Float32Array(Math.floor(bytes.length / 2));
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 0x8000;
    bytes = encodeWav(samples, rate);
    return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
  }
  return URL.createObjectURL(new Blob([bytes], { type: mime || 'audio/wav' }));
}

// ---------- សំឡេងក្នុង iPhone (speechSynthesis) ----------

function voices() {
  try { return window.speechSynthesis ? speechSynthesis.getVoices() || [] : []; } catch { return []; }
}
if ('speechSynthesis' in window) {
  try { speechSynthesis.getVoices(); speechSynthesis.addEventListener('voiceschanged', () => {}); } catch { /* ignore */ }
}

function norm(lang) { return String(lang || '').toLowerCase().replace('_', '-'); }

const SPEECH_TAG = { km: 'km-KH', zh: 'zh-CN', vi: 'vi-VN' };

// រកសំឡេងល្អបំផុតសម្រាប់ភាសា ('km', 'zh' ឬ 'vi') — null បើគ្មាន
export function deviceVoiceFor(lang) {
  const all = voices();
  let list;
  if (lang === 'zh') {
    list = all.filter(v => norm(v.lang).startsWith('zh-cn') || norm(v.lang) === 'zh' || norm(v.lang).startsWith('cmn'));
    if (!list.length) list = all.filter(v => norm(v.lang).startsWith('zh-tw'));
  } else {
    list = all.filter(v => norm(v.lang) === lang || norm(v.lang).startsWith(`${lang}-`));
  }
  if (!list.length) return null;
  const prefer = [/premium/i, /enhanced/i, /tingting|婷婷|lili|yu-?shu|li-?mu|xiaoxiao|yaoyao|linh/i];
  for (const re of prefer) {
    const v = list.find(x => re.test(x.name) || re.test(x.voiceURI || ''));
    if (v) return v;
  }
  return list.find(v => v.localService) || list[0];
}

export function speakDevice(text, lang, rate = 1) {
  stopAll();
  return new Promise((resolve, reject) => {
    if (!('speechSynthesis' in window)) { reject(new Error('no-speech-synthesis')); return; }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = SPEECH_TAG[lang] || lang;
    const v = deviceVoiceFor(lang);
    if (v) u.voice = v;
    u.rate = rate;
    let settled = false;
    let started = false;
    let guard = null;
    let startGuard = null;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      clearTimeout(startGuard);
      if (current === handle) current = null;
      err ? reject(err) : resolve();
    };
    const handle = { stop: () => { try { speechSynthesis.cancel(); } catch { /* ignore */ } finish(); } };
    current = handle;
    u.onstart = () => { started = true; };
    u.onend = () => finish();
    u.onerror = (e) => {
      const code = e && e.error;
      if (code === 'interrupted' || code === 'canceled') finish();
      else finish(new Error(code || 'speech-error'));
    };
    // បើសំឡេងមិនចាប់ផ្តើមសោះ → ប្រាប់ឲ្យប្រើសំឡេង Gemini ជំនួស
    startGuard = setTimeout(() => {
      if (started || settled) return;
      try { speechSynthesis.cancel(); } catch { /* ignore */ }
      finish(new Error('speech-did-not-start'));
    }, 2500);
    // iPhone ពេលខ្លះមិនផ្ញើ "onend" — កំណត់ពេលការពារ
    guard = setTimeout(() => finish(), Math.max(4000, (text.length * 380) / rate) + 3000);
    setAudioSession('playback');
    speechSynthesis.speak(u);
  });
}
