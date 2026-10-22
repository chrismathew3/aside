const {app,systemPreferences}=require('electron');
app.whenReady().then(()=>console.log('Microphone permission:',systemPreferences.getMediaAccessStatus('microphone')));
const fs=require('node:fs');
const pcm=Buffer.concat([require('./audio-fixture.cjs')(),Buffer.alloc(96000)]);
const oldPcm=Buffer.concat([require('./audio-fixture.cjs')('The previous conversation has ended and must be forgotten.'),Buffer.alloc(96000)]);
const timeout=setTimeout(()=>{console.error('FAIL: local app test timed out');app.exit(1);},30000);
app.on('browser-window-created',(_e,win)=>{win.webContents.on('console-message',(_e,...args)=>console.log('renderer',...args));win.webContents.once('did-finish-load',async()=>{
 try {
  const result=await win.webContents.executeJavaScript(`(async()=>{
   const settings=await aside.invoke('get-settings');
   if(settings.transcription!=='local')throw Error('Local mode is not default');
   const heard=new Promise((resolve,reject)=>{aside.on('transcript',e=>{if(e.who==='me'&&e.final){if(e.epoch!==settings.transcriptEpoch+1)reject(Error('Stale transcription epoch'));else resolve(e);}});aside.on('status',e=>{if(e.error)reject(Error(e.error))});});
   console.log('Starting local audio');const start=await aside.invoke('listen-start');console.log('Audio started',JSON.stringify(start));if(!start.ok)throw Error(start.error);
   const sample=Uint8Array.from(atob('${pcm.toString('base64')}'),c=>c.charCodeAt(0)).buffer;
   aside.send('mic-chunk',Uint8Array.from(atob('${oldPcm.toString('base64')}'),c=>c.charCodeAt(0)).buffer);clear();await new Promise(r=>setTimeout(r,400));
   if(document.getElementById('transcriptList').innerText.includes('previous conversation'))throw Error('Pre-clear audio returned');
   aside.send('mic-chunk',sample);
   const entry=await heard;aside.send('listen-stop');
   if(!entry.text.toLowerCase().includes('technical architecture'))throw Error('Unexpected transcript: '+entry.text);
   document.getElementById('transcriptBtn').click();
   if(!document.getElementById('transcriptList').innerText.includes(entry.text))throw Error('Transcript not visible in UI');
   return {provider:settings.transcription,text:entry.text};
  })()`);
  console.log('PASS local app IPC and transcript UI',JSON.stringify(result));clearTimeout(timeout);app.quit();
 }catch(e){console.error('FAIL',e.message);clearTimeout(timeout);app.exit(1);}
});});
require('../main');
