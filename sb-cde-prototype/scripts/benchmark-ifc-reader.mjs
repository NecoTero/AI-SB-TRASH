import path from 'node:path';
import { readIfc } from '../ifc-reader.mjs';

const file = path.resolve('Исходные данные', 'IFC модели', process.argv[2] || '1816_PSK_RD_KR_M3_R24.ifc');
const started = Date.now();
let lastReported = 0;
const result = await readIfc(file, {
  onProgress(progress) {
    if (progress.completed === progress.total || progress.completed - lastReported >= 1000) {
      lastReported = progress.completed;
      console.log(JSON.stringify({ ...progress, elapsedSeconds: Math.round((Date.now() - started) / 1000) }));
    }
  },
});
console.log(JSON.stringify({ elements: result.elements.length, schema: result.schema, elapsedSeconds: Math.round((Date.now() - started) / 1000) }));
