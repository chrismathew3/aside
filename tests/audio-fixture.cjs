const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
module.exports = function audioFixture(phrase = 'We need to explain the technical architecture and agree on the next steps.') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-fixture-'));
  try {
    const aiff = path.join(dir, 'sample.aiff');
    const wav = path.join(dir, 'sample.wav');
    execFileSync('/usr/bin/say', ['-o', aiff, phrase]);
    execFileSync('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@24000', '-c', '1', aiff, wav]);
    const data = fs.readFileSync(wav);
    for (let offset = 12; offset + 8 <= data.length;) {
      const size = data.readUInt32LE(offset + 4);
      if (data.toString('ascii', offset, offset + 4) === 'data') return Buffer.from(data.subarray(offset + 8, offset + 8 + size));
      offset += 8 + size + (size % 2);
    }
    throw new Error('Generated WAV has no audio data.');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};
