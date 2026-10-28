// Main-process integration using a fake Electron surface and fake Claude streams.
// Does not capture the real desktop, send data to an AI, or load user settings.
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-screen-integration-'));
const executable = path.join(temporary, 'fake-claude');
fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
fs.writeFileSync(path.join(temporary, 'config.json'), JSON.stringify({ provider: 'max', useHarness: false, claudePath: executable, onboardingDone: true }));
const output = new EventEmitter(), requests = new EventEmitter();
const ipcMain = new EventEmitter(), handlers = new Map();
ipcMain.handle = (name, fn) => handlers.set(name, fn);
let captures = 0, currentWindow;
const processes = [];
class FakeWindow extends EventEmitter {
  constructor(options) {
    super(); currentWindow = this; this.options = options; this.visible = false;
    this.webContents = new EventEmitter();
    this.webContents.send = (channel, value) => output.emit(channel, value);
    this.webContents.setWindowOpenHandler = () => {};
  }
  isDestroyed() { return false; }
  isVisible() { return this.visible; }
  hide() { this.visible = false; }
  showInactive() { this.visible = true; }
  setContentProtection() {}
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  loadFile() {}
  getBounds() { return { x: 0, y: 0, width: 660, height: 96 }; }
  setBounds() {}
}
const app = new EventEmitter();
Object.assign(app, { setName() {}, requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(), getPath: () => temporary, isReady: () => true, quit() {}, dock: { show() {} } });
const image = { isEmpty: () => false, resize() { return this; }, setTemplateImage() {} };
const screen = { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1400, height: 1000 } }), getDisplayNearestPoint: () => ({ id: 1, size: { width: 1400, height: 1000 } }), getCursorScreenPoint: () => ({ x: 0, y: 0 }) };
const fakeElectron = {
  app, BrowserWindow: FakeWindow, ipcMain, screen,
  globalShortcut: { register: () => true, unregister() {}, unregisterAll() {} },
  desktopCapturer: { getSources: async () => {
    const value = `fixture-${++captures}`;
    return [{ display_id: '1', thumbnail: { isEmpty: () => false, toJPEG: () => Buffer.from(value) } }];
  } },
  safeStorage: {}, systemPreferences: {}, shell: {}, dialog: {},
  Tray: class { setToolTip() {} setContextMenu() {} },
  Menu: { buildFromTemplate: value => value },
  nativeImage: { createFromPath: () => image, createFromDataURL: () => image },
};
function fakeSpawn() {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
  proc.stdin = new Writable({ write(chunk, _encoding, callback) {
    const request = JSON.parse(chunk.toString());
    requests.emit('request', { proc, request });
    callback();
  } });
  proc.kill = () => { proc.stdout.end(); proc.stderr.end(); proc.stdin.destroy(); };
  processes.push(proc);
  return proc;
}
const originalLoad = Module._load;
Module._load = function(request, parent, main) {
  if (request === 'electron') return fakeElectron;
  if (request === 'node:child_process') return { ...originalLoad.call(this, request, parent, main), spawn: fakeSpawn };
  return originalLoad.call(this, request, parent, main);
};
require('../main.js');
Module._load = originalLoad;
const invoke = name => handlers.get(name)({ sender: currentWindow.webContents });
const emit = (name, value) => ipcMain.emit(name, { sender: currentWindow.webContents }, value);

(async () => {
  await new Promise(resolve => setImmediate(resolve)); // Finish app.whenReady callback.
  assert.ok(currentWindow);
  await invoke('screenshots-capture');
  await invoke('screenshots-capture');
  const queued = await invoke('screenshots-get');
  assert.equal(queued.length, 2);
  const requestReady = once(requests, 'request');
  emit('answer', { id: 'first', transcript: '', question: 'Explain both views.', withScreen: false });
  const [{ proc, request }] = await requestReady;
  const content = request.message.content;
  assert.equal(content.filter(part => part.type === 'image').length, 2);
  assert.deepEqual(content.filter(part => part.type === 'image').map(part => Buffer.from(part.source.data, 'base64').toString()), ['fixture-1', 'fixture-2']);
  assert.match(content[0].text, /Screenshot 1 of 2/);
  assert.match(content[2].text, /Screenshot 2 of 2/);
  assert.equal(captures, 2, 'queued images replace the automatic screenshot even when screen capture is disabled');

  await invoke('screenshots-capture'); // Capture another view while the answer is pending.
  const done = once(output, 'ai-done');
  proc.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'ok' }) + '\n');
  assert.equal((await done)[0].id, 'first');
  const retained = await invoke('screenshots-get');
  assert.equal(retained.length, 1);
  assert.equal(Buffer.from(retained[0].data, 'base64').toString(), 'fixture-3');

  const failureRequest = once(requests, 'request');
  emit('answer', { id: 'second', transcript: '', question: 'Retry this view.', withScreen: true });
  const [{ proc: failureProc, request: failedPayload }] = await failureRequest;
  assert.equal(failedPayload.message.content.filter(part => part.type === 'image').length, 1);
  assert.equal(captures, 3, 'a queued view must not also capture another automatic image');
  const failed = once(output, 'ai-error');
  failureProc.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: 'Fixture failure' }) + '\n');
  assert.equal((await failed)[0].error, 'Fixture failure');
  assert.deepEqual(await invoke('screenshots-get'), retained, 'failed answers keep their screenshots for retry');
  emit('screenshots-clear');
  assert.deepEqual(await invoke('screenshots-get'), []);
  console.log('PASS main IPC: ordered multi-image payload, no extra auto-capture, success consumes only submitted images, failure preserves retry queue');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  app.emit('will-quit');
  for (const proc of processes) proc.kill();
  fs.rmSync(temporary, { recursive: true, force: true });
  // Main schedules warm-spare timers; exit after the isolated test has completed.
  setImmediate(() => process.exit(process.exitCode || 0));
});
