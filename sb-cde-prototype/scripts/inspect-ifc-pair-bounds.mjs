import fs from 'node:fs';
import path from 'node:path';
import { Matrix4, Vector3 } from 'three';
import { IfcAPI } from 'web-ifc';

const folder = path.resolve('Исходные данные', 'IFC модели');
const files = [
  '1816_PSK_RD_01_KR_M3_16_R24_отсоединено.ifc',
  '1816_PSK_RD_01_KR_M3_17_R24_отсоединено.ifc',
];
const api = new IfcAPI();
await api.Init();

for (const coordinateToOrigin of [false, true]) {
  for (const file of files) {
    const modelId = api.OpenModel(new Uint8Array(fs.readFileSync(path.join(folder, file))), {
      COORDINATE_TO_ORIGIN: coordinateToOrigin,
      CIRCLE_SEGMENTS: 12,
    });
    const min = new Vector3(Infinity, Infinity, Infinity);
    const max = new Vector3(-Infinity, -Infinity, -Infinity);
    const matrix = new Matrix4();
    const point = new Vector3();
    try {
      api.StreamAllMeshes(modelId, mesh => {
        for (let index = 0; index < mesh.geometries.size(); index += 1) {
          const placed = mesh.geometries.get(index);
          const geometry = api.GetGeometry(modelId, placed.geometryExpressID);
          const vertices = api.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize());
          matrix.fromArray(Array.from(placed.flatTransformation));
          for (let offset = 0; offset < vertices.length; offset += 6) {
            point.set(vertices[offset], vertices[offset + 1], vertices[offset + 2]).applyMatrix4(matrix);
            min.min(point);
            max.max(point);
          }
          geometry.delete();
        }
      });
      console.log(JSON.stringify({ coordinateToOrigin, file, coordination: api.GetCoordinationMatrix(modelId), min: min.toArray(), max: max.toArray() }));
    } finally {
      if (api.IsModelOpen(modelId)) api.CloseModel(modelId);
    }
  }
}

api.Dispose();
