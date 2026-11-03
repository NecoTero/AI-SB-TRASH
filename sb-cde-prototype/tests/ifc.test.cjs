const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Core = require('../dist/core.js');
global.window = global;
require('../dist/data.js');

test('реальный IFC: извлекаются элементы и свойства КФО, корпуса и этажа', async () => {
  const { readIfc } = await import('../ifc-reader.mjs');
  const parsed = await readIfc(path.join(__dirname, 'fixtures', 'properties.ifc'));
  assert.equal(parsed.schema, 'IFC4');
  assert.equal(parsed.elements.length, 1);
  assert.ok(parsed.elements[0].props.some(([key, value]) => key === 'КФО' && value === '204.02.01.01'));
  const grouped = Core.groupModels([{ id: 'ifc', name: 'properties.ifc', selected: 1, elements: parsed.elements }], DEMO.traits);
  assert.equal(grouped.groups[0].code, '204.02.01.01 | Корпус А | Этаж 1');
});
