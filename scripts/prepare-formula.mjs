import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: { manifest: { type: 'string' }, tap: { type: 'string' }, url: { type: 'string' } },
});
assert(
  values.manifest && values.tap,
  'Use --manifest and --tap with a checked candidate and the local tap directory.',
);
const manifest = JSON.parse(await readFile(values.manifest, 'utf8'));
assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/);
assert.match(manifest.sha256, /^[a-f0-9]{64}$/);
assert.equal(manifest.archive, `servicemon-${manifest.version}-source.tar.gz`);
const archive = path.resolve(path.dirname(values.manifest), manifest.archive);
assert.equal(
  createHash('sha256')
    .update(await readFile(archive))
    .digest('hex'),
  manifest.sha256,
  'Candidate checksum differs.',
);
const publicUrl = `https://github.com/sauravhiremath/servicemon/releases/download/v${manifest.version}/${manifest.archive}`;
const url = values.url ?? pathToFileURL(archive).href;
assert(
  url === publicUrl || url === pathToFileURL(archive).href,
  'Use the immutable release URL or this exact local candidate.',
);
const formula = `class Servicemon < Formula
  desc "Control local development services with a CLI and dashboard"
  homepage "https://github.com/sauravhiremath/servicemon"
  url ${JSON.stringify(url)}
  sha256 ${JSON.stringify(manifest.sha256)}
  license "MIT"

  depends_on :macos
  depends_on "node"

  def fetch
    ENV.prepend_path "PATH", formula_opt_bin("node")
    ENV["npm_config_cache"] = HOMEBREW_CACHE/"npm_cache"
    system "npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"
  end

  def install
    ENV.prepend_path "PATH", formula_opt_bin("node")
    ENV["npm_config_cache"] = HOMEBREW_CACHE/"npm_cache"
    system "npm", "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"
    system "npm", "run", "build"
    system "node", "scripts/release-check.mjs", "--tag", "v#{version}"
    system "npm", "prune", "--offline", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"
    system "node", "scripts/release-check.mjs", "--runtime"
    libexec.install "dist", "node_modules", "package.json", "package-lock.json",
                    "LICENSE", "CONTRIBUTING.md", "README.md"
    libexec.install "docs", "examples", "skills"
    (libexec/"scripts").install "scripts/smoke-installed.mjs"
    (bin/"servicemon").write <<~SH
      #!/bin/sh
      export SERVICEMON_STARTUP_EXECUTABLE="#{opt_bin}/servicemon"
      exec "#{formula_opt_bin("node")}/node" "#{opt_libexec}/dist/cli/main.js" "$@"
    SH
  end

  def caveats
    <<~EOS
      Get started
        Create ~/.config/servicemon/config.yaml, then run:
          servicemon serve --background
          servicemon dashboard

      Agent skill (optional)
          npx skills add sauravhiremath/servicemon --skill servicemon --global

      Maintenance
        Use Servicemon commands, not brew services.
        Stop the manager before Servicemon or Node upgrades.
        Before uninstalling: servicemon startup disable; servicemon manager stop

      Guide
        https://github.com/sauravhiremath/servicemon#first-use
    EOS
  end

  test do
    system formula_opt_bin("node")/"node", libexec/"scripts/smoke-installed.mjs", bin/"servicemon"
  end
end
`;
const directory = path.resolve(values.tap, 'Formula');
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, 'servicemon.rb'), formula, { flag: 'wx' });
console.log(
  `Generated ${path.join(directory, 'servicemon.rb')}\nSHA-256: ${manifest.sha256}\nRelease URL: ${publicUrl}\nPreserve each formula with its matching source archive for recovery.`,
);
