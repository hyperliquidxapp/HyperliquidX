import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAppcast } from './sparkle-appcast.mjs';

const release = version => ({
  tag_name: `v${version}`, name: `HyperliquidX ${version}`, body: `Notes for **${version}**`,
  html_url: `https://github.com/hyperliquidxapp/HyperliquidX/releases/tag/v${version}`,
  published_at: '2026-11-10T09:05:56Z', draft: false, prerelease: false,
  assets: [{ name: `HyperliquidX-${version}.dmg` }],
});

test('only stable published releases with installers are offered, newest semantic version first', async () => {
  const rendered = [];
  const xml = await buildAppcast([
    release('0.1.9'), { ...release('0.1.11'), draft: true },
    { ...release('0.1.12'), prerelease: true }, { ...release('0.1.13'), assets: [] },
    release('0.1.10'), { ...release('0.1.14'), tag_name: 'v0.1.14-beta' },
  ], body => { rendered.push(body); return `<p>${body}</p>`; });
  assert.deepEqual(rendered, ['Notes for **0.1.10**', 'Notes for **0.1.9**']);
  assert.ok(xml.indexOf('<sparkle:version>0.1.10') < xml.indexOf('<sparkle:version>0.1.9'));
  assert.match(xml, /<description><!\[CDATA\[<p>Notes for \*\*0.1.10\*\*<\/p>/);
  assert.match(xml, /<link>https:\/\/github.com\/hyperliquidxapp\/HyperliquidX\/releases\/tag\/v0.1.10<\/link>/);
  assert.doesNotMatch(xml, /<enclosure/);
  assert.match(xml, /<sparkle:minimumSystemVersion>14.0.0/);
});

test('untrusted titles and CDATA boundaries remain well-formed XML', async () => {
  const xml = await buildAppcast([{ ...release('1.0.0'), name: '<Title> & "notes"' }], () => '<p>]]></p>');
  assert.match(xml, /&lt;Title&gt; &amp; &quot;notes&quot;/);
  assert.match(xml, /\]\]\]\]><!\[CDATA\[>/);
});

test('invalid release URLs, dates and missing installers cannot generate an update feed', async () => {
  for (const change of [{ html_url: 'https://example.com' }, { published_at: 'not-a-date' }, { assets: [] }]) {
    await assert.rejects(buildAppcast([{ ...release('1.0.0'), ...change }], () => 'notes'));
  }
});

test('Markdown rendering failures leave the published feed untouched', async () => {
  await assert.rejects(buildAppcast([release('1.0.0')], () => { throw new Error('GitHub unavailable'); }),
    /GitHub unavailable/);
});
