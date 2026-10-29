// recorder.js — ថតសំឡេងពីមីក្រូហ្វូន ហើយបំលែងជាឯកសារ WAV (16 kHz, mono, 16-bit)
// ប្រើ Web Audio API ព្រោះវាដំណើរការល្អលើ Safari របស់ iPhone។

const TARGET_RATE = 16000;     // Gemini ស្តាប់បានល្អនៅ 16 kHz ហើយឯកសារតូច
const SPEECH_MIN = 0.012;      // កម្រិតសំឡេងទាបបំផុតដែលរាប់ថាជាការនិយាយ
const END_SILENCE_MS = 1600;   // ស្ងាត់ប៉ុណ្ណេះក្រោយនិយាយ => ឈប់ថត
const NO_SPEECH_MS = 8000;     // មិនឮអ្វីសោះប៉ុណ្ណេះ => ឈប់ថត

export function setAudioSession(type) {
  // Safari 17+: ប្រាប់ iPhone ថាកំពុងថត ឬកំពុងចាក់ (ដើម្បីឲ្យសំឡេងចេញពីឧបករណ៍បំពងសំឡេង)
  try { if (navigator.audioSession) navigator.audioSession.type = type; } catch { /* មិនគាំទ្រ */ }
}

export class Recorder {
  constructor({ onLevel = () => {}, onAutoStop = () => {}, autoStop = true, maxSeconds = 60 } = {}) {
    this.onLevel = onLevel;
    this.onAutoStop = onAutoStop;
    this.autoStop = autoStop;
    this.maxSeconds = maxSeconds;
    this.active = false;
  }

  static isSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia &&
      (window.AudioContext || window.webkitAudioContext));
  }

  // ត្រូវហៅពីក្នុងការចុចប៊ូតុង (user gesture) ទើប iPhone អនុញ្ញាត
  async start() {
    if (this.active || this.starting) return;
    this.starting = true;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    const resumed = this.ctx.resume().catch(() => {});
    setAudioSession('play-and-record');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      this.starting = false;
      try { await this.ctx.close(); } catch { /* ignore */ }
      setAudioSession('playback');
      throw err;
    }
    await resumed;
    if (this.ctx.state !== 'running') { try { await this.ctx.resume(); } catch { /* ignore */ } }

    this.inRate = this.ctx.sampleRate;
    this.chunks = [];
    this.samples = 0;
    this.noise = null;
    this.speechMs = 0;
    this.silenceMs = 0;
    this.heard = false;
    this.elapsedMs = 0;
    this.autoFired = false;
    this.smoothLevel = 0;

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.proc = this.ctx.createScriptProcessor(4096, 1, 1);
    this.mute = this.ctx.createGain();
    this.mute.gain.value = 0; // កុំឲ្យសំឡេងមីក្រូហ្វូនចេញឧបករណ៍បំពងសំឡេង
    this.proc.onaudioprocess = (e) => this._onAudio(e.inputBuffer.getChannelData(0));
    this.source.connect(this.proc);
    this.proc.connect(this.mute);
    this.mute.connect(this.ctx.destination);

    this.active = true;
    this.starting = false;
  }

  _onAudio(data) {
    if (!this.active) return;
    const chunk = new Float32Array(data);
    this.chunks.push(chunk);
    this.samples += chunk.length;

    let sum = 0;
    for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
    const rms = Math.sqrt(sum / chunk.length);
    const ms = (chunk.length / this.inRate) * 1000;
    this.elapsedMs += ms;

    // ប៉ាន់ស្មានកម្រិតសំឡេងរំខានជុំវិញ (noise floor)
    if (this.noise === null) this.noise = rms;
    else if (rms < this.noise) this.noise = this.noise * 0.6 + rms * 0.4;
    else this.noise = this.noise * 0.995 + rms * 0.005;
    const threshold = Math.max(SPEECH_MIN, this.noise * 3);

    if (rms > threshold) {
      this.speechMs += ms;
      this.silenceMs = 0;
      if (this.speechMs >= 180) this.heard = true;
    } else {
      this.silenceMs += ms;
    }

    const level = Math.min(1, rms / 0.12);
    this.smoothLevel = Math.max(level, this.smoothLevel * 0.7);
    this.onLevel(this.smoothLevel);

    if (this.autoFired) return;
    const tooLong = this.elapsedMs >= this.maxSeconds * 1000;
    const doneTalking = this.autoStop && this.heard && this.silenceMs >= END_SILENCE_MS;
    const nothing = this.autoStop && !this.heard && this.elapsedMs >= NO_SPEECH_MS;
    if (tooLong || doneTalking || nothing) {
      this.autoFired = true;
      setTimeout(() => this.onAutoStop(), 0);
    }
  }

  _release() {
    try {
      if (this.proc) this.proc.onaudioprocess = null;
      if (this.source) this.source.disconnect();
      if (this.proc) this.proc.disconnect();
      if (this.mute) this.mute.disconnect();
    } catch { /* ignore */ }
    if (this.stream) this.stream.getTracks().forEach(t => t.stop()); // បិទមីក្រូហ្វូនភ្លាម
    const ctx = this.ctx;
    this.stream = null;
    this.ctx = null;
    if (ctx) ctx.close().catch(() => {});
    setAudioSession('playback');
  }

  // បញ្ចប់ការថត ហើយផ្តល់ WAV ជា base64
  stop() {
    if (!this.active) return null;
    this.active = false;
    this._release();
    const pcm = concat(this.chunks, this.samples);
    this.chunks = [];
    const trimmed = trimSilence(pcm, this.inRate, Math.max(SPEECH_MIN * 0.8, (this.noise || 0) * 2.5));
    const down = downsample(trimmed, this.inRate, TARGET_RATE);
    const wav = encodeWav(down, TARGET_RATE);
    return {
      base64: bytesToBase64(wav),
      bytes: wav.length,
      seconds: down.length / TARGET_RATE,
      heard: this.heard,
    };
  }

  cancel() {
    if (!this.active) return;
    this.active = false;
    this._release();
    this.chunks = [];
  }
}

function concat(chunks, total) {
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

// កាត់ផ្នែកស្ងាត់នៅដើម និងចុង (ទុក 0.3 វិនាទី) ដើម្បីឲ្យឯកសារតូច
function trimSilence(pcm, rate, threshold) {
  const frame = Math.max(1, Math.round(rate * 0.02));
  let first = -1;
  let last = -1;
  for (let start = 0; start < pcm.length; start += frame) {
    const end = Math.min(pcm.length, start + frame);
    let sum = 0;
    for (let i = start; i < end; i++) sum += pcm[i] * pcm[i];
    if (Math.sqrt(sum / (end - start)) > threshold) {
      if (first < 0) first = start;
      last = end;
    }
  }
  if (first < 0) return pcm;
  const pad = Math.round(rate * 0.3);
  return pcm.subarray(Math.max(0, first - pad), Math.min(pcm.length, last + pad));
}

// បន្ថយ sample rate (ឧ. 48000 → 16000) ដោយយកមធ្យមភាគ
export function downsample(pcm, inRate, outRate) {
  if (inRate === outRate) return pcm;
  const ratio = inRate / outRate;
  const outLength = Math.floor(pcm.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(pcm.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = start; j < end; j++) sum += pcm[j];
    out[i] = sum / (end - start);
  }
  return out;
}

// បង្កើតឯកសារ WAV (PCM 16-bit, mono)
export function encodeWav(samples, rate) {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset, s) => { for (let i = 0; i < s.length; i++) bytes[offset + i] = s.charCodeAt(i); };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);       // ទំហំផ្នែក fmt
  view.setUint16(20, 1, true);        // PCM
  view.setUint16(22, 1, true);        // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // byte rate
  view.setUint16(32, 2, true);        // block align
  view.setUint16(34, 16, true);       // bits per sample
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return bytes;
}

export function bytesToBase64(bytes) {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(binary);
}
