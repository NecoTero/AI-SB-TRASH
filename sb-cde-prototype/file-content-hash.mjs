import fs from 'node:fs';
import { createHash } from 'node:crypto';

const memo = new Map();

export async function fileContentHash(filePath, statHint, { force = false } = {}) {
  const source = statHint || await fs.promises.stat(filePath);
  const stamp = `${source.size}:${source.mtimeMs}`;
  const cached = memo.get(filePath);
  if (!force && cached?.stamp === stamp) return cached.hash;

  const hash = await new Promise((resolve, reject) => {
    const digest = createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => digest.update(chunk));
    stream.on('end', () => resolve(digest.digest('hex')));
    stream.on('error', reject);
  });
  memo.set(filePath, { stamp, hash });
  return hash;
}

export function clearFileContentHashMemo() {
  memo.clear();
}
