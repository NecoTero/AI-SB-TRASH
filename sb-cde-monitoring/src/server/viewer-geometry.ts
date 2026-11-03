import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Matrix3, Matrix4 } from "three";
import { IfcAPI } from "web-ifc";
import type { BimModelId } from "../shared/models.js";
import { getBimModelPath } from "./ifc-model.js";

const CACHE_VERSION = 1;
const HEADER_BYTES = 20;

type CachedGeometry = {
  filePath: string;
  size: number;
  elements: number;
  placements: number;
  triangles: number;
  etag: string;
};

type SourceGeometry = {
  interleaved: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
};

type Placement = {
  expressId: number;
  geometryId: number;
  transformation: number[];
};

const pending = new Map<BimModelId, Promise<CachedGeometry>>();

function cachePaths(modelId: BimModelId) {
  const base = path.resolve("data/viewer", `${modelId}.geometry`);
  return { binary: `${base}.bin`, metadata: `${base}.json` };
}

async function readValidCache(modelId: BimModelId) {
  const source = await stat(getBimModelPath(modelId));
  const paths = cachePaths(modelId);
  try {
    const metadata = JSON.parse(await readFile(paths.metadata, "utf8")) as CachedGeometry & {
      version?: number;
      sourceSize?: number;
      sourceMtimeMs?: number;
    };
    const binary = await stat(paths.binary);
    if (
      metadata.version === CACHE_VERSION
      && metadata.sourceSize === source.size
      && metadata.sourceMtimeMs === source.mtimeMs
      && binary.size === metadata.size
    ) {
      return {
        ...metadata,
        filePath: paths.binary,
        etag: `"viewer-${CACHE_VERSION}-${source.size}-${Math.round(source.mtimeMs)}"`,
      } satisfies CachedGeometry;
    }
  } catch {
    // The cache is missing or stale and will be rebuilt below.
  }
  return null;
}

async function buildCache(modelId: BimModelId): Promise<CachedGeometry> {
  const cached = await readValidCache(modelId);
  if (cached) return cached;

  const sourcePath = getBimModelPath(modelId);
  const sourceStat = await stat(sourcePath);
  const ifcApi = new IfcAPI();
  await ifcApi.Init();
  const bytes = new Uint8Array(await readFile(sourcePath));
  const openedModelId = ifcApi.OpenModel(bytes, { COORDINATE_TO_ORIGIN: true, CIRCLE_SEGMENTS: 12 });
  const sourceGeometries = new Map<number, SourceGeometry>();
  const placements: Placement[] = [];

  try {
    ifcApi.StreamAllMeshes(openedModelId, (mesh) => {
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
      const geometry = sourceGeometries.get(placement.geometryId)!;
      vertexCount += geometry.vertexCount;
      indexCount += geometry.indices.length;
    }

    const positionsBytes = vertexCount * 3 * Float32Array.BYTES_PER_ELEMENT;
    const normalsBytes = positionsBytes;
    const indicesBytes = indexCount * Uint32Array.BYTES_PER_ELEMENT;
    const rangesBytes = placements.length * 3 * Uint32Array.BYTES_PER_ELEMENT;
    const buffer = new ArrayBuffer(HEADER_BYTES + positionsBytes + normalsBytes + indicesBytes + rangesBytes);
    const header = new DataView(buffer, 0, HEADER_BYTES);
    header.setUint8(0, 0x53); // S
    header.setUint8(1, 0x42); // B
    header.setUint8(2, 0x56); // V
    header.setUint8(3, 0x47); // G
    header.setUint32(4, CACHE_VERSION, true);
    header.setUint32(8, vertexCount, true);
    header.setUint32(12, indexCount, true);
    header.setUint32(16, placements.length, true);
    const positions = new Float32Array(buffer, HEADER_BYTES, vertexCount * 3);
    const normals = new Float32Array(buffer, HEADER_BYTES + positionsBytes, vertexCount * 3);
    const indices = new Uint32Array(buffer, HEADER_BYTES + positionsBytes + normalsBytes, indexCount);
    const ranges = new Uint32Array(
      buffer, HEADER_BYTES + positionsBytes + normalsBytes + indicesBytes, placements.length * 3,
    );

    let vertexOffset = 0;
    let indexOffset = 0;
    const matrix = new Matrix4();
    const normalMatrix = new Matrix3();
    for (let placementIndex = 0; placementIndex < placements.length; placementIndex += 1) {
      const placement = placements[placementIndex];
      const geometry = sourceGeometries.get(placement.geometryId)!;
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
        positions[targetOffset] = me[0] * x + me[4] * y + me[8] * z + me[12];
        positions[targetOffset + 1] = me[1] * x + me[5] * y + me[9] * z + me[13];
        positions[targetOffset + 2] = me[2] * x + me[6] * y + me[10] * z + me[14];
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

    const paths = cachePaths(modelId);
    await mkdir(path.dirname(paths.binary), { recursive: true });
    const temporaryBinary = `${paths.binary}.${process.pid}.tmp`;
    const temporaryMetadata = `${paths.metadata}.${process.pid}.tmp`;
    await writeFile(temporaryBinary, new Uint8Array(buffer));
    const elementCount = new Set(placements.map((placement) => placement.expressId)).size;
    const metadata = {
      version: CACHE_VERSION,
      sourceSize: sourceStat.size,
      sourceMtimeMs: sourceStat.mtimeMs,
      size: buffer.byteLength,
      elements: elementCount,
      placements: placements.length,
      triangles: indexCount / 3,
    };
    await writeFile(temporaryMetadata, JSON.stringify(metadata), "utf8");
    await rename(temporaryBinary, paths.binary);
    await rename(temporaryMetadata, paths.metadata);
    return {
      ...metadata,
      filePath: paths.binary,
      etag: `"viewer-${CACHE_VERSION}-${sourceStat.size}-${Math.round(sourceStat.mtimeMs)}"`,
    };
  } finally {
    if (ifcApi.IsModelOpen(openedModelId)) ifcApi.CloseModel(openedModelId);
    ifcApi.Dispose();
  }
}

export function ensureViewerGeometry(modelId: BimModelId) {
  let task = pending.get(modelId);
  if (!task) {
    task = buildCache(modelId).finally(() => pending.delete(modelId));
    pending.set(modelId, task);
  }
  return task;
}
