import fs from 'node:fs';
import path from 'node:path';
import { IfcAPI } from 'web-ifc';

const folder = path.resolve('Исходные данные', 'IFC модели');
const files = fs.readdirSync(folder).filter(file => file.toLowerCase().endsWith('.ifc')).sort();
const api = new IfcAPI();
await api.Init();

for (const file of files) {
  const modelId = api.OpenModel(new Uint8Array(fs.readFileSync(path.join(folder, file))), {
    COORDINATE_TO_ORIGIN: true,
    CIRCLE_SEGMENTS: 12,
  });
  try {
    const matrix = api.GetCoordinationMatrix(modelId);
    console.log(JSON.stringify({ file, matrix }));
  } finally {
    if (api.IsModelOpen(modelId)) api.CloseModel(modelId);
  }
}

api.Dispose();
