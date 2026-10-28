const { contextBridge, ipcRenderer } = require('electron');

const SEND = new Set(['resize', 'focus', 'blur', 'hide', 'quit', 'open-external', 'listen-stop', 'mic-chunk', 'answer', 'clear', 'screenshots-remove', 'screenshots-clear']);
const INVOKE = new Set(['listen-start', 'get-settings', 'save-settings', 'pick-project', 'screenshots-get', 'screenshots-capture']);
const ON = new Set(['screenshots-changed', 'resize-mode', 'hotkey', 'transcript', 'status', 'ai-delta', 'ai-done', 'ai-error', 'ai-step', 'visibility']);

contextBridge.exposeInMainWorld('aside', {
  send: (ch, data) => { if (SEND.has(ch)) ipcRenderer.send(ch, data); },
  invoke: (ch, data) => (INVOKE.has(ch) ? ipcRenderer.invoke(ch, data) : Promise.reject(new Error('blocked'))),
  on: (ch, fn) => {
    if (!ON.has(ch)) return () => {};
    const h = (_e, d) => fn(d);
    ipcRenderer.on(ch, h);
    return () => ipcRenderer.removeListener(ch, h);
  },
});
