const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const tiny='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
let shots = [{id:'one',data:tiny,capturedAt:1},{id:'two',data:tiny,capturedAt:2}];
let removed=[], cleared=false, answers=[];
ipcMain.handle('get-settings',()=>({provider:'max',model:'sonnet',transcription:'local',claudeFound:true,onboardingDone:true}));
ipcMain.handle('screenshots-get',()=>shots);
ipcMain.handle('screenshots-capture',()=>({ok:true}));
ipcMain.on('screenshots-remove',(event,{id})=>{removed.push(id);shots=shots.filter(s=>s.id!==id);event.sender.send('screenshots-changed',shots);});
ipcMain.on('screenshots-clear',event=>{cleared=true;shots=[];event.sender.send('screenshots-changed',shots);});
ipcMain.on('answer',(_event,args)=>answers.push(args));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:660,height:850,webPreferences:{preload:path.resolve('preload.js'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
 try {
  await win.loadFile(path.resolve('renderer/index.html'));
  await new Promise(r=>setTimeout(r,150));
  await win.webContents.executeJavaScript(`(()=>{
   const $=id=>document.getElementById(id);
   if($('shotsCount').textContent!=='2'||document.querySelectorAll('.shot-thumbnail').length!==2)throw Error('Initial queue missing');
   $('shotsToggle').click();
   if($('shotsGallery').hidden||document.activeElement.getAttribute('aria-label')!=='Preview screenshot 1')throw Error('Preview focus missing');
   document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
   if(document.activeElement.getAttribute('aria-label')!=='Preview screenshot 2'||!$('shotPreviewCaption').textContent.includes('2 of 2'))throw Error('Arrow navigation failed');
   document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true}));
  })()`);
  await new Promise(r=>setTimeout(r,50));
  assert.deepEqual(removed,['two']);
  await win.webContents.executeJavaScript(`(()=>{
   const $=id=>document.getElementById(id);
   if($('shotsCount').textContent!=='1')throw Error('Remove count stale');
   $('includeScreen').checked=false;$('answerBtn').click();
   if(!document.querySelector('.turn .q').textContent.includes('1 screenshot'))throw Error('Answer attachment count missing');
   $('clearShots').click();
  })()`);
  await new Promise(r=>setTimeout(r,50));
  assert.equal(cleared,true);assert.equal(answers.length,1);assert.equal(answers[0].withScreen,false);
  await win.webContents.executeJavaScript(`(()=>{
   const $=id=>document.getElementById(id);
   if($('shotsCount').textContent!=='0'||!$('clearShots').disabled||!$('shotPreview').hidden)throw Error('Empty queue state failed');
   $('shotsGallery').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
   if(!$('shotsGallery').hidden)throw Error('Escape did not close');
  })()`);
  // Capture populated preview for one visual review.
  shots=[{id:'one',data:tiny,capturedAt:1},{id:'two',data:tiny,capturedAt:2}];
  win.webContents.send('screenshots-changed',shots);win.webContents.send('hotkey','screenshots-preview');
  await new Promise(r=>setTimeout(r,80));
  await win.webContents.capturePage().then(img=>fs.writeFileSync('/tmp/aside-screenshot-queue.png',img.toPNG()));
  console.log('PASS screenshot UI initial state, keyboard preview/removal, attachment count, clear and Escape');app.quit();
 }catch(error){console.error(error);app.exit(1);}
});
