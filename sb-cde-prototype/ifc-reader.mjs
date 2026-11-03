import fs from 'node:fs';
import { IfcAPI, IFCELEMENT } from 'web-ifc';

let apiPromise;
const api = async () => {
  if (!apiPromise) apiPromise = (async () => {
    const instance = new IfcAPI();
    await instance.Init();
    return instance;
  })();
  return apiPromise;
};

const valueOf = value => {
  if (value == null) return null;
  if (typeof value === 'object' && 'value' in value) return valueOf(value.value);
  if (Array.isArray(value)) return value.map(valueOf).filter(value => value != null).join(', ');
  if (['string', 'number', 'boolean'].includes(typeof value)) return String(value);
  return null;
};

const add = (props, name, value) => {
  const key = valueOf(name)?.trim(), text = valueOf(value)?.trim();
  if (key && text && !props.some(([existing]) => existing === key)) props.push([key, text]);
};

const collectProperty = (node, props, seen = new Set()) => {
  if (!node || typeof node !== 'object') return;
  if (node.expressID && seen.has(node.expressID)) return;
  if (node.expressID) seen.add(node.expressID);
  if (node.NominalValue != null) add(props, node.Name, node.NominalValue);
  if (node.EnumerationValues != null) add(props, node.Name, node.EnumerationValues);
  if (node.ListValues != null) add(props, node.Name, node.ListValues);
  if (node.UpperBoundValue != null || node.LowerBoundValue != null) add(props, node.Name, [node.LowerBoundValue, node.UpperBoundValue]);
  for (const [key, value] of Object.entries(node)) {
    if (/Value$/.test(key) && !['NominalValue', 'UpperBoundValue', 'LowerBoundValue'].includes(key)) add(props, node.Name, value);
    if (Array.isArray(value)) value.forEach(item => collectProperty(item, props, seen));
    else if (value && typeof value === 'object' && !('value' in value)) collectProperty(value, props, seen);
  }
};

const yieldToServer = () => new Promise(resolve => setImmediate(resolve));

export async function readIfc(filePath, { onProgress } = {}) {
  onProgress?.({ stage: 'opening', completed: 0, total: 0 });
  const ifc = await api();
  const modelID = ifc.OpenModel(new Uint8Array(fs.readFileSync(filePath)));
  try {
    const ids = ifc.GetLineIDsWithType(modelID, IFCELEMENT, true), elements = [];
    const total = ids.size();
    onProgress?.({ stage: 'properties', completed: 0, total });
    for (let index = 0; index < ids.size(); index++) {
      const expressID = ids.get(index), line = ifc.GetLine(modelID, expressID), props = [];
      add(props, 'GlobalId', line.GlobalId);
      add(props, 'Name', line.Name);
      add(props, 'ObjectType', line.ObjectType);
      add(props, 'Tag', line.Tag);
      add(props, 'PredefinedType', line.PredefinedType);
      const propertySets = await ifc.properties.getPropertySets(modelID, expressID, true, true);
      propertySets.forEach(propertySet => collectProperty(propertySet, props));
      elements.push({ id: String(expressID), type: line.constructor?.name || 'IfcElement', props });
      if ((index + 1) % 25 === 0 || index + 1 === total) {
        onProgress?.({ stage: 'properties', completed: index + 1, total });
        await yieldToServer();
      }
    }
    onProgress?.({ stage: 'done', completed: total, total });
    return { elements, schema: ifc.GetModelSchema(modelID) };
  } finally {
    ifc.CloseModel(modelID);
  }
}
