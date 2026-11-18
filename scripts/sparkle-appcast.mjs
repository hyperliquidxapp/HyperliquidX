import { execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { compareVersions, publicRepository } from './public-release.mjs';
import { validateSparkleMetadata } from './sparkle-signature.mjs';

const stableTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const escapeXML = value => String(value).replace(/[<>&"']/g, character => ({
  '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
})[character]);
const cdata = value => `<![CDATA[${value.replaceAll(']]>', ']]]]><![CDATA[>')}]]>`;

function githubApi(endpoint, data) {
  const args = ['api', endpoint];
  if (data !== undefined) args.push('--method', 'POST', '--input', '-');
  return execFileSync('gh', args, {
    encoding: 'utf8', input: data === undefined ? undefined : JSON.stringify(data),
    stdio: ['pipe', 'pipe', 'inherit'],
  });
}

export async function buildAppcast(releases, renderMarkdown, metadata = []) {
  const published = releases.filter(release => !release.draft && !release.prerelease &&
    stableTag.test(release.tag_name) && release.published_at &&
    release.assets?.some(asset => asset.name === `HyperliquidX-${release.tag_name.slice(1)}.dmg`));
  published.sort((a, b) => compareVersions(b.tag_name.slice(1), a.tag_name.slice(1)));
  if (!published.length) throw new Error('No published stable releases with a DMG');
  const items = [];
  for (const release of published) {
    const version = release.tag_name.slice(1);
    const url = `https://github.com/${publicRepository}/releases/tag/${release.tag_name}`;
    if (release.html_url !== url || !Number.isFinite(Date.parse(release.published_at))) {
      throw new Error('Invalid public release URL or publication date');
    }
    // GitHub renders and sanitizes the same authored Markdown displayed on the release page.
    const notes = await renderMarkdown(release.body || release.name || release.tag_name);
    const manifest = metadata.find(item => item.version === version);
    const signed = manifest?.sparkle && validateSparkleMetadata(manifest.sparkle, version);
    if (signed && !release.assets.some(asset => asset.name === `HyperliquidX-${version}.dmg` &&
        asset.size === manifest.size && asset.digest === `sha256:${manifest.sha256}`)) {
      throw new Error('Signed installer metadata does not match the published GitHub asset');
    }
    if (signed && manifest.url !== `https://downloads.hypexapp.xyz/releases/${version}/${manifest.sha256}/HyperliquidX-${version}.dmg`) {
      throw new Error('Unexpected signed installer URL');
    }
    const enclosure = signed ? `\n      <enclosure url="${escapeXML(manifest.url)}" sparkle:edSignature="${signed.edSignature}" length="${manifest.size}" type="application/octet-stream" />` : '';
    items.push(`    <item>
      <title>${escapeXML(release.name || `HyperliquidX ${version}`)}</title>
      <sparkle:version>${signed ? signed.bundleVersion : version}</sparkle:version>
      <sparkle:shortVersionString>${version}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>14.0.0</sparkle:minimumSystemVersion>
      <pubDate>${new Date(release.published_at).toUTCString()}</pubDate>
      <link>${escapeXML(url)}</link>
      <description>${cdata(notes)}</description>${enclosure}
    </item>`);
  }
  // Older releases remain informational. Only verified, signed installers receive enclosures.
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>HyperliquidX Updates</title>
    <link>https://github.com/${publicRepository}/releases</link>
    <description>Stable HyperliquidX releases for macOS</description>
    <language>en</language>
${items.join('\n')}
  </channel>
</rss>
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pages = JSON.parse(githubApi(`repos/${publicRepository}/releases?per_page=100`));
  const metadata = await Promise.all((await readdir('releases')).filter(file => /^v\d+\.\d+\.\d+\.json$/.test(file))
    .map(async file => JSON.parse(await readFile(`releases/${file}`, 'utf8'))));
  const appcast = await buildAppcast(pages, text => githubApi('markdown', {
    text, mode: 'gfm', context: publicRepository,
  }), metadata);
  await writeFile('appcast.xml', appcast);
}
