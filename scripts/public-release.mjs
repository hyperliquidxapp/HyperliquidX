import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

export const publicRepository = 'hyperliquidxapp/HyperliquidX';
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const fields = ['version', 'name', 'body', 'url', 'sha256', 'size', 'architectures', 'signing', 'notarized'];

export function validatePublicRelease(data) {
  if (!data || Object.keys(data).some(key => !fields.includes(key)) || !stable.test(data.version) ||
      !/^[a-f0-9]{64}$/.test(data.sha256) || !Number.isSafeInteger(data.size) || data.size <= 0 ||
      data.url !== `https://downloads.hypexapp.xyz/releases/${data.version}/${data.sha256}/HyperliquidX-${data.version}.dmg` ||
      typeof data.name !== 'string' || !data.name.trim() || typeof data.body !== 'string' ||
      !data.body.includes(data.url) || !data.body.includes(data.sha256) ||
      /https?:\/\/(?:api\.)?github\.com\/(?:repos\/)?hyperliquidxapp\/HyperliquidXApp\b/i.test(data.body) ||
      /\b[a-f0-9]{40}\b/i.test(data.body) ||
      !['ad-hoc', 'developer-id'].includes(data.signing) || typeof data.notarized !== 'boolean' ||
      !Array.isArray(data.architectures) || !data.architectures.length ||
      data.architectures.some(arch => !['arm64', 'x86_64'].includes(arch))) {
    throw new Error('Invalid public release metadata or private data included');
  }
  return data;
}

export function compareVersions(left, right) {
  const a = left.split('.').map(BigInt);
  const b = right.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

export function assertPublicTree(paths) {
  if (paths.some(path => /(^|\/)(App|Sources|Tests|[^/]+\.xcodeproj|[^/]+\.app)(\/|$)/.test(path) ||
      /(^|\/)(Package\.swift|Cargo\.toml)$/.test(path))) {
    throw new Error('Refusing to tag a public commit containing application source or build products');
  }
}

function githubApi(endpoint, { method = 'GET', data } = {}) {
  const args = ['api', endpoint, '--method', method];
  if (data !== undefined) args.push('--input', '-');
  return JSON.parse(execFileSync('gh', args, {
    encoding: 'utf8', input: data === undefined ? undefined : JSON.stringify(data),
    stdio: ['pipe', 'pipe', 'inherit'],
  }));
}

export async function verifyFile(file, release) {
  if ((await stat(file)).size !== release.size) throw new Error('DMG size mismatch');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (hash.digest('hex') !== release.sha256) throw new Error('DMG SHA-256 mismatch');
}

export async function publishPublicRelease(release, {
  repository, targetCommit, api = githubApi, fetchDownload = fetch,
  checkTree = () => assertPublicTree(execFileSync('git', ['ls-tree', '-r', '--name-only', targetCommit],
    { encoding: 'utf8' }).trim().split('\n')),
  upload = (tag, files) => execFileSync('gh', ['release', 'upload', tag, ...files, '--repo', repository, '--clobber'],
    { stdio: 'inherit' }),
}) {
  validatePublicRelease(release);
  if (repository !== publicRepository || !/^[a-f0-9]{40}$/.test(targetCommit || '')) {
    throw new Error('Only the public issue repository and a resolved public commit are allowed');
  }
  const repo = await api(`repos/${repository}`);
  if (repo.private !== false) throw new Error('Release destination must be public');
  await checkTree();
  const prefix = `repos/${repository}/releases`;
  const existing = await api(`${prefix}?per_page=100`);
  const tag = `v${release.version}`;
  let current = existing.find(item => item.tag_name === tag);
  if (current?.prerelease) throw new Error('Refusing to replace a prerelease with a stable release');
  const filename = `HyperliquidX-${release.version}.dmg`;
  const checksumDigest = createHash('sha256').update(`${release.sha256}  ${filename}\n`).digest('hex');
  if (current && !current.draft && current.name === release.name && current.body === release.body &&
      current.assets?.some(asset => asset.name === filename && asset.size === release.size && asset.digest === `sha256:${release.sha256}`) &&
      current.assets?.some(asset => asset.name === `${filename}.sha256` && asset.digest === `sha256:${checksumDigest}`)) {
    return current.html_url;
  }
  const latest = !existing.some(item => !item.draft && !item.prerelease &&
    stable.test(item.tag_name.slice(1)) && compareVersions(item.tag_name.slice(1), release.version) > 0);
  const directory = await mkdtemp(join(tmpdir(), 'hyperliquidx-public-release-'));
  try {
    const file = join(directory, filename);
    const checksum = `${file}.sha256`;
    const response = await fetchDownload(release.url, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok || !response.body) throw new Error(`Public DMG download HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(file));
    await verifyFile(file, release);
    await writeFile(checksum, `${release.sha256}  HyperliquidX-${release.version}.dmg\n`);
    if (!current) {
      current = await api(prefix, { method: 'POST', data: {
        tag_name: tag, target_commitish: targetCommit, name: release.name, body: release.body,
        draft: true, prerelease: false,
      } });
    }
    await upload(tag, [file, checksum]);
    const updated = await api(`${prefix}/${current.id}`, { method: 'PATCH', data: {
      name: release.name, body: release.body, draft: false, prerelease: false,
      make_latest: latest ? 'true' : 'false',
    } });
    if (updated.tag_name !== tag || updated.body !== release.body || updated.draft) {
      throw new Error('Public GitHub Release did not save the expected metadata');
    }
    return updated.html_url;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tag = process.env.RELEASE_TAG || '';
  if (tag && (!tag.startsWith('v') || !stable.test(tag.slice(1)))) throw new Error('Invalid release tag');
  const files = tag ? [`${tag}.json`] : (await readdir('releases')).filter(file => /^v\d+\.\d+\.\d+\.json$/.test(file));
  const releases = await Promise.all(files.map(async file => {
    const data = validatePublicRelease(JSON.parse(await readFile(join('releases', file), 'utf8')));
    if (file !== `v${data.version}.json`) throw new Error('Release metadata filename/version mismatch');
    return data;
  }));
  releases.sort((a, b) => compareVersions(a.version, b.version));
  for (const release of releases) {
    console.log(await publishPublicRelease(release, {
      repository: process.env.GITHUB_REPOSITORY, targetCommit: process.env.GITHUB_SHA,
    }));
  }
}
