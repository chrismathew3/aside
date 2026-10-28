const { app, BrowserWindow, ipcMain, screen } = require('electron');
ipcMain.handle('screenshots-get', () => []);
const { configureWindowSizing } = require('../window-sizing');
const assert = require('node:assert/strict');
const path = require('node:path');
const delay = () => new Promise(resolve => setTimeout(resolve, 100));
ipcMain.handle('get-settings', () => ({ onboardingDone: true, claudeFound: true }));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 660, height: 96, resizable: true,
    minWidth: 560, minHeight: 96, frame: false, transparent: true,
    webPreferences: { preload: path.resolve('preload.js'), sandbox: true, contextIsolation: true } });
  configureWindowSizing(win, { ipcMain, screen });
  try {
    await win.loadFile(path.resolve('renderer/index.html'));
    await delay();
    assert.equal(win.isResizable(), true);
    ipcMain.emit('resize', { sender: win.webContents }, { height: 300 });
    await delay();
    assert.equal(win.getBounds().height, 300);
    // Electron emits will-resize only for a native user drag, not setBounds.
    win.emit('will-resize', {}, { width: 900, height: 600 });
    win.setBounds({ width: 900, height: 600 });
    await delay();
    await win.webContents.executeJavaScript(`document.getElementById('answers').hidden = false;
      document.getElementById('answers').innerHTML = '<p>Code example</p>'.repeat(100);`);
    ipcMain.emit('resize', { sender: win.webContents }, { height: 100 });
    await delay();
    assert.equal(win.getBounds().width, 900);
    assert.equal(win.getBounds().height, 600);
    const layout = await win.webContents.executeJavaScript(`(() => {
      const panel = document.getElementById('panel').getBoundingClientRect();
      const footer = document.getElementById('hints').getBoundingClientRect();
      const answers = document.getElementById('answers');
      return { manual: document.documentElement.classList.contains('manual-size'),
        panelHeight: panel.height, viewport: innerHeight, footerBottom: footer.bottom,
        scrollable: answers.scrollHeight > answers.clientHeight };
    })()`);
    assert.equal(layout.manual, true);
    assert.equal(layout.panelHeight, layout.viewport);
    assert.ok(layout.footerBottom <= layout.viewport);
    assert.equal(layout.scrollable, true);
    console.log('PASS native resizable window, initial auto-fit, manual size retention, viewport layout and scrolling');
    app.quit();
  } catch (error) { console.error(error); app.exit(1); }
});
