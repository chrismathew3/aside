const test = require('node:test');
const assert = require('node:assert/strict');
const { createScreenshotQueue } = require('../screenshot-queue');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

// No real desktop capture is needed to exercise ordering and asynchronous races.
test('serializes overlapping captures in request order and caps without capturing again', async () => {
  const pending = [deferred(), deferred()];
  const changes = [];
  let calls = 0;
  const queue = createScreenshotQueue({ capture: () => pending[calls++].promise, onChange: entries => changes.push(entries), max: 2 });
  const first = queue.capture(), second = queue.capture(), third = queue.capture();
  await Promise.resolve();
  assert.equal(calls, 1);
  pending[0].resolve('first');
  const a = await first;
  await Promise.resolve();
  assert.equal(calls, 2);
  pending[1].resolve('second');
  const b = await second;
  await assert.rejects(third, { code: 'QUEUE_FULL' });
  assert.equal(calls, 2);
  assert.deepEqual(queue.snapshot().map(entry => entry.data), ['first', 'second']);
  assert.notEqual(a.id, b.id);
  assert.ok(Number.isFinite(Date.parse(a.capturedAt)));
  assert.deepEqual(changes.map(entries => entries.length), [1, 2]);
});

test('clear invalidates in-flight and waiting captures so screenshots cannot reappear', async () => {
  const pending = deferred();
  let calls = 0;
  const queue = createScreenshotQueue({ capture: () => { calls++; return calls === 1 ? pending.promise : 'new'; } });
  const first = queue.capture(), waiting = queue.capture();
  await Promise.resolve();
  queue.clear();
  pending.resolve('old');
  await assert.rejects(first, { code: 'CAPTURE_CLEARED' });
  await assert.rejects(waiting, { code: 'CAPTURE_CLEARED' });
  assert.equal(calls, 1);
  assert.deepEqual(queue.snapshot(), []);
  await queue.capture();
  assert.deepEqual(queue.snapshot().map(entry => entry.data), ['new']);
});

test('consuming the submitted snapshot preserves screenshots captured during an answer', async () => {
  let sequence = 0;
  const queue = createScreenshotQueue({ capture: async () => `image-${++sequence}` });
  await queue.capture();
  await queue.capture();
  const submitted = queue.snapshot();
  const later = await queue.capture();
  queue.consume(submitted.map(entry => entry.id));
  assert.deepEqual(queue.snapshot(), [later]);
  queue.consume(submitted.map(entry => entry.id));
  assert.deepEqual(queue.snapshot(), [later]);
});

test('blank and failed captures keep existing screenshots and allow subsequent captures', async () => {
  let attempt = 0;
  const queue = createScreenshotQueue({ capture: async () => {
    attempt++;
    if (attempt === 2) return null;
    if (attempt === 3) throw new Error('Permission denied');
    return `image-${attempt}`;
  } });
  const first = await queue.capture();
  await assert.rejects(queue.capture(), { code: 'CAPTURE_BLANK' });
  await assert.rejects(queue.capture(), /Permission denied/);
  assert.deepEqual(queue.snapshot(), [first]);
  await queue.capture();
  assert.equal(queue.snapshot().length, 2);
});

test('snapshots are independent copies and removal reports whether anything changed', async () => {
  let changes = 0;
  const queue = createScreenshotQueue({ capture: async () => 'image', onChange: () => changes++ });
  const first = await queue.capture();
  const snapshot = queue.snapshot();
  snapshot[0].data = 'modified';
  snapshot.pop();
  first.data = 'also modified';
  assert.equal(queue.snapshot()[0].data, 'image');
  assert.equal(queue.remove('missing'), false);
  assert.equal(changes, 1);
  assert.equal(queue.remove(first.id), true);
  assert.equal(changes, 2);
  assert.equal(queue.removeLast(), null);
  const second = await queue.capture();
  assert.deepEqual(queue.removeLast(), second);
  assert.deepEqual(queue.snapshot(), []);
});

test('settled waits for captures already requested without following later requests', async () => {
  const first = deferred(), second = deferred();
  let calls = 0;
  const queue = createScreenshotQueue({ capture: () => (++calls === 1 ? first.promise : second.promise) });
  const a = queue.capture();
  const priorCaptures = queue.settled();
  const b = queue.capture();
  first.resolve('first');
  await priorCaptures;
  assert.deepEqual(queue.snapshot().map(entry => entry.data), ['first']);
  second.resolve('second');
  await Promise.all([a, b, queue.settled()]);
  assert.equal(queue.snapshot().length, 2);
});
