'use strict';

const { randomUUID } = require('node:crypto');

// Capture requests run in order. The queue stays in memory for this app session.
function createScreenshotQueue({ capture, onChange = () => {}, max = 8 }) {
  if (typeof capture !== 'function') throw new TypeError('A screenshot capture function is required.');
  if (!Number.isInteger(max) || max < 1) throw new TypeError('Screenshot limit must be a positive integer.');
  let entries = [];
  let epoch = 0;
  let tail = Promise.resolve();
  const snapshot = () => entries.map(entry => ({ ...entry }));
  const changed = () => onChange(snapshot());
  const cancelled = () => Object.assign(new Error('Screenshot capture was cleared. Capture another view when ready.'), { code: 'CAPTURE_CLEARED' });

  function captureNext() {
    const requestedEpoch = epoch;
    const job = tail.then(async () => {
      if (requestedEpoch !== epoch) throw cancelled();
      if (entries.length >= max) {
        throw Object.assign(new Error(`You already have ${max} screenshots. Remove one or send this set first.`), { code: 'QUEUE_FULL' });
      }
      const data = await capture();
      if (requestedEpoch !== epoch) throw cancelled();
      if (typeof data !== 'string' || !data.trim()) {
        throw Object.assign(new Error('The screenshot was blank. Check Screen Recording permission and try again.'), { code: 'CAPTURE_BLANK' });
      }
      const entry = { id: randomUUID(), data, capturedAt: new Date().toISOString() };
      entries.push(entry);
      changed();
      return { ...entry };
    });
    // A failed capture never poisons later requests or leaves a rejected internal tail.
    tail = job.catch(() => {});
    return job;
  }

  function remove(id) {
    const index = entries.findIndex(entry => entry.id === id);
    if (index < 0) return false;
    entries.splice(index, 1);
    changed();
    return true;
  }

  function removeLast() {
    if (!entries.length) return null;
    const entry = entries.pop();
    changed();
    return { ...entry };
  }

  function clear() {
    epoch += 1; // Invalidate active and queued captures, including an empty queue.
    entries = [];
    changed();
  }

  function consume(ids) {
    const sent = new Set(ids);
    const remaining = entries.filter(entry => !sent.has(entry.id));
    if (remaining.length === entries.length) return;
    entries = remaining;
    changed();
  }

  // Return the current tail, rather than following captures requested later.
  const settled = () => tail;

  return { capture: captureNext, settled, snapshot, remove, removeLast, clear, consume };
}

module.exports = { createScreenshotQueue };
