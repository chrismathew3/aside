'use strict';
const $ = (id) => document.getElementById(id);
const api = window.aside;
let config = {}, recording = false, starting = false, audio, stream, processor, source, mute;
let transcriptEpoch = 0;
let lines = [], interim = {}, turns = new Map(), current = null;
const text = (el, value) => { el.textContent = value; };
function notice(message) { text($('notice'), message || ''); $('notice').hidden = !message; }
function resize() { api.send('resize', { height: Math.min(850, $('panel').getBoundingClientRect().height + 2) }); }
new ResizeObserver(resize).observe($('panel'));
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
function render(turn){ turn.body.innerHTML=DOMPurify.sanitize(marked.parse(turn.value)); $('answers').scrollTop=$('answers').scrollHeight; }
function answer(question='', withScreen=true){
  $('settings').hidden=true;$('ask').hidden=true;$('answers').hidden=false; notice('');
  if(current){ const old=turns.get(current);if(old){old.status.hidden=true;} }
  const id=crypto.randomUUID(), el=document.createElement('article'); el.className='turn';
  const q=document.createElement('div');q.className='q';text(q,question || 'Help with the latest question');
  const body=document.createElement('div');body.className='md'; const status=document.createElement('div');status.className='status';text(status,'Reading context…');el.append(q,body,status);$('answers').append(el);
  while($('answers').children.length>12)$('answers').firstElementChild.remove();
  turns.set(id,{el,body,status,value:''});current=id;
  api.send('answer',{id,transcript:transcript(),question,withScreen:withScreen && $('includeScreen').checked});
}
api.on('ai-step',({id,step})=>{const t=turns.get(id);if(t)text(t.status,step==='screen'?'Reading screen…':'Thinking…');});
api.on('ai-delta',({id,text:delta})=>{const t=turns.get(id);if(!t)return;t.value+=delta;t.status.hidden=true;render(t);});
api.on('ai-done',({id})=>{const t=turns.get(id);if(t){t.status.hidden=true;if(!t.value)text(t.body,'No answer returned. Try asking again.');}if(current===id)current=null;});
api.on('ai-error',({id,error})=>{const t=turns.get(id);if(t){t.status.hidden=true;const e=document.createElement('div');e.className='err';text(e,error);t.el.append(e);}else notice(error);if(current===id)current=null;});
api.on('status',s=>{if(s.error)notice(s.error);else if(s.message)notice(s.message);});
function choose(id,value){document.querySelectorAll(`#${id} button`).forEach(b=>b.classList.toggle('on',b.dataset.v===value));}
function provider(){ $('deepgramField').hidden=config.transcription!=='deepgram'; text($('transcriptionNote'),config.transcription==='deepgram'?'Audio is sent to Deepgram for transcription.':'Runs on this Mac. No key or transcription bill. Text appears after a short pause.'); const isApi=config.provider==='api';$('anthropicField').hidden=!isApi;text($('providerNote'),isApi?'Uses your Anthropic API billing.':'Uses the Claude Code login on this Mac and your plan’s usage limits.');}
async function settings(){try{config=await api.invoke('get-settings');$('welcome').hidden=!!config.onboardingDone;if(!config.claudeFound && !config.onboardingDone)config.provider='api';for(const k of ['deepgramKey','anthropicKey','about'])$(k).value=config[k]||'';choose('providerSeg',config.provider);choose('modelSeg',config.model);choose('transcriptionSeg',config.transcription || 'local');provider();$('settings').hidden=false;$('ask').hidden=true;$('answers').hidden=true;$('transcriptView').hidden=true;api.send('focus');}catch(e){notice(e.message);}}
for(const [id,key] of [['providerSeg','provider'],['modelSeg','model'],['transcriptionSeg','transcription']])$(id).addEventListener('click',e=>{const b=e.target.closest('button[data-v]');if(!b)return;config[key]=b.dataset.v;choose(id,config[key]);provider();});
$('saveSettings').onclick=async()=>{try{if(config.provider==='api'&&!$('anthropicKey').value.trim())throw new Error('Add an Anthropic API key to get answers.');if(config.provider==='max'&&!config.claudeFound)throw new Error('Claude Code was not found. Choose Anthropic API key, or install Claude Code and reopen Aside.');const next={provider:config.provider,model:config.model,transcription:config.transcription || 'local',onboardingDone:true};for(const k of ['deepgramKey','anthropicKey','about'])next[k]=$(k).value;const result=await api.invoke('save-settings',next);if(!result.ok)throw new Error(result.error||'Could not save settings');$('settings').hidden=true;notice('Settings saved.');if(recording)stop();}catch(e){notice(e.message);}};
$('cancelSettings').onclick=()=>{$('settings').hidden=true;};
function clear(){transcriptEpoch++;api.send('clear');lines=[];interim={};turns.clear();current=null;$('answers').replaceChildren();$('answers').hidden=true;text($('caption'),'');drawTranscript();notice('');}
$('listenBtn').onclick=listen;$('answerBtn').onclick=()=>answer();$('askBtn').onclick=askBox;$('settingsBtn').onclick=settings;$('hideBtn').onclick=()=>api.send('hide');$('quitBtn').onclick=()=>api.send('quit');
$('recapBtn').onclick=()=>answer('Summarize this conversation, decisions, open questions, and next steps with owners where stated. Draft a concise follow-up message for me to review. Do not invent details.',false);
$('transcriptBtn').onclick=()=>{$('transcriptView').hidden=!$('transcriptView').hidden;drawTranscript();};
$('askInput').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();const q=e.target.value.trim();if(q){answer(q);e.target.value='';}}if(e.key==='Escape'){$('ask').hidden=true;api.send('blur');}});
document.addEventListener('click',e=>{const a=e.target.closest('[data-href],a[href]');if(!a)return;e.preventDefault();const url=a.dataset.href||a.getAttribute('href');if(url&&url!=='#')api.send('open-external',url);});
api.on('hotkey',action=>{if(action==='answer')answer();if(action==='ask')askBox();if(action==='listen')listen();if(action==='settings')settings();if(action==='clear')clear();if(action==='scroll-up')$('answers').scrollBy(0,-240);if(action==='scroll-down')$('answers').scrollBy(0,240);});
window.addEventListener('beforeunload',stop);
drawTranscript();
api.invoke('get-settings').then(s=>{config=s;transcriptEpoch=s.transcriptEpoch ?? 0;if(!s.onboardingDone){settings();return;}if(!s.claudeFound&&s.provider==='max')notice('Install and sign in to Claude Code, or choose an API key in Settings.');else text($('caption'),'Ready · Ask anything');}).catch(e=>notice(e.message));
