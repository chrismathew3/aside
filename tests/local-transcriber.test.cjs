const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const { createLocalTranscriber, pcmToWav, cleanTranscript } = require('../local-transcriber');

function pcm(seconds, value = 3000) {
  const buffer = Buffer.alloc(Math.round(seconds * 24000) * 2);
  for (let i = 0; i < buffer.length; i += 2) buffer.writeInt16LE(value, i);
  return buffer;
}
function runner() {
  const calls = [];
  const spawn = (binary, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal) => { child.killed = signal; queueMicrotask(() => child.emit('close', null, signal)); };
    child.finish = (text = 'hello', code = 0) => { child.stdout.end(text); child.emit('close', code); };
    calls.push({ binary, args, child, file: args[3] });
    return child;
  };
  return { calls, spawn };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('WAV contains real 16 kHz mono PCM16 with linear interpolation', () => {
  const input = Buffer.alloc(12);
  [0, 1000, 2000, 3000, 4000, 5000].forEach((n, i) => input.writeInt16LE(n, i * 2));
  const wav = pcmToWav(input);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.toString('ascii', 8, 16), 'WAVEfmt ');
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), 8);
  assert.deepEqual([0, 1, 2, 3].map(i => wav.readInt16LE(44 + i * 2)), [0, 1500, 3000, 4500]);
  assert.equal(pcmToWav(pcm(1)).length, 32044);
});

test('only known markers are stripped; timestamps and bracketed speech survive', () => {
  assert.equal(cleanTranscript('[BLANK_AUDIO] <|endoftext|>'), '');
  assert.equal(cleanTranscript(' [_BEG_] Hello [Alice] at [00:01]. [_EOT_] '), 'Hello [Alice] at [00:01].');
});

test('silence gate, fragmented bytes, endpoint, CLI arguments and callback shape', () => {
  const fake = runner();
  const entries = [];
  const transcriber = createLocalTranscriber({ who: 'me', binary: '/bin/whisper', model: '/models/base', _spawn: fake.spawn, onTranscript: e => entries.push(e) });
  transcriber.write(pcm(10, 0));
  transcriber.write(pcm(5, 100));
  assert.equal(fake.calls.length, 0);
  const input = Buffer.concat([pcm(0.35), pcm(0.65, 0)]);
  for (let i = 0; i < input.length; i += 777) transcriber.write(input.subarray(i, i + 777));
  assert.equal(fake.calls.length, 1);
  const call = fake.calls[0];
  assert.deepEqual(call.args, ['-m', '/models/base', '-f', call.file, '-l', 'en', '-nt', '-np', '-t', '4']);
  assert.equal(fs.readFileSync(call.file).length, 32044);
  call.child.stderr.write('read_audio_data logs');
  call.child.finish('[_BEG_] Hello there. [_EOT_]');
  assert.deepEqual(entries, [{ who: 'me', text: 'Hello there.', final: true }]);
  assert.equal(fs.existsSync(call.file), false);
  transcriber.close();
});

test('shared scheduler serializes channels, bounds queue at three and discards closed work', async () => {
  const fake = runner();
  const entries = [];
  const options = { binary: 'whisper', model: 'base', _spawn: fake.spawn, onTranscript: e => entries.push(e) };
  const me = createLocalTranscriber({ ...options, who: 'me' });
  const them = createLocalTranscriber({ ...options, who: 'them' });
  me.write(pcm(5));
  them.write(pcm(25));
  assert.equal(fake.calls.length, 1);
  me.close();
  assert.equal(fake.calls[0].child.killed, 'SIGKILL');
  await tick();
  assert.equal(fake.calls.length, 2);
  fake.calls[1].child.finish('one');
  fake.calls[2].child.finish('two');
  fake.calls[3].child.finish('three');
  assert.equal(fake.calls.length, 4);
  assert.deepEqual(entries.map(e => e.who), ['them', 'them', 'them']);
  them.write(pcm(10));
  them.close();
  await tick();
  assert.equal(fake.calls.length, 5);
  assert.equal(fs.existsSync(fake.calls[4].file), false);
  them.write(pcm(5));
  assert.equal(fake.calls.length, 5);
});

test('spawn failures, nonzero exit, timeout release the scheduler and clean files', async () => {
  const errors = [];
  const fake = runner();
  const options = { binary: 'whisper', model: 'base', onError: e => errors.push(e) };
  const failed = createLocalTranscriber({ ...options, _spawn() { throw new Error('spawn failed'); } });
  failed.write(pcm(5));
  assert.match(errors[0].message, /spawn failed/);
  failed.close();
  const transcriber = createLocalTranscriber({ ...options, _spawn: fake.spawn, timeoutMs: 10 });
  transcriber.write(pcm(5));
  fake.calls[0].child.emit('error', new Error('ENOENT'));
  fake.calls[0].child.emit('close', -2);
  assert.match(errors[1].message, /ENOENT/);
  transcriber.write(pcm(5));
  fake.calls[1].child.stderr.write('bad model');
  fake.calls[1].child.finish('', 1);
  assert.match(errors[2].message, /bad model/);
  transcriber.write(pcm(5));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.match(errors[3].message, /timed out/);
  assert.ok(fake.calls.every(call => !fs.existsSync(call.file)));
  transcriber.close();
});
