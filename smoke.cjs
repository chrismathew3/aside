const {app,BrowserWindow}=require('electron');
const fs=require('fs');
let timer=setTimeout(()=>{console.error('FAIL: timed out');app.exit(1);},45000);
app.on('browser-window-created',(_event,win)=>{
 win.webContents.on('console-message',(_e,...args)=>console.log('renderer:',...args));
 win.webContents.on('did-finish-load',async()=>{
  try {
   const result=await win.webContents.executeJavaScript(`(async()=>{
    const failures=[];window.addEventListener('error',e=>failures.push(e.message));
    document.getElementById('settingsBtn').click();await new Promise(r=>setTimeout(r,300));
    if(document.getElementById('settings').hidden)throw Error('Settings does not open');
    document.getElementById('cancelSettings').click();document.getElementById('askBtn').click();
    if(document.getElementById('ask').hidden)throw Error('Ask does not open');
    document.getElementById('askInput').value='Reply with only ASIDE_OK.';
    const done=new Promise((resolve,reject)=>{const off=aside.on('ai-done',()=>{off();resolve(document.getElementById('answers').innerText)});aside.on('ai-error',e=>reject(Error(e.error)));});
    document.getElementById('askInput').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
    const response=await done;if(!response.includes('ASIDE_OK'))throw Error('Expected ASIDE_OK, received '+response);
    if(failures.length)throw Error(failures.join(';'));
    return {settings:true,ask:true,response};
   })()`);
   console.log('SMOKE',JSON.stringify(result));
   await win.webContents.capturePage().then(img=>fs.writeFileSync('/tmp/aside-smoke.png',img.toPNG()));
   clearTimeout(timer);app.quit();
  }catch(e){console.error('FAIL',e.message);clearTimeout(timer);app.exit(1);}
 });
});
require('./main.js');
