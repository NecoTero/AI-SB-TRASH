import fs from 'node:fs';
import path from 'node:path';

const folder = path.resolve('data', 'viewer');
for (const file of fs.readdirSync(folder).filter(name => name.endsWith('.bin')).sort()) {
  const bytes = fs.readFileSync(path.join(folder, file));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vertexCount = view.getUint32(8, true);
  const positions = new Float32Array(bytes.buffer, bytes.byteOffset + 20, vertexCount * 3);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], positions[index + axis]);
      max[axis] = Math.max(max[axis], positions[index + axis]);
    }
  }
  console.log(JSON.stringify({ file, vertexCount, min, max, size: max.map((value, axis) => value - min[axis]) }));
}
