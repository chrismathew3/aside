const fs=require('node:fs');
const assert=require('node:assert/strict');
const path=require('node:path');
const {createLocalTranscriber}=require('../local-transcriber');
const pcm=process.env.ASIDE_TEST_PCM ? fs.readFileSync(process.env.ASIDE_TEST_PCM) : require('./audio-fixture.cjs')();
const entries=[];
const transcriber=createLocalTranscriber({
 who:'me',binary:fs.existsSync('bin/whisper-cli') ? path.resolve('bin/whisper-cli') : '/opt/homebrew/bin/whisper-cli',model:path.resolve('models/ggml-base.en.bin'),
 onTranscript(entry){entries.push(entry);},onError(error){console.error(error);process.exitCode=1;},
});
transcriber.write(Buffer.concat([pcm,Buffer.alloc(48000*2)]));
const timer=setInterval(()=>{
 if(entries.length){clearInterval(timer);clearTimeout(timeout);transcriber.close();const all=entries.map(e=>e.text).join(' ');assert.match(all,/technical architecture/i);assert.equal(entries[0].who,'me');assert.equal(entries[0].final,true);console.log('PASS local real transcription:',all);}
},100);
const timeout=setTimeout(()=>{clearInterval(timer);transcriber.close();console.error('FAIL local transcription timed out');process.exitCode=1;},30000);
