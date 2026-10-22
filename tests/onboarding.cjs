const {app,BrowserWindow,ipcMain}=require('electron');
const path=require('node:path');
const assert=require('node:assert/strict');
let saved;
ipcMain.handle('get-settings',()=>({provider:'max',model:'sonnet',transcription:'local',claudeFound:false,localReady:true,onboardingDone:false}));
ipcMain.handle('save-settings',(_e,value)=>{saved=value;return {ok:true};});
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,webPreferences:{preload:path.resolve('preload.js'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
 try{
  await win.loadFile(path.resolve('renderer/index.html'));
  await new Promise(r=>setTimeout(r,200));
  const state=await win.webContents.executeJavaScript(`(async()=>{
   const $=id=>document.getElementById(id);
   if($('settings').hidden||$('welcome').hidden||$('anthropicField').hidden)throw Error('First-run setup not shown');
   if(!document.querySelector('#providerSeg [data-v="api"]').classList.contains('on'))throw Error('Missing CLI should select API');
   $('saveSettings').click();await new Promise(r=>setTimeout(r,20));
   if(!$('notice').textContent.includes('Add an Anthropic API key'))throw Error('Empty key not validated');
   $('anthropicKey').value='test-key-not-real';$('saveSettings').click();await new Promise(r=>setTimeout(r,20));
   return {hidden:$('settings').hidden};
  })()`);
  assert.equal(state.hidden,true);assert.equal(saved.onboardingDone,true);assert.equal(saved.provider,'api');
  console.log('PASS first-run setup, missing-CLI fallback, key validation and completion');app.quit();
 }catch(e){console.error(e);app.exit(1);}
});
