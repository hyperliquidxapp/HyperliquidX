import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { compareVersions, publicRepository } from './public-release.mjs';

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

export async function buildAppcast(releases, renderMarkdown) {
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
    items.push(`    <item>
      <title>${escapeXML(release.name || `HyperliquidX ${version}`)}</title>
      <sparkle:version>${version}</sparkle:version>
      <sparkle:shortVersionString>${version}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>14.0.0</sparkle:minimumSystemVersion>
      <pubDate>${new Date(release.published_at).toUTCString()}</pubDate>
      <link>${escapeXML(url)}</link>
      <description>${cdata(notes)}</description>
    </item>`);
  }
  // Informational updates use Sparkle's release-notes UI and open the verified public
  // release page for downloading. No unsigned archive is offered for in-app installation.
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
  const appcast = await buildAppcast(pages, text => githubApi('markdown', {
    text, mode: 'gfm', context: publicRepository,
  }));
  await writeFile('appcast.xml', appcast);
}
