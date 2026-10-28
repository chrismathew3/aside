const { app, BrowserWindow, ipcMain } = require('electron');
ipcMain.handle('screenshots-get', () => []);
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
ipcMain.handle('get-settings', () => ({ onboardingDone: true, provider: 'api' }));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 760, height: 850, webPreferences: {
    preload: path.resolve('preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false,
  } });
  try {
    await win.loadFile(path.resolve('renderer/index.html'));
    const result = await win.webContents.executeJavaScript(`(async () => {
      const container = document.createElement('div');
      container.className = 'md';
      document.getElementById('answers').hidden = false;
      document.getElementById('answers').append(container);
      const source = 'const totals = new Map<string, number>();\\nfor (const transaction of transactions) {\\n  const month = transaction.date.slice(0, 7);\\n  totals.set(month, (totals.get(month) ?? 0) + transaction.amountMinor);\\n}';
      const sample = '## Group transactions by month\\nUse a single loop and a ' + '\\u0060Map\\u0060' + ' to accumulate totals.\\n\\n' + '\\u0060\\u0060\\u0060ts\\n' + source + '\\n\\u0060\\u0060\\u0060\\n\\n**Why this works:** Each transaction adds to its month’s running total.\\n\\n- Dates are already in YYYY-MM-DD format.\\n- Amounts are integer cents.\\n\\n<table><tr><th>Month</th><th>Total</th></tr><tr><td>2026-09</td><td>100050</td></tr></table>';
      renderMarkdown(container, sample);
      if (!container.querySelector('.hljs-keyword')) throw Error('No syntax highlighting');
      if (container.querySelector('.code-header span').textContent !== 'ts') throw Error('Missing language label');
      if (container.querySelector('pre code').textContent.trimEnd() !== source) throw Error('Code source was changed');
      if (getComputedStyle(container.querySelector('pre code')).whiteSpace !== 'pre') throw Error('Code indentation/wrapping incorrect');
      const copy = container.querySelector('.copy');
      let copied;
      Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async text => { copied = text; } });
      copy.click(); await new Promise(resolve => setTimeout(resolve, 20));
      if (copied.trimEnd() !== source || copy.textContent !== 'Copied') throw Error('Copy failed');
      const probe = document.createElement('div');
      renderMarkdown(probe, '<img src=x onerror="window.__bad=true"><script>window.__bad=true</script>\\n\\n\\u0060\\u0060\\u0060unknown\\n<img onerror="bad()">\\n\\u0060\\u0060\\u0060');
      if (probe.querySelector('script,[onerror]')) throw Error('Unsafe markup survived');
      if (!probe.querySelector('code').textContent.includes('<img')) throw Error('Unknown-language fallback corrupted');
      renderMarkdown(probe, '\\u0060\\u0060\\u0060typescript\\nconst partial = "hel');
      if (!probe.querySelector('.code-header') || !probe.textContent.includes('partial')) throw Error('Streaming fence failed');
      renderMarkdown(probe, '\\u0060\\u0060\\u0060\\nconst answer = 42;\\n\\u0060\\u0060\\u0060');
      if (!probe.querySelector('.hljs')) throw Error('Untagged code failed');
      renderMarkdown(probe, '\\u0060\\u0060\\u0060text\\nconst plain = 42;\\n\\u0060\\u0060\\u0060');
      if (probe.querySelector('.hljs-keyword')) throw Error('Plain text incorrectly highlighted');
      return { highlighted: true, copied: true, sanitized: true, streaming: true, fallback: true };
    })()`);
    assert.equal(result.highlighted, true);
    await win.webContents.capturePage().then(image => fs.writeFileSync('/tmp/aside-markdown.png', image.toPNG()));
    console.log('PASS markdown', result);
    app.quit();
  } catch (error) { console.error(error); app.exit(1); }
});
