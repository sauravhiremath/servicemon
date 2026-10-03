import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from '../shared/errors.js';
export async function assetRoot(custom?: string): Promise<{ root: string; index: string }> {
  if (custom) {
    if (!['.html', '.htm'].includes(extname(custom).toLowerCase())) throw new AppError('INVALID_INPUT', 'Custom UI must be an HTML file.');
    const index = await realpath(resolve(custom));
    if (!(await stat(index)).isFile()) throw new AppError('INVALID_INPUT', 'Custom UI is not a file.');
    await readFile(index);
    return { root: dirname(index), index };
  }
  const root = fileURLToPath(new URL('../web/', import.meta.url));
  return { root: await realpath(root), index: resolve(root, 'index.html') };
}
const contentTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
export async function readAsset(assets: {root:string;index:string}, pathname: string): Promise<{body:Buffer;type:string} | undefined> {
  try {
    const decoded = decodeURIComponent(pathname);
    if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').some(part => part.startsWith('.'))) return;
    const path = await realpath(decoded === '/' ? assets.index : resolve(assets.root, '.' + decoded));
    if (path !== assets.root && !path.startsWith(assets.root + sep)) return;
    if (path.slice(assets.root.length).split(sep).some(part => part.startsWith('.'))) return;
    const type = contentTypes[extname(path).toLowerCase()];
    if (!type || !(await stat(path)).isFile()) return;
    return { body: await readFile(path), type };
  } catch { return; }
}
