import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Matrix3, Matrix4 } from 'three';
import { IfcAPI } from 'web-ifc';
import { fileContentHash } from './file-content-hash.mjs';

const CACHE_VERSION = 2;
const FORMAT_VERSION = 1;
const HEADER_BYTES = 20;
const ORIGIN_GRID = 10000;
const pending = new Map();

const safePart = value => String(value).replace(/[^a-zA-Z0-9._-]/g, '_');

function cachePaths(cacheRoot, sourceHash) {
  const base = path.join(cacheRoot, `${safePart(sourceHash)}.geometry-v${CACHE_VERSION}`);
  return { binary: `${base}.bin`, metadata: `${base}.json` };
}

async function readValidCache(cacheRoot, sourceHash) {
  const paths = cachePaths(cacheRoot, sourceHash);
  try {
    const metadata = JSON.parse(await readFile(paths.metadata, 'utf8'));
    const binary = await stat(paths.binary);
    if (
      metadata.version === CACHE_VERSION
      && metadata.sourceHash === sourceHash
      && metadata.size === binary.size
    ) {
      return {
        ...metadata,
        filePath: paths.binary,
        etag: `"viewer-${CACHE_VERSION}-${sourceHash}"`,
      };
    }
  } catch {
    // The cache is absent or stale and is rebuilt below.
  }
  return null;
}

async function buildCache(selection, cacheRoot) {
  const sourceHash = await fileContentHash(selection.full, selection.stat);
  const cached = await readValidCache(cacheRoot, sourceHash);
  if (cached) return cached;

  const sourceStat = await stat(selection.full);
  const ifcApi = new IfcAPI();
  await ifcApi.Init();
  const bytes = new Uint8Array(await readFile(selection.full));
  // Per-model COORDINATE_TO_ORIGIN uses a different center for every IFC and breaks federation.
  // We keep world placement and subtract the same coarse grid origin from all nearby disciplines.
  const openedModelId = ifcApi.OpenModel(bytes, { COORDINATE_TO_ORIGIN: false, CIRCLE_SEGMENTS: 12 });
  const sourceGeometries = new Map();
  const placements = [];

  try {
    ifcApi.StreamAllMeshes(openedModelId, mesh => {
      for (let index = 0; index < mesh.geometries.size(); index += 1) {
        const placed = mesh.geometries.get(index);
        if (!sourceGeometries.has(placed.geometryExpressID)) {
          const geometry = ifcApi.GetGeometry(openedModelId, placed.geometryExpressID);
          const interleaved = new Float32Array(ifcApi.GetVertexArray(
            geometry.GetVertexData(), geometry.GetVertexDataSize(),
          ));
          const indices = new Uint32Array(ifcApi.GetIndexArray(
            geometry.GetIndexData(), geometry.GetIndexDataSize(),
          ));
          geometry.delete();
          sourceGeometries.set(placed.geometryExpressID, {
            interleaved,
            indices,
            vertexCount: interleaved.length / 6,
          });
        }
        placements.push({
          expressId: mesh.expressID,
          geometryId: placed.geometryExpressID,
          transformation: Array.from(placed.flatTransformation),
        });
      }
    });

    let vertexCount = 0;
    let indexCount = 0;
    for (const placement of placements) {
      const geometry = sourceGeometries.get(placement.geometryId);
      vertexCount += geometry.vertexCount;
      indexCount += geometry.indices.length;
    }

    const matrix = new Matrix4();
    let coordinateOrigin = [0, 0, 0];
    for (const placement of placements) {
      const geometry = sourceGeometries.get(placement.geometryId);
      if (!geometry?.vertexCount) continue;
      matrix.fromArray(placement.transformation);
      const me = matrix.elements;
      const x = geometry.interleaved[0];
      const y = geometry.interleaved[1];
      const z = geometry.interleaved[2];
      const world = [
        me[0] * x + me[4] * y + me[8] * z + me[12],
        me[1] * x + me[5] * y + me[9] * z + me[13],
        me[2] * x + me[6] * y + me[10] * z + me[14],
      ];
      coordinateOrigin = world.map(value => Math.round(value / ORIGIN_GRID) * ORIGIN_GRID);
      break;
    }

    const positionsBytes = vertexCount * 3 * Float32Array.BYTES_PER_ELEMENT;
    const normalsBytes = positionsBytes;
    const indicesBytes = indexCount * Uint32Array.BYTES_PER_ELEMENT;
    const rangesBytes = placements.length * 3 * Uint32Array.BYTES_PER_ELEMENT;
    const buffer = new ArrayBuffer(HEADER_BYTES + positionsBytes + normalsBytes + indicesBytes + rangesBytes);
    const header = new DataView(buffer, 0, HEADER_BYTES);
    header.setUint8(0, 0x53);
    header.setUint8(1, 0x42);
    header.setUint8(2, 0x56);
    header.setUint8(3, 0x47);
    header.setUint32(4, FORMAT_VERSION, true);
    header.setUint32(8, vertexCount, true);
    header.setUint32(12, indexCount, true);
    header.setUint32(16, placements.length, true);
    const positions = new Float32Array(buffer, HEADER_BYTES, vertexCount * 3);
    const normals = new Float32Array(buffer, HEADER_BYTES + positionsBytes, vertexCount * 3);
    const indices = new Uint32Array(buffer, HEADER_BYTES + positionsBytes + normalsBytes, indexCount);
    const ranges = new Uint32Array(
      buffer,
      HEADER_BYTES + positionsBytes + normalsBytes + indicesBytes,
      placements.length * 3,
    );

    let vertexOffset = 0;
    let indexOffset = 0;
    const normalMatrix = new Matrix3();
    for (let placementIndex = 0; placementIndex < placements.length; placementIndex += 1) {
      const placement = placements[placementIndex];
      const geometry = sourceGeometries.get(placement.geometryId);
      matrix.fromArray(placement.transformation);
      normalMatrix.getNormalMatrix(matrix);
      const me = matrix.elements;
      const ne = normalMatrix.elements;
      for (let vertex = 0; vertex < geometry.vertexCount; vertex += 1) {
        const sourceOffset = vertex * 6;
        const targetOffset = (vertexOffset + vertex) * 3;
        const x = geometry.interleaved[sourceOffset];
        const y = geometry.interleaved[sourceOffset + 1];
        const z = geometry.interleaved[sourceOffset + 2];
        positions[targetOffset] = me[0] * x + me[4] * y + me[8] * z + me[12] - coordinateOrigin[0];
        positions[targetOffset + 1] = me[1] * x + me[5] * y + me[9] * z + me[13] - coordinateOrigin[1];
        positions[targetOffset + 2] = me[2] * x + me[6] * y + me[10] * z + me[14] - coordinateOrigin[2];
        const nx = geometry.interleaved[sourceOffset + 3];
        const ny = geometry.interleaved[sourceOffset + 4];
        const nz = geometry.interleaved[sourceOffset + 5];
        const tx = ne[0] * nx + ne[3] * ny + ne[6] * nz;
        const ty = ne[1] * nx + ne[4] * ny + ne[7] * nz;
        const tz = ne[2] * nx + ne[5] * ny + ne[8] * nz;
        const length = Math.hypot(tx, ty, tz) || 1;
        normals[targetOffset] = tx / length;
        normals[targetOffset + 1] = ty / length;
        normals[targetOffset + 2] = tz / length;
      }
      for (let index = 0; index < geometry.indices.length; index += 1) {
        indices[indexOffset + index] = geometry.indices[index] + vertexOffset;
      }
      const rangeOffset = placementIndex * 3;
      ranges[rangeOffset] = placement.expressId;
      ranges[rangeOffset + 1] = vertexOffset;
      ranges[rangeOffset + 2] = geometry.vertexCount;
      vertexOffset += geometry.vertexCount;
      indexOffset += geometry.indices.length;
    }

    const paths = cachePaths(cacheRoot, sourceHash);
    await mkdir(path.dirname(paths.binary), { recursive: true });
    const temporaryBinary = `${paths.binary}.${process.pid}.tmp`;
    const temporaryMetadata = `${paths.metadata}.${process.pid}.tmp`;
    await writeFile(temporaryBinary, new Uint8Array(buffer));
    const metadata = {
      version: CACHE_VERSION,
      sourceHash,
      sourceSize: sourceStat.size,
      sourceMtimeMs: sourceStat.mtimeMs,
      size: buffer.byteLength,
      elements: new Set(placements.map(placement => placement.expressId)).size,
      placements: placements.length,
      triangles: indexCount / 3,
      coordinateOrigin,
    };
    await writeFile(temporaryMetadata, JSON.stringify(metadata), 'utf8');
    await rename(temporaryBinary, paths.binary);
    await rename(temporaryMetadata, paths.metadata);
    return {
      ...metadata,
      filePath: paths.binary,
      etag: `"viewer-${CACHE_VERSION}-${sourceHash}"`,
    };
  } finally {
    if (ifcApi.IsModelOpen(openedModelId)) ifcApi.CloseModel(openedModelId);
    ifcApi.Dispose();
  }
}

export async function ensureViewerGeometry(selection, cacheRoot) {
  const key = await fileContentHash(selection.full, selection.stat);
  let task = pending.get(key);
  if (!task) {
    task = buildCache(selection, cacheRoot).finally(() => pending.delete(key));
    pending.set(key, task);
  }
  return task;
}
