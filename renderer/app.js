'use strict';
const $ = (id) => document.getElementById(id);
const api = window.aside;
let config = {}, recording = false, starting = false, audio, stream, processor, source, mute;
let transcriptEpoch = 0;
let lines = [], interim = {}, turns = new Map(), current = null;
const text = (el, value) => { el.textContent = value; };
function notice(message) { text($('notice'), message || ''); $('notice').hidden = !message; }
let manualSize = false;
api.on('resize-mode', ({ manual }) => {
  manualSize = manual;
  document.documentElement.classList.toggle('manual-size', manual);
});
function resize() { if (manualSize) return; api.send('resize', { height: Math.min(850, $('panel').getBoundingClientRect().height + 2) }); }
new ResizeObserver(resize).observe($('panel'));
// The queue stays in the main process; previews are only a view of pending shots.
let screenshotEntries = [], selectedShotId = null;
function previewShot(id, focus = false) {
  selectedShotId = id;
  const index = screenshotEntries.findIndex(shot => shot.id === id);
  const shot = screenshotEntries[index];
  $('shotPreview').hidden = !shot;
  if (shot) {
    $('shotPreviewImage').src = `data:image/jpeg;base64,${shot.data}`;
    $('shotPreviewImage').alt = `Screenshot ${index + 1} preview`;
    text($('shotPreviewCaption'), `Screenshot ${index + 1} of ${screenshotEntries.length}`);
  } else {
    $('shotPreviewImage').removeAttribute('src');
    text($('shotPreviewCaption'), '');
  }
  for (const button of $('shotsList').querySelectorAll('.shot-thumbnail')) {
    button.setAttribute('aria-pressed', String(button.dataset.id === id));
    if (focus && button.dataset.id === id) button.focus();
  }
}
function drawScreenshots(entries) {
  const previousIndex = screenshotEntries.findIndex(shot => shot.id === selectedShotId);
  const hadGalleryFocus = $('shotsGallery').contains(document.activeElement);
  screenshotEntries = Array.isArray(entries) ? entries : [];
  text($('shotsCount'), String(screenshotEntries.length));
  text($('shotsHint'), screenshotEntries.length ? `${screenshotEntries.length} queued for your next answer` : 'Capture, scroll, capture again');
  $('clearShots').disabled = !screenshotEntries.length;
  $('shotsEmpty').hidden = screenshotEntries.length > 0;
  $('shotsList').replaceChildren();
  screenshotEntries.forEach((shot, index) => {
    const tile = document.createElement('div'); tile.className = 'shot-tile';
    const button = document.createElement('button'); button.type = 'button';button.className = 'shot-thumbnail';button.dataset.id = shot.id;
    button.setAttribute('aria-label', `Preview screenshot ${index + 1}`);
    const image = document.createElement('img');image.src = `data:image/jpeg;base64,${shot.data}`;image.alt = '';
    const number = document.createElement('span');number.className = 'shot-number';text(number, String(index + 1));
    button.append(image, number);button.onclick = () => previewShot(shot.id);
    const remove = document.createElement('button');remove.type = 'button';remove.className = 'shot-remove';text(remove, '×');remove.setAttribute('aria-label', `Remove screenshot ${index + 1}`);
    remove.onclick = () => api.send('screenshots-remove', { id: shot.id });
    tile.append(button, remove);$('shotsList').append(tile);
  });
  const selected = screenshotEntries.find(shot => shot.id === selectedShotId) || screenshotEntries[Math.max(0, Math.min(previousIndex, screenshotEntries.length - 1))];
  previewShot(selected?.id || null, hadGalleryFocus);
  if (hadGalleryFocus && !selected) $('shotsToggle').focus();
}
function toggleScreenshots(forceOpen = false) {
  const open = forceOpen === true || $('shotsGallery').hidden;
  $('shotsGallery').hidden = !open;
  $('shotsToggle').setAttribute('aria-expanded', String(open));
  if (open) {
    api.send('focus');
    if (screenshotEntries.length) previewShot(selectedShotId || screenshotEntries[0].id, true);
    else $('captureShot').focus();
  } else $('shotsToggle').focus();
}
$('shotsToggle').onclick = toggleScreenshots;
$('captureShot').onclick = async () => {
  $('captureShot').disabled = true;
  try {
    const result = await api.invoke('screenshots-capture');
    if (!result?.ok) throw new Error(result?.error || 'Could not capture this screen.');
    notice('');
  } catch (error) { notice(error.message); }
  finally { $('captureShot').disabled = false; }
};
$('clearShots').onclick = () => api.send('screenshots-clear');
$('screenshots').addEventListener('keydown', event => {
  if ($('shotsGallery').hidden) return;
  if (event.key === 'Escape') {
    event.preventDefault();toggleScreenshots();api.send('blur');return;
  }
  if (!screenshotEntries.length) return;
  const index = Math.max(0, screenshotEntries.findIndex(shot => shot.id === selectedShotId));
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    const offset = event.key === 'ArrowRight' ? 1 : -1;
    previewShot(screenshotEntries[(index + offset + screenshotEntries.length) % screenshotEntries.length].id, true);
  } else if ((event.key === 'Backspace' || event.key === 'Delete') && $('shotsGallery').contains(event.target)) {
    event.preventDefault();api.send('screenshots-remove', { id: screenshotEntries[index].id });
  }
});
api.on('screenshots-changed', drawScreenshots);
api.invoke('screenshots-get').then(drawScreenshots).catch(() => {});
function transcript() { return [...lines.slice(-180), ...Object.entries(interim).filter(([,v]) => v).map(([who,t]) => ({who,text:t}))].map(l => `${l.who === 'me' ? 'Me' : 'Other person'}: ${l.text}`).join('\n'); }
function drawTranscript() {
  const box = $('transcriptList'); box.replaceChildren();
  const all = [...lines.slice(-180), ...Object.entries(interim).filter(([,v])=>v).map(([who,t])=>({who,text:t,interim:true}))];
  if (!all.length) { const e=document.createElement('div'); e.className='empty'; text(e,'Your live transcript will appear here.'); box.append(e); }
  for (const l of all) { const e=document.createElement('div'); e.className=`line ${l.who}${l.interim?' interim':''}`; const label=document.createElement('span'); label.className='who'; text(label,l.who==='me'?'You':'Other person'); e.append(label,document.createTextNode(l.text)); box.append(e); }
  $('transcriptView').scrollTop=$('transcriptView').scrollHeight;
}
api.on('transcript', l => { if ((l.epoch ?? 0) < transcriptEpoch || !l.text) return;transcriptEpoch=Math.max(transcriptEpoch,l.epoch ?? 0); if(l.final) { lines.push(l); lines=lines.slice(-1000); delete interim[l.who]; } else interim[l.who]=l.text; text($('caption'),l.text); drawTranscript(); });
function stop() { recording=false; api.send('listen-stop'); if(processor) {processor.onaudioprocess=null;processor.disconnect();} source?.disconnect(); mute?.disconnect(); stream?.getTracks().forEach(t=>t.stop()); audio?.close().catch(()=>{}); processor=source=mute=stream=audio=null; $('listenBtn').classList.remove('listening'); text($('listenLabel'),'Listen'); }
async function listen() {
  if(starting)return; if(recording){stop();return;} starting=true;
  try {
    const result=await api.invoke('listen-start'); if(!result.ok)throw new Error(result.error);
    stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
    audio=new AudioContext({sampleRate:24000}); await audio.resume(); source=audio.createMediaStreamSource(stream);
    processor=audio.createScriptProcessor(4096,1,1); mute=audio.createGain(); mute.gain.value=0;
    processor.onaudioprocess=e=>{ const input=e.inputBuffer.getChannelData(0); const samples=new Int16Array(input.length); for(let i=0;i<input.length;i++){const v=Math.max(-1,Math.min(1,input[i]));samples[i]=v<0?v*32768:v*32767;} api.send('mic-chunk',samples.buffer); };
    source.connect(processor);processor.connect(mute);mute.connect(audio.destination);recording=true;
    $('listenBtn').classList.add('listening');text($('listenLabel'),'Listening');$('transcriptView').hidden=false;drawTranscript();text($('caption'),config.transcription==='deepgram'?'Listening · Deepgram':'Listening · Local Whisper');notice('');
  } catch(e){stop();notice(e.message);} finally {starting=false;}
}
function askBox(){ $('settings').hidden=true;$('ask').hidden=false;api.send('focus');$('askInput').focus(); }
function render(turn){
  const answers = $('answers');
  const follow = answers.scrollHeight - answers.scrollTop - answers.clientHeight < 48;
  renderMarkdown(turn.body, turn.value);
  if (follow) answers.scrollTop = answers.scrollHeight;
}
function answer(question='', withScreen=true){
  $('settings').hidden=true;$('ask').hidden=true;$('answers').hidden=false; notice('');
  if(current){ const old=turns.get(current);if(old){old.status.hidden=true;} }
  const id=crypto.randomUUID(), el=document.createElement('article'); el.className='turn';
  const q=document.createElement('div');q.className='q';text(q,(question || 'Help with the latest question') + (screenshotEntries.length ? ` · ${screenshotEntries.length} screenshot${screenshotEntries.length === 1 ? '' : 's'}` : ''));
  const body=document.createElement('div');body.className='md'; const status=document.createElement('div');status.className='status';text(status,'Reading context…');el.append(q,body,status);$('answers').append(el);
  while($('answers').children.length>12)$('answers').firstElementChild.remove();
  turns.set(id,{el,body,status,value:''});current=id;
  api.send('answer',{id,transcript:transcript(),question,withScreen:withScreen && $('includeScreen').checked});
}
api.on('ai-step',({id,step})=>{const t=turns.get(id);if(t){t.status.hidden=false;text(t.status,({screen:'Reading screen…',skill:'Reading skill…',context:'Reading project context…'})[step]||'Thinking…');}});
api.on('ai-delta',({id,text:delta})=>{const t=turns.get(id);if(!t)return;t.value+=delta;t.status.hidden=true;render(t);});
api.on('ai-done',({id})=>{const t=turns.get(id);if(t){t.status.hidden=true;if(!t.value)text(t.body,'No answer returned. Try asking again.');}if(current===id)current=null;});
api.on('ai-error',({id,error})=>{const t=turns.get(id);if(t){t.status.hidden=true;const e=document.createElement('div');e.className='err';text(e,error);t.el.append(e);}else notice(error);if(current===id)current=null;});
api.on('status',s=>{if(s.error)notice(s.error);else if(s.message)notice(s.message);});
function choose(id,value){document.querySelectorAll(`#${id} button`).forEach(b=>b.classList.toggle('on',b.dataset.v===value));}
function provider(){ $('deepgramField').hidden=config.transcription!=='deepgram'; text($('transcriptionNote'),config.transcription==='deepgram'?'Audio is sent to Deepgram for transcription.':'Runs on this Mac. No key or transcription bill. Text appears after a short pause.'); const isApi=config.provider==='api';$('anthropicField').hidden=!isApi;$('harnessField').hidden=isApi;text($('providerNote'),isApi?'Uses your Anthropic API billing.':'Uses the Claude Code login on this Mac and your plan’s usage limits.');}
async function settings(){try{config=await api.invoke('get-settings');$('welcome').hidden=!!config.onboardingDone;if(!config.claudeFound && !config.onboardingDone)config.provider='api';for(const k of ['deepgramKey','anthropicKey','about'])$(k).value=config[k]||'';$('useHarness').checked=config.useHarness!==false;$('projectPath').value=config.projectPath||'';harness();choose('providerSeg',config.provider);choose('modelSeg',config.model);choose('transcriptionSeg',config.transcription || 'local');provider();$('settings').hidden=false;$('ask').hidden=true;$('answers').hidden=true;$('transcriptView').hidden=true;api.send('focus');}catch(e){notice(e.message);}}
for(const [id,key] of [['providerSeg','provider'],['modelSeg','model'],['transcriptionSeg','transcription']])$(id).addEventListener('click',e=>{const b=e.target.closest('button[data-v]');if(!b)return;config[key]=b.dataset.v;choose(id,config[key]);provider();});
$('saveSettings').onclick=async()=>{try{if(config.provider==='api'&&!$('anthropicKey').value.trim())throw new Error('Add an Anthropic API key to get answers.');if(config.provider==='max'&&!config.claudeFound)throw new Error('Claude Code was not found. Choose Anthropic API key, or install Claude Code and reopen Aside.');const next={provider:config.provider,model:config.model,transcription:config.transcription || 'local',onboardingDone:true,useHarness:$('useHarness').checked,projectPath:$('projectPath').value};for(const k of ['deepgramKey','anthropicKey','about'])next[k]=$(k).value;const result=await api.invoke('save-settings',next);if(!result.ok)throw new Error(result.error||'Could not save settings');$('settings').hidden=true;notice('Settings saved.');if(recording)stop();}catch(e){notice(e.message);}};
function harness(){
  $('projectField').hidden=!$('useHarness').checked;
  $('clearProject').hidden=!$('projectPath').value;
  $('projectPath').title=$('projectPath').value;
}
$('useHarness').onchange=harness;
$('pickProject').onclick=async()=>{
  try{
    const selected=await api.invoke('pick-project');
    if(selected?.path){$('projectPath').value=selected.path;harness();}
  }catch(e){notice(e.message);}
};
$('clearProject').onclick=()=>{$('projectPath').value='';harness();};
$('cancelSettings').onclick=()=>{$('settings').hidden=true;};
function clear(){transcriptEpoch++;api.send('clear');lines=[];interim={};turns.clear();current=null;$('answers').replaceChildren();$('answers').hidden=true;text($('caption'),'');drawTranscript();notice('');}
$('listenBtn').onclick=listen;$('answerBtn').onclick=()=>answer();$('askBtn').onclick=askBox;$('settingsBtn').onclick=settings;$('hideBtn').onclick=()=>api.send('hide');$('quitBtn').onclick=()=>api.send('quit');
$('recapBtn').onclick=()=>answer('Summarize this conversation, decisions, open questions, and next steps with owners where stated. Draft a concise follow-up message for me to review. Do not invent details.',false);
$('transcriptBtn').onclick=()=>{$('transcriptView').hidden=!$('transcriptView').hidden;drawTranscript();};
$('askInput').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();const q=e.target.value.trim();if(q){answer(q);e.target.value='';}}if(e.key==='Escape'){$('ask').hidden=true;api.send('blur');}});
document.addEventListener('click',e=>{const a=e.target.closest('[data-href],a[href]');if(!a)return;e.preventDefault();const url=a.dataset.href||a.getAttribute('href');if(url&&url!=='#')api.send('open-external',url);});
api.on('hotkey',action=>{if(action==='screenshots-preview')toggleScreenshots(true);if(action==='answer')answer();if(action==='ask')askBox();if(action==='listen')listen();if(action==='settings')settings();if(action==='clear')clear();if(action==='scroll-up')$('answers').scrollBy(0,-240);if(action==='scroll-down')$('answers').scrollBy(0,240);});
window.addEventListener('beforeunload',stop);
drawTranscript();
api.invoke('get-settings').then(s=>{config=s;transcriptEpoch=s.transcriptEpoch ?? 0;if(!s.onboardingDone){settings();return;}if(!s.claudeFound&&s.provider==='max')notice('Install and sign in to Claude Code, or choose an API key in Settings.');else text($('caption'),'Ready · Ask anything');}).catch(e=>notice(e.message));
