// Review of PR #238, 4: the evidence screenshot after a sign-in. The stand-in page reads back what
// Nova set (its input and change events) and paints it in pure red onto a canvas, into CSS-generated
// content and into a closed shadow root. Nova measures every region that could show a saved value
// and paints over them in the PNG itself, after the capture. The test decodes Nova's screenshot and
// counts pure-red pixels: none. (Text masking alone, the old way, leaves them.) Runs where Chromium
// can start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng } from '../../src/core/browser/png.ts';
import { canBrowse, fakeLogin, filesHolding, startNova, startShop } from './m10b-support.ts';

const red = (png: Buffer) => {
  const img = decodePng(png);
  let n = 0;
  for (let i = 0; i < img.width * img.height; i++) {
    const o = i * img.channels;
    if (img.data[o]! >= 245 && img.data[o + 1]! <= 15 && img.data[o + 2]! <= 15) n++;
  }
  return n;
};

test('review 4: a page that paints the typed value onto a canvas, CSS content and a shadow root shows none of it in Nova’s screenshot', { timeout: 180_000 }, async (t) => {
  const why = await canBrowse();
  if (why) return t.skip(why);
  const cred = fakeLogin();
  const shop = await startShop({ ...cred });
  const n = await startNova('nova-m10b-mask-');
  try {
    const { m, api } = n;
    assert.equal((await m.send('PUT', api(`/browser/logins/${shop.host}`), cred)).status, 200);
    const { id } = await n.task({
      allowed_hosts: [shop.host],
      steps: [{ do: 'navigate', url: `${shop.url}/paint` }, { do: 'login', username: '#username', password: '#password', submit: '#signin', done_when: '#done:not([hidden])' }],
      verify: { url: `${shop.url}/paint`, expect: ['Paint'] },
    }, 'Sign in on the painting page');
    const done = await n.done(id!);
    assert.equal(done.state, 'done', `${done.reason}`);
    const png = readFileSync(join(m.home, 'workers', 'browser', id!, 'final.png'));
    assert.equal(red(png), 0, 'no pure-red pixel: nothing the page painted shows');
    const img = decodePng(png);
    assert.ok(img.width >= 1000, 'a real screenshot, decoded');
    // After a sign-in the picture is covered whole: the canvas, the CSS content, the shadow root
    // and the value split one letter per element, reversed and spaced, all under it.
    let grey = 0;
    for (let i = 0; i < img.width * img.height; i++) { const o = i * img.channels; if (img.data[o] === 96 && img.data[o + 1] === 96 && img.data[o + 2] === 96) grey++; }
    assert.equal(grey, img.width * img.height, 'every pixel covered');
    assert.deepEqual(filesHolding(m.dir, [cred.password, cred.username]), []);
  } finally {
    await n.close();
    await shop.close();
  }
});
