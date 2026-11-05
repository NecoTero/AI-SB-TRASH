const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const JSZip = require('../dist/vendor/jszip.min.js');

class XmlNode {
  constructor(name, attributes = {}) {
    this.name = name;
    this.attributes = attributes;
    this.children = [];
    this.parts = [];
  }

  getAttribute(name) {
    return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
  }

  get textContent() {
    return this.parts.map(part => typeof part === 'string' ? part : part.textContent).join('');
  }

  getElementsByTagName(name) {
    const result = [];
    for (const child of this.children) {
      if (child.name === name) result.push(child);
      result.push(...child.getElementsByTagName(name));
    }
    return result;
  }
}

class TestDomParser {
  parseFromString(xml) {
    const document = new XmlNode('#document');
    document.querySelector = selector => selector === 'parsererror' ? null : null;
    const stack = [document];
    const decode = value => value
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
      .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
      .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
    for (const token of xml.match(/<[^>]+>|[^<]+/g) || []) {
      if (token.startsWith('<?') || token.startsWith('<!')) continue;
      if (token.startsWith('</')) {
        stack.pop();
        continue;
      }
      if (token.startsWith('<')) {
        const selfClosing = /\/>$/.test(token);
        const body = token.slice(1, selfClosing ? -2 : -1).trim();
        const name = body.match(/^\S+/)?.[0];
        if (!name) continue;
        const attributes = {};
        const rest = body.slice(name.length);
        for (const match of rest.matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
          attributes[match[1]] = decode(match[2] ?? match[3] ?? '');
        }
        const node = new XmlNode(name, attributes);
        const parent = stack.at(-1);
        parent.children.push(node);
        parent.parts.push(node);
        if (!selfClosing) stack.push(node);
        continue;
      }
      stack.at(-1).parts.push(decode(token));
    }
    return document;
  }
}

const context = {
  window: {},
  JSZip,
  DOMParser: TestDomParser,
  File,
  Blob,
  console,
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../dist/xlsx.js'), 'utf8'), context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../dist/core.js'), 'utf8'), context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../dist/data.js'), 'utf8'), context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../dist/catalog-extension.js'), 'utf8'), context);

const cases = [
  {
    file: 'SB_Шаблон для импорта КСП_МАН16_L3_Базовый план.xlsx',
    date: '2024-01-22',
    rows: 885,
    result: 'success',
  },
  {
    file: 'SB_Шаблон для импорта КСП_МАН16_L3_Факт на 27092026.xlsx',
    date: '2026-09-27',
    rows: 841,
    result: 'success',
  },
  {
    file: 'SB_Шаблон для импорта КСП_МАН16_L3_Факт на 27092026 — с этапами.xlsx',
    date: '2026-09-27',
    rows: 841,
    result: 'success',
    stageCounts: {'Фундамент':55,'Shell&Core':133,'Фасады':57,'Кровля':8,'FitOut':534,'-':54},
  },
];

for (const entry of cases) {
  test(`реальный XLSX считывается и обрабатывается по БТ 14.1: ${entry.file}`, async () => {
    const outputFolder = process.env.IMPORT_OUTPUT_FOLDER || 'заполненные шаблоны';
    const filePath = path.join(__dirname, '../Исходные данные', outputFolder, entry.file);
    const file = new File([fs.readFileSync(filePath)], entry.file, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const workbook = await context.window.XlsxReader.open(file);
    assert.ok(workbook.names.includes('Шаблон'));
    const data = await workbook.sheet(workbook.names.indexOf('Шаблон'));
    assert.equal(data.date, entry.date);
    assert.equal(data.rows.length, entry.rows);
    assert.ok(data.rows.every(row => String(row.kfo).trim()));
    if (entry.stageCounts) {
      assert.ok(data.rows.every(row => String(row.stage).trim()));
      const counts = Object.fromEntries(Object.keys(entry.stageCounts).map(stage => [stage, data.rows.filter(row => row.stage === stage).length]));
      assert.deepEqual(counts, entry.stageCounts);
    }
    const result = context.window.Core.validateImport(data.rows, data.date, context.window.DEMO.traits);
    assert.equal(result.result, entry.result, result.errors.slice(0, 3).map(error => error.reason).join('; '));
    if (entry.result === 'success') {
      assert.equal(result.loaded, entry.rows);
      assert.equal(result.rejected, 0);
    } else {
      assert.equal(result.loaded, 0);
      assert.equal(result.rejected, entry.rows);
      const unknown = result.errors.filter(error => error.field === 'Код КФО' && error.value === entry.unknownKfo);
      assert.equal(unknown.length, 1);
      assert.equal(unknown[0].row, 817);
    }
  });
}

test('копия справочника работ содержит проверяемый маппинг BIM-кодов на этапы', async () => {
  const filePath = path.join(__dirname, '../Исходные данные/as is/Справочники_Работ — этапы и BIM.xlsx');
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const workbookXml = await zip.file('xl/workbook.xml').async('string');
  const relationId = workbookXml.match(/<sheet[^>]+name="КФО — этапы"[^>]+r:id="([^"]+)"/)?.[1];
  assert.ok(relationId, 'лист «КФО — этапы» не найден');
  const relationsXml = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  const relationship = [...relationsXml.matchAll(/<Relationship\b[^>]*>/g)]
    .find(match => new RegExp(`\\bId="${relationId}"`).test(match[0]));
  assert.ok(relationship, 'связь нового листа не найдена');
  const target = relationship[0].match(/\bTarget="([^"]+)"/)?.[1];
  const sheetXml = await zip.file(`xl/${target}`).async('string');
  const document = new TestDomParser().parseFromString(sheetXml);
  const rows = document.getElementsByTagName('row').map(row =>
    row.getElementsByTagName('t').map(cell => cell.textContent)
  );
  assert.deepEqual(rows[0], ['Код КФО','Расшифровка КФО','BIM / без BIM','Строительный этап','Уверенность','Основание маппинга','Примечание']);
  const data = rows.slice(1);
  assert.equal(data.length, 193);
  assert.equal(new Set(data.map(row => row[0])).size, 192);
  assert.equal(data.filter(row => row[2] === 'BIM').length, 113);
  assert.equal(data.filter(row => row[2] === 'без BIM').length, 80);
  const counts = Object.fromEntries(['Фундамент','Shell&Core','Фасады','Кровля','FitOut','-'].map(stage =>
    [stage, data.filter(row => row[3] === stage).length]
  ));
  assert.deepEqual(counts, {'Фундамент':5,'Shell&Core':11,'Фасады':8,'Кровля':4,'FitOut':61,'-':104});
  assert.ok(data.filter(row => row[2] === 'без BIM').every(row => row[3] === '-' && row[4] === '' && row[5] === ''));
  assert.equal(data.find(row => row[0] === '204.02.01.01')[3], '-');
  const duplicate = data.filter(row => row[0] === '205.01.01.01');
  assert.equal(duplicate.length, 2);
  assert.ok(duplicate.every(row => row[6].includes('Дублирующийся код')));
});
