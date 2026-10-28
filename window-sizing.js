// Auto-fit content until the user chooses a size with a native edge/corner drag.
exports.configureWindowSizing = function configureWindowSizing(win, { ipcMain, screen }) {
  let manual = false;
  const notify = () => win.webContents.send('resize-mode', { manual });
  win.on('will-resize', () => {
    manual = true;
    notify();
  });
  win.webContents.on('did-finish-load', notify);
  const fitContent = (event, { height } = {}) => {
    if (manual || win.isDestroyed() || event.sender !== win.webContents || !Number.isFinite(height)) return;
    const bounds = win.getBounds();
    const { workArea } = screen.getDisplayMatching(bounds);
    const nextHeight = Math.max(96, Math.min(Math.round(height), Math.round(workArea.height * 0.85)));
    if (bounds.height !== nextHeight) win.setBounds({ ...bounds, height: nextHeight });
  };
  ipcMain.on('resize', fitContent);
  win.once('closed', () => ipcMain.removeListener('resize', fitContent));
};
