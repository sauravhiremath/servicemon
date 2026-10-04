import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { manifest: { type: 'string' } } });
assert(values.manifest, 'Use --manifest with a checked source archive.');
const manifest = JSON.parse(readFileSync(values.manifest, 'utf8'));
assert.match(manifest.commit, /^[a-f0-9]{40}$/);
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const pkg = JSON.parse(git('show', `${manifest.commit}:package.json`));
assert.equal(manifest.version, pkg.version);
const repository = pkg.repository.url.replace(/\.git$/, '');
const previous = git(
  'tag',
  '--merged',
  manifest.commit,
  '--list',
  'v[0-9]*',
  '--sort=-version:refname',
)
  .split('\n')
  .find((tag) => /^v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(tag) && tag !== `v${pkg.version}`);
const range = previous ? `${previous}..${manifest.commit}` : manifest.commit;
const commits = git('log', '--reverse', '--no-merges', '--format=%H%x00%s', range);
const changes = commits
  ? commits.split('\n').map((line) => {
      const [sha, subject] = line.split('\0');
      const message = subject.replace(/[\\`*_[\]<>]/g, '\\$&');
      return `- ${message} ([${sha.slice(0, 7)}](${repository}/commit/${sha}))`;
    })
  : ['No non-merge commits since the previous version tag.'];
const history = previous
  ? `${repository}/compare/${previous}...${manifest.commit}`
  : `${repository}/commits/${manifest.commit}`;
const notes = `## Changes\n\n${changes.join('\n')}\n\n[Full history](${history})\n`;
const output = path.join(path.dirname(path.resolve(values.manifest)), 'release-notes.md');
writeFileSync(output, notes, { flag: 'wx' });
console.log(`Release notes: ${output}`);
