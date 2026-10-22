const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const RATE = 24000;
const FRAME_BYTES = 480; // 10 ms, independent of pipe write boundaries.
const THRESHOLD = 0.005;
const waiting = [];
let active = null;

function pump() {
  if (active || !waiting.length) return;
  const job = waiting.shift();
  active = job;
  job.run(() => {
    active = null;
    pump();
  });
}

function rms(pcm) {
  let sum = 0;
  const count = Math.floor(pcm.length / 2);
  for (let i = 0; i < count; i++) sum += (pcm.readInt16LE(i * 2) / 32768) ** 2;
  return count ? Math.sqrt(sum / count) : 0;
}

// Linear interpolation at source positions 0, 1.5, 3, ... .
function pcmToWav(pcm) {
  const samples = Math.floor(pcm.length / 2);
  const count = Math.floor(samples * 2 / 3);
  const wav = Buffer.alloc(44 + count * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) {
    const position = i * 1.5;
    const left = Math.floor(position);
    const a = pcm.readInt16LE(left * 2);
    const b = pcm.readInt16LE(Math.min(left + 1, samples - 1) * 2);
    wav.writeInt16LE(Math.round(a + (b - a) * (position - left)), 44 + i * 2);
  }
  return wav;
}

function cleanTranscript(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\[_BEG_\]|\[_TT_\d+\]|\[_EOT_\]|\[_SOLM_\]|\[BLANK_AUDIO\]|\[SILENCE\]|\[NO_SPEECH\]|\[_NOSPEECH_\]|<\|[^|\r\n]*\|>/gi, '')
    .replace(/\s+/g, ' ').trim();
}

/** onTranscript receives { who, text, final: true }; onError receives an Error.
 * close() discards buffered/queued audio and kills this instance's active CLI.
 * _spawn and timeoutMs are optional test seams; paths always come from the caller.
 */
function createLocalTranscriber({ who, binary, model, onTranscript = () => {}, onError = () => {}, _spawn = spawn, timeoutMs = 60000 }) {
  let closed = false;
  let carry = Buffer.alloc(0);
  let frames = [];
  let silentFrames = 0;
  let hasSpeech = false;
  let ownJob = null;

  function enqueue(pcm) {
    const job = {
      owner,
      cancel: null,
      run(done) {
        if (closed) { done(); return; }
        ownJob = job;
        let directory;
        let child;
        let timer;
        let failure;
        let stdout = '';
        let stderr = '';
        let settled = false;
        function finish(code) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (directory) fs.rmSync(directory, { recursive: true, force: true });
          ownJob = null;
          // Release the shared GPU slot even if a caller callback throws.
          try {
            if (!closed) {
              if (failure || code !== 0) onError(failure || new Error(`whisper-cli exited ${code}: ${stderr.trim()}`));
              else {
                const text = cleanTranscript(stdout);
                if (text) onTranscript({ who, text, final: true });
              }
            }
          } finally { done(); }
        }
        job.cancel = () => {
          // Keep the scheduler occupied until close confirms the process died.
          if (child) child.kill('SIGKILL');
        };
        try {
          directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-whisper-'));
          const file = path.join(directory, 'audio.wav');
          fs.writeFileSync(file, pcmToWav(pcm), { mode: 0o600 });
          child = _spawn(binary, ['-m', model, '-f', file, '-l', 'en', '-nt', '-np', '-t', '4'], { stdio: ['ignore', 'pipe', 'pipe'] });
          child.stdout.setEncoding('utf8');
          child.stderr.setEncoding('utf8');
          child.stdout.on('data', (data) => { stdout = (stdout + data).slice(-65536); });
          child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-4096); });
          child.once('error', (error) => { failure = error; });
          child.once('close', finish);
          timer = setTimeout(() => {
            failure = new Error(`whisper-cli timed out after ${timeoutMs} ms`);
            child.kill('SIGKILL');
          }, timeoutMs);
          timer.unref?.();
        } catch (error) {
          failure = error;
          finish(null);
        }
      },
    };
    // Drop oldest waiting audio under overload; never interrupt another channel.
    if (waiting.length === 3) waiting.shift();
    waiting.push(job);
    pump();
  }

  const owner = {};
  function flush() {
    const pcm = Buffer.concat(frames);
    if (hasSpeech && rms(pcm) >= THRESHOLD) enqueue(pcm);
    frames = [];
    silentFrames = 0;
    hasSpeech = false;
  }

  return {
    write(buffer) {
      if (closed) return;
      if (!Buffer.isBuffer(buffer)) throw new TypeError('Expected 24 kHz mono PCM16 Buffer');
      const input = carry.length ? Buffer.concat([carry, buffer]) : buffer;
      let offset = 0;
      for (; offset + FRAME_BYTES <= input.length; offset += FRAME_BYTES) {
        const frame = input.subarray(offset, offset + FRAME_BYTES);
        const speech = rms(frame) >= THRESHOLD;
        // Ignore leading silence, keeping memory and CLI calls bounded.
        if (!hasSpeech && !speech) continue;
        frames.push(Buffer.from(frame));
        hasSpeech ||= speech;
        silentFrames = speech ? 0 : silentFrames + 1;
        if ((frames.length >= 100 && silentFrames >= 65) || frames.length >= 500) flush();
      }
      carry = Buffer.from(input.subarray(offset));
    },
    close() {
      if (closed) return;
      closed = true;
      carry = Buffer.alloc(0);
      frames = [];
      for (let i = waiting.length - 1; i >= 0; i--) {
        if (waiting[i].owner === owner) waiting.splice(i, 1);
      }
      ownJob?.cancel();
    },
  };
}

module.exports = { createLocalTranscriber, pcmToWav, cleanTranscript };
