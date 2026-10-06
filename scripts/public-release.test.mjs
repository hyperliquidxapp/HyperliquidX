import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { assertPublicTree, compareVersions, publicRepository, publishPublicRelease, validatePublicRelease } from './public-release.mjs';

const content = Buffer.from('A test installer');
const sha256 = createHash('sha256').update(content).digest('hex');
const url = `https://downloads.hypexapp.xyz/releases/0.1.1/${sha256}/HyperliquidX-0.1.1.dmg`;
const release = {
  version: '0.1.1', name: 'HyperliquidX 0.1.1', body: `Fixes startup.\n\n${url}\n${sha256}`,
  url, sha256, size: content.length, signing: 'ad-hoc', notarized: false, architectures: ['arm64', 'x86_64'],
};
const targetCommit = 'c'.repeat(40);

function scenario({ existing = [], download = content, isPrivate = false } = {}) {
  const calls = [];
  const uploaded = [];
  const options = {
    repository: publicRepository, targetCommit, checkTree: () => assertPublicTree(['README.md', 'screenshots/app-icon.png']),
    api: async (endpoint, request = {}) => {
      calls.push({ endpoint, ...request });
      if (endpoint === `repos/${publicRepository}`) return { private: isPrivate };
      if (request.method === 'POST') return { id: 77, ...request.data };
      if (request.method === 'PATCH') return { ...request.data, tag_name: 'v0.1.1', html_url: 'public-release-url' };
      return existing;
    },
    fetchDownload: async () => new Response(download),
    upload: async (tag, files) => {
      for (const file of files) uploaded.push({ tag, name: basename(file), content: await readFile(file) });
    },
  };
  return { options, calls, uploaded };
}

test('public metadata has a strict field list and rejects private IDs, links and invalid installer URLs', () => {
  assert.equal(validatePublicRelease(release), release);
  for (const change of [
    { sourceCommit: targetCommit }, { source: 'Swift source' }, { version: '../0.1.1' },
    { sha256: 'broken' }, { size: 0 }, { architectures: ['unknown'] },
    { body: release.body + '\nhttps://github.com/hyperliquidxapp/HyperliquidXApp/compare/v0.1.0...v0.1.1' },
    { body: release.body + '\n' + targetCommit },
    { url: 'https://example.com/HyperliquidX-0.1.1.dmg' },
  ]) assert.throws(() => validatePublicRelease({ ...release, ...change }));
});

test('source and build product paths cannot be included in a public release tag', () => {
  assertPublicTree(['README.md', '.github/workflows/public-release.yml', 'releases/v0.1.1.json']);
  for (const file of ['Sources/HyperliquidApp/main.swift', 'App/secret.txt', 'Package.swift',
    'Tests/Test.swift', 'HyperliquidX.xcodeproj/project.pbxproj', 'dist/HyperliquidX.app/Contents/MacOS/app']) {
    assert.throws(() => assertPublicTree(['README.md', file]), /application source/);
  }
});

test('installer verification happens before creating a draft, uploads only DMG and checksum, then publishes', async () => {
  const { options, calls, uploaded } = scenario();
  assert.equal(await publishPublicRelease(release, options), 'public-release-url');
  const creation = calls.find(call => call.method === 'POST');
  assert.equal(creation.data.target_commitish, targetCommit);
  assert.equal(creation.data.draft, true);
  assert.equal(creation.data.tag_name, 'v0.1.1');
  assert.deepEqual(uploaded.map(file => file.name), ['HyperliquidX-0.1.1.dmg', 'HyperliquidX-0.1.1.dmg.sha256']);
  assert.deepEqual(uploaded[0].content, content);
  assert.equal(uploaded[1].content.toString(), `${sha256}  HyperliquidX-0.1.1.dmg\n`);
  assert.equal(calls.at(-1).data.draft, false);
  assert.equal(calls.at(-1).data.make_latest, 'true');
});

test('corrupt or truncated public downloads do not create a tag or publish a release', async () => {
  for (const download of [Buffer.from('A wrong download'), Buffer.from('short')]) {
    const { options, calls, uploaded } = scenario({ download });
    await assert.rejects(publishPublicRelease(release, options), /mismatch/);
    assert.ok(!calls.some(call => call.method === 'POST' || call.method === 'PATCH'));
    assert.equal(uploaded.length, 0);
  }
});

test('retry updates the same release and older releases cannot displace newer Latest', async () => {
  const { options, calls } = scenario({ existing: [
    { id: 77, tag_name: 'v0.1.1', draft: false, prerelease: false },
    { id: 88, tag_name: 'v0.2.0', draft: false, prerelease: false },
  ] });
  await publishPublicRelease(release, options);
  assert.ok(!calls.some(call => call.method === 'POST'));
  assert.equal(calls.at(-1).endpoint, `repos/${publicRepository}/releases/77`);
  assert.equal(calls.at(-1).data.make_latest, 'false');
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
});

test('unchanged releases skip installer upload when both asset digests already match', async () => {
  const checksumDigest = createHash('sha256').update(`${sha256}  HyperliquidX-0.1.1.dmg\n`).digest('hex');
  const { options, calls, uploaded } = scenario({ existing: [{ ...release, id: 77, tag_name: 'v0.1.1',
    draft: false, prerelease: false, html_url: 'already-published', assets: [
      { name: 'HyperliquidX-0.1.1.dmg', size: release.size, digest: `sha256:${sha256}` },
      { name: 'HyperliquidX-0.1.1.dmg.sha256', digest: `sha256:${checksumDigest}` },
    ] }] });
  assert.equal(await publishPublicRelease(release, options), 'already-published');
  assert.equal(uploaded.length, 0);
  assert.ok(!calls.some(call => call.method === 'POST' || call.method === 'PATCH'));
});

test('publisher refuses private destinations and a commit tree containing app source', async () => {
  const privateScenario = scenario({ isPrivate: true });
  await assert.rejects(publishPublicRelease(release, privateScenario.options), /must be public/);
  const wrongRepo = scenario();
  await assert.rejects(publishPublicRelease(release, { ...wrongRepo.options, repository: 'hyperliquidxapp/HyperliquidXApp' }), /Only the public/);
  assert.equal(wrongRepo.calls.length, 0);
  const sourceTree = scenario();
  await assert.rejects(publishPublicRelease(release, { ...sourceTree.options, checkTree: () => assertPublicTree(['Sources/main.swift']) }), /application source/);
  assert.equal(sourceTree.calls.length, 1);
});
