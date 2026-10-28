const { app, BrowserWindow, ipcMain } = require('electron');
ipcMain.handle('screenshots-get', () => []);
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
let saved, pick = { path: '/Users/example/Projects/my-project' };
ipcMain.handle('get-settings', () => ({ provider: 'max', model: 'sonnet', transcription: 'local', claudeFound: true, onboardingDone: true }));
ipcMain.handle('pick-project', () => pick);
ipcMain.handle('save-settings', (_event, value) => { saved = value; return { ok: true }; });
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 660, height: 850, webPreferences: { preload: path.resolve('preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    await win.loadFile(path.resolve('renderer/index.html'));
    await new Promise(resolve => setTimeout(resolve, 150));
    await win.webContents.executeJavaScript(`(async () => {
      const $ = id => document.getElementById(id);
      const wait = () => new Promise(resolve => setTimeout(resolve, 40));
      $('settingsBtn').click(); await wait();
      if (!$('useHarness').checked || $('harnessField').hidden) throw Error('Harness must default on for Claude Code');
      $('pickProject').click(); await wait();
      if ($('projectPath').value !== '/Users/example/Projects/my-project' || $('clearProject').hidden) throw Error('Project picker did not populate');
      document.querySelector('#providerSeg [data-v="api"]').click();
      if (!$('harnessField').hidden) throw Error('API must hide harness');
      document.querySelector('#providerSeg [data-v="max"]').click();
      if ($('harnessField').hidden || !$('projectPath').value) throw Error('Provider switch lost project');
      $('saveSettings').click(); await wait();
    })()`);
    assert.equal(saved.useHarness, true);
    assert.equal(saved.projectPath, '/Users/example/Projects/my-project');
    await win.webContents.executeJavaScript(`(async () => {
      const $ = id => document.getElementById(id);
      const wait = () => new Promise(resolve => setTimeout(resolve, 40));
      $('settingsBtn').click(); await wait();
      $('projectPath').value = '/Users/example/Projects/my-project';
      $('clearProject').click();
      if ($('projectPath').value || !$('clearProject').hidden) throw Error('Clear did not clear project');
      $('useHarness').click();
      if (!$('projectField').hidden) throw Error('Disabled harness must hide project controls');
      $('saveSettings').click(); await wait();
    })()`);
    assert.equal(saved.useHarness, false);
    assert.equal(saved.projectPath, '');
    console.log('PASS harness UI defaults, picker, provider switch, save, clear, disable');
    app.quit();
  } catch (error) { console.error(error); app.exit(1); }
});
