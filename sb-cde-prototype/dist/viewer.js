import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const C = window.Core;
const DAY = 86400000;
const HEADER_BYTES = 20;
const COLOR = {
  completed: [30, 201, 126, 255],
  inProgress: [48, 137, 235, 255],
  notStarted: [188, 199, 205, 92],
  unlinked: [151, 163, 169, 105],
  hidden: [0, 0, 0, 0],
};

const iso = date => new Date(`${date}T00:00:00Z`);
const toIso = date => date.toISOString().slice(0, 10);
const formatDate = date => date ? date.split('-').reverse().join('.') : '—';
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const esc = value => String(value ?? '').replace(/[&<>"']/g, symbol => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[symbol]));

function pack([red, green, blue, alpha]) {
  return (red | (green << 8) | (blue << 16) | (alpha << 24)) >>> 0;
}

function parseGeometry(buffer) {
  if (buffer.byteLength < HEADER_BYTES) throw new Error('Кэш геометрии повреждён');
  const header = new DataView(buffer, 0, HEADER_BYTES);
  if ([0x53, 0x42, 0x56, 0x47].some((byte, index) => header.getUint8(index) !== byte)) {
    throw new Error('Неизвестный формат геометрии');
  }
  if (header.getUint32(4, true) !== 1) throw new Error('Версия геометрии не поддерживается');
  const vertexCount = header.getUint32(8, true);
  const indexCount = header.getUint32(12, true);
  const rangeCount = header.getUint32(16, true);
  const positionsBytes = vertexCount * 3 * Float32Array.BYTES_PER_ELEMENT;
  const normalsBytes = positionsBytes;
  const indicesBytes = indexCount * Uint32Array.BYTES_PER_ELEMENT;
  const expected = HEADER_BYTES + positionsBytes + normalsBytes + indicesBytes
    + rangeCount * 3 * Uint32Array.BYTES_PER_ELEMENT;
  if (buffer.byteLength !== expected) throw new Error('Геометрия загружена не полностью');
  const positions = new Float32Array(buffer, HEADER_BYTES, vertexCount * 3);
  const normals = new Float32Array(buffer, HEADER_BYTES + positionsBytes, vertexCount * 3);
  const indices = new Uint32Array(buffer, HEADER_BYTES + positionsBytes + normalsBytes, indexCount);
  const descriptors = new Uint32Array(
    buffer,
    HEADER_BYTES + positionsBytes + normalsBytes + indicesBytes,
    rangeCount * 3,
  );
  const ranges = new Map();
  for (let index = 0; index < rangeCount; index += 1) {
    const offset = index * 3;
    const expressId = descriptors[offset];
    if (!ranges.has(expressId)) ranges.set(expressId, []);
    ranges.get(expressId).push({ start: descriptors[offset + 1], count: descriptors[offset + 2] });
  }
  const colors = new Uint8Array(vertexCount * 4);
  new Uint32Array(colors.buffer).fill(pack(COLOR.hidden));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Uint8BufferAttribute(colors, 4, true));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return { geometry, ranges, triangles: indexCount / 3 };
}

function modelElementCodes(model, traits) {
  const map = new Map();
  for (const element of model.elements || []) {
    const values = {};
    for (const trait of traits) values[trait.id] = C.readTrait(element.props, trait);
    map.set(Number(element.id), values.kfo ? C.codeOf(values) : null);
  }
  return map;
}

function buildWorkMap(operations) {
  const map = new Map();
  for (const operation of operations) {
    const code = C.codeOf(operation);
    const normalized = C.normalize(code);
    if (!map.has(normalized)) map.set(normalized, { code, operations: [] });
    map.get(normalized).operations.push(operation);
  }
  return map;
}

function timelineBounds(operations, reportDate) {
  const bounds = C.timelineBounds(operations);
  const dates = [bounds.min, bounds.max, reportDate].filter(Boolean).sort();
  return { min: dates[0] || reportDate, max: dates.at(-1) || reportDate };
}

function offsetDays(date, days) {
  return toIso(new Date(iso(date).getTime() + days * DAY));
}

function offsetMonths(date, months = 1) {
  const source = iso(date);
  const target = new Date(Date.UTC(source.getUTCFullYear(), source.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(source.getUTCDate(), lastDay));
  return toIso(target);
}

function formatMonth(date) {
  return iso(date).toLocaleDateString('ru-RU', { month: 'short', year: '2-digit', timeZone: 'UTC' }).replace(' г.', '');
}

function statusKey(status) {
  if (status === 'Завершено') return 'completed';
  if (status === 'В работе') return 'inProgress';
  if (status === 'Не начато') return 'notStarted';
  return 'hidden';
}

class ViewerSession {
  constructor(root, payload) {
    this.root = root;
    this.payload = payload;
    this.version = payload.version;
    this.models = payload.models;
    this.workMap = buildWorkMap(this.version.ops);
    this.modelViews = [];
    this.hiddenStates = new Set(['unlinked']);
    this.hiddenModels = new Set();
    this.expandedWorks = new Set();
    this.selectedDate = this.version.date;
    this.step = 1;
    this.playTimer = null;
    this.active = true;
    this.renderFrame = 0;
    this.fullBounds = timelineBounds(this.version.ops, this.version.date);
    this.bounds = { ...this.fullBounds };
  }

  async open() {
    document.body.classList.add('viewer-open');
    this.root.innerHTML = this.template();
    this.bind();
    this.setupScene();
    this.drawTimeline();
    try {
      for (let index = 0; index < this.models.length; index += 1) {
        await this.loadModel(this.models[index], index);
      }
      if (!this.active) return;
      this.fit('iso');
      this.applyStatuses();
      this.root.querySelector('.viewer-loading').hidden = true;
      this.root.querySelector('.viewer-ready').hidden = false;
    } catch (error) {
      if (!this.active) return;
      const loading = this.root.querySelector('.viewer-loading');
      loading.classList.add('error');
      loading.innerHTML = `<strong>Модель не открылась</strong><span>${esc(error?.message || 'Не удалось загрузить геометрию')}</span>`;
    }
  }

  template() {
    const eye = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"></path><circle cx="12" cy="12" r="2.8"></circle></svg>`;
    return `<section class="viewer-screen" aria-label="Статусная модель СМР">
      <header class="viewer-header">
        <div class="viewer-brand"><b>КСУП</b> BIM</div>
        <div class="viewer-heading"><strong>Статусная модель СМР</strong><span>Название проекта</span></div>
        <div class="viewer-context"><span>График СМР <b>v${this.version.n}</b></span><span>Отчётная дата <b>${formatDate(this.version.date)}</b></span></div>
        <button class="viewer-close" type="button" aria-label="Закрыть 3D" title="Вернуться к реестру">×</button>
      </header>
      <div class="viewer-workspace">
        <div class="viewer-canvas" aria-label="Область 3D-модели"></div>
        <aside class="viewer-model-tree" aria-label="Дерево моделей">
          <button type="button" class="viewer-model-tree-head" data-model-tree-toggle aria-expanded="true" aria-label="Скрыть дерево моделей" title="Свернуть дерево моделей"><span class="tree-chevron">‹</span><strong>Модели</strong></button>
          <div class="viewer-model-list">${this.models.map(model => `<div class="viewer-model-row" data-model-row-id="${esc(model.id)}"><span class="tree-branch"></span><span class="viewer-model-name" title="${esc(model.name)}">${esc(model.name.replace(/\.ifc$/i, ''))}</span><small>v${model.selected}</small><button type="button" data-model-visibility="${esc(model.id)}" aria-pressed="true" aria-label="Скрыть модель ${esc(model.name)}" title="Скрыть модель">${eye}</button></div>`).join('')}</div>
        </aside>
        <div class="viewer-tools" role="toolbar" aria-label="Управление камерой">
          <button data-viewer-action="zoom-in" title="Приблизить">+</button>
          <button data-viewer-action="zoom-out" title="Отдалить">−</button>
          <button data-viewer-action="fit" title="Вписать видимую модель в экран">Вписать</button>
          <button data-viewer-action="iso" title="Изометрический вид">3D</button>
          <button data-viewer-action="top" title="Вид сверху">Сверху</button>
          <button data-viewer-action="front" title="Вид спереди">Спереди</button>
          <button data-viewer-action="right" title="Вид справа">Справа</button>
        </div>
        <div class="viewer-side-panels">
        <aside class="viewer-legend">
          <div class="viewer-legend-head"><strong>Статус СМР</strong><span class="viewer-ready" hidden>●</span><button type="button" class="viewer-legend-toggle" data-legend-toggle aria-expanded="true" aria-label="Скрыть легенду статусов" title="Свернуть легенду">›</button></div>
          <button data-state="completed"><i class="completed"></i><span>Завершено</span><b id="count-completed">0</b></button>
          <button data-state="inProgress"><i class="in-progress"></i><span>В работе</span><b id="count-inProgress">0</b></button>
          <button data-state="notStarted"><i class="not-started"></i><span>Не начато</span><b id="count-notStarted">0</b></button>
          <button data-state="unlinked" class="off"><i class="unlinked"></i><span>Без КФО или связи</span><b id="count-unlinked">0</b></button>
        </aside>
        <aside class="viewer-current-works" aria-label="Текущие работы">
          <div class="viewer-current-works-head"><strong>Текущие работы</strong><span class="viewer-current-work-count">0</span><button type="button" class="viewer-current-works-toggle" data-current-works-toggle aria-expanded="true" aria-label="Скрыть текущие работы" title="Свернуть текущие работы"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 5.5-6.5 6.5 6.5 6.5"></path></svg></button></div>
          <div class="viewer-current-work-list"></div>
        </aside>
        </div>
        <div class="viewer-loading"><span class="viewer-spinner"></span><strong>Подготавливаем IFC-геометрию…</strong><small id="viewer-load-progress">Это может занять время при первом открытии</small></div>
      </div>
      <section class="viewer-timeline" aria-label="Таймлайн статусов">
        <div class="timeline-top">
          <div class="timeline-title"><small>Дата просмотра</small><strong id="timeline-date-label">${formatDate(this.selectedDate)}</strong></div>
          <input id="timeline-date" type="date" value="${this.selectedDate}" aria-label="Дата просмотра">
          <button data-viewer-action="play" class="timeline-play" aria-label="Запустить воспроизведение">▶</button>
          <div class="timeline-steps" aria-label="Шаг воспроизведения">
            <button data-step="1" class="active">1 день</button><button data-step="3">3 дня</button><button data-step="7">1 неделя</button><button data-step="month">1 месяц</button>
          </div>
          <div class="timeline-spacer"></div>
          <button data-viewer-action="focus" class="timeline-focus">Фокус на BIM</button>
          <button data-viewer-action="full" class="timeline-full" disabled>Весь график</button>
        </div>
        <div class="timeline-track-wrap">
          <div class="timeline-grid" aria-hidden="true"></div>
          <div class="timeline-zones"><span class="timeline-fact"></span><span class="timeline-plan"></span><i class="timeline-report" title="Отчётная дата"></i></div>
          <input id="timeline-range" type="range" min="0" max="1" value="0" aria-label="Дата просмотра на таймлайне">
          <div class="timeline-ticks"></div>
        </div>
      </section>
    </section>`;
  }

  bind() {
    this.root.querySelector('.viewer-close').onclick = () => this.close();
    this.root.querySelectorAll('[data-viewer-action]').forEach(button => {
      button.onclick = () => this.action(button.dataset.viewerAction);
    });
    this.root.querySelectorAll('[data-step]').forEach(button => {
      button.onclick = () => {
        this.step = button.dataset.step === 'month' ? 'month' : Number(button.dataset.step);
        this.root.querySelectorAll('[data-step]').forEach(item => item.classList.toggle('active', item === button));
      };
    });
    this.root.querySelectorAll('[data-model-visibility]').forEach(button => {
      button.onclick = () => {
        const modelId = button.dataset.modelVisibility;
        this.hiddenModels.has(modelId) ? this.hiddenModels.delete(modelId) : this.hiddenModels.add(modelId);
        const visible = !this.hiddenModels.has(modelId);
        button.classList.toggle('off', !visible);
        button.setAttribute('aria-pressed', String(visible));
        button.setAttribute('aria-label', `${visible ? 'Скрыть' : 'Показать'} модель`);
        button.title = visible ? 'Скрыть модель' : 'Показать модель';
        const view = this.modelViews.find(candidate => candidate.model.id === modelId);
        if (view) view.mesh.visible = visible;
        this.applyStatuses();
      };
    });
    this.root.querySelector('[data-model-tree-toggle]').onclick = event => {
      const panel = this.root.querySelector('.viewer-model-tree');
      const collapsed = panel.classList.toggle('collapsed');
      const button = event.currentTarget;
      button.setAttribute('aria-expanded', String(!collapsed));
      button.setAttribute('aria-label', `${collapsed ? 'Показать' : 'Скрыть'} дерево моделей`);
      button.title = collapsed ? 'Развернуть дерево моделей' : 'Свернуть дерево моделей';
      button.querySelector('.tree-chevron').textContent = collapsed ? '›' : '‹';
    };
    this.root.querySelector('[data-legend-toggle]').onclick = event => {
      const panel = this.root.querySelector('.viewer-legend');
      const collapsed = panel.classList.toggle('collapsed');
      const button = event.currentTarget;
      button.setAttribute('aria-expanded', String(!collapsed));
      button.setAttribute('aria-label', `${collapsed ? 'Показать' : 'Скрыть'} легенду статусов`);
      button.title = collapsed ? 'Развернуть легенду' : 'Свернуть легенду';
      button.textContent = collapsed ? '‹' : '›';
    };
    this.root.querySelector('[data-current-works-toggle]').onclick = event => {
      const panel = this.root.querySelector('.viewer-current-works');
      const collapsed = panel.classList.toggle('collapsed');
      const button = event.currentTarget;
      button.setAttribute('aria-expanded', String(!collapsed));
      button.setAttribute('aria-label', `${collapsed ? 'Показать' : 'Скрыть'} текущие работы`);
      button.title = collapsed ? 'Развернуть текущие работы' : 'Свернуть текущие работы';
    };
    this.root.querySelector('.viewer-current-work-list').onclick = event => {
      const button = event.target.closest('[data-current-work]');
      if (!button) return;
      const code = button.dataset.currentWork;
      this.expandedWorks.has(code) ? this.expandedWorks.delete(code) : this.expandedWorks.add(code);
      this.renderCurrentWorks();
    };
    this.root.querySelectorAll('.viewer-legend button[data-state]').forEach(button => {
      button.onclick = () => {
        const state = button.dataset.state;
        this.hiddenStates.has(state) ? this.hiddenStates.delete(state) : this.hiddenStates.add(state);
        button.classList.toggle('off', this.hiddenStates.has(state));
        this.applyStatuses();
      };
    });
    const dateInput = this.root.querySelector('#timeline-date');
    dateInput.onchange = () => this.setDate(dateInput.value);
    this.root.querySelector('#timeline-range').oninput = event => {
      this.setDate(offsetDays(this.bounds.min, Number(event.target.value)), false);
    };
    this.escapeHandler = event => { if (event.key === 'Escape') this.close(); };
    document.addEventListener('keydown', this.escapeHandler);
  }

  setupScene() {
    const host = this.root.querySelector('.viewer-canvas');
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#eef2f3');
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100000);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.35));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    host.appendChild(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.screenSpacePanning = true;
    this.controls.zoomToCursor = true;
    this.controls.rotateSpeed = 0.65;
    this.controls.addEventListener('change', () => this.scheduleRender());
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x64717a, 1.75));
    const light = new THREE.DirectionalLight(0xffffff, 2.1);
    light.position.set(40, 70, 35);
    this.scene.add(light);
    this.combinedBounds = new THREE.Box3();
    this.resizeObserver = new ResizeObserver(() => {
      const width = Math.max(host.clientWidth, 1);
      const height = Math.max(host.clientHeight, 1);
      this.renderer.setSize(width, height, false);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.scheduleRender();
    });
    this.resizeObserver.observe(host);
  }

  async loadModel(model, index) {
    const progress = this.root.querySelector('#viewer-load-progress');
    progress.textContent = `Модель ${index + 1} из ${this.models.length}: ${model.name}`;
    const hash = model.sourceHash ? `?hash=${encodeURIComponent(model.sourceHash)}` : '';
    const response = await fetch(`/api/models/${encodeURIComponent(model.id)}/versions/${model.selected}/geometry${hash}`);
    if (!response.ok) {
      let message = `Ошибка ${response.status}`;
      try { message = (await response.json()).error || message; } catch {}
      throw new Error(`${model.name}: ${message}`);
    }
    const parsed = parseGeometry(await response.arrayBuffer());
    if (!this.active) { parsed.geometry.dispose(); return; }
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.82,
      metalness: 0.02,
      transparent: true,
      alphaTest: 0.01,
      depthWrite: true,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(parsed.geometry, material);
    mesh.visible = !this.hiddenModels.has(model.id);
    this.scene.add(mesh);
    this.combinedBounds.union(parsed.geometry.boundingBox);
    this.modelViews.push({
      model,
      mesh,
      geometry: parsed.geometry,
      ranges: parsed.ranges,
      colors: new Uint32Array(parsed.geometry.getAttribute('color').array.buffer),
      colorAttribute: parsed.geometry.getAttribute('color'),
      elementCodes: modelElementCodes(model, this.payload.traits),
      states: new Map(),
      triangles: parsed.triangles,
    });
    this.scheduleRender();
  }

  applyStatuses() {
    const counts = { completed: 0, inProgress: 0, notStarted: 0, unlinked: 0 };
    for (const view of this.modelViews) {
      const modelVisible = !this.hiddenModels.has(view.model.id);
      view.mesh.visible = modelVisible;
      if (!modelVisible) continue;
      let changed = false;
      for (const [expressId, ranges] of view.ranges) {
        const code = view.elementCodes.get(expressId);
        const work = code ? this.workMap.get(C.normalize(code)) : null;
        const calculated = work ? statusKey(C.aggregateStatusAt(work.operations, this.selectedDate, this.version.date)) : 'unlinked';
        const state = calculated === 'hidden' ? 'unlinked' : calculated;
        if (modelVisible) counts[state] += 1;
        const displayState = this.hiddenStates.has(state) ? 'hidden' : state;
        if (view.states.get(expressId) === displayState) continue;
        view.states.set(expressId, displayState);
        const color = pack(COLOR[displayState]);
        for (const range of ranges) view.colors.fill(color, range.start, range.start + range.count);
        changed = true;
      }
      if (changed) view.colorAttribute.needsUpdate = true;
    }
    for (const [key, count] of Object.entries(counts)) {
      const node = this.root.querySelector(`#count-${key}`);
      if (node) node.textContent = count.toLocaleString('ru-RU');
    }
    this.root.querySelector('#timeline-date-label').textContent = formatDate(this.selectedDate);
    this.renderCurrentWorks();
    this.scheduleRender();
  }

  visibleWorkCodes() {
    const codes = new Set();
    for (const view of this.modelViews) {
      if (this.hiddenModels.has(view.model.id)) continue;
      for (const code of view.elementCodes.values()) {
        const normalized = code ? C.normalize(code) : '';
        if (normalized && this.workMap.has(normalized)) codes.add(normalized);
      }
    }
    return codes;
  }

  renderCurrentWorks() {
    const list = this.root.querySelector('.viewer-current-work-list');
    if (!list) return;
    const visibleCodes = this.visibleWorkCodes();
    const sortDate = (work, status) => {
      const values = work.operations.map(operation => status === 'Завершено'
        ? (operation.ff || operation.pf)
        : (operation.fs || operation.ps)).filter(Boolean).sort();
      return values.at(-1) || '';
    };
    const items = [...this.workMap.entries()]
      .filter(([code]) => visibleCodes.has(code))
      .map(([normalized, work]) => {
        const status = C.aggregateStatusAt(work.operations, this.selectedDate, this.version.date);
        return { normalized, work, status, orderDate: sortDate(work, status) };
      })
      .filter(item => ['В работе', 'Завершено'].includes(item.status) && !this.hiddenStates.has(statusKey(item.status)))
      .sort((left, right) => {
        const stateOrder = Number(right.status === 'В работе') - Number(left.status === 'В работе');
        return stateOrder || right.orderDate.localeCompare(left.orderDate) || left.work.code.localeCompare(right.work.code, 'ru');
      });
    const sections = [
      ['В работе', 'inProgress'],
      ['Завершено', 'completed'],
    ];
    list.innerHTML = sections.map(([label, state]) => {
      const works = items.filter(item => item.status === label);
      if (!works.length) return '';
      return `<section class="viewer-current-work-section"><div class="viewer-current-work-section-head"><span>${label}</span><b>${works.length.toLocaleString('ru-RU')}</b></div>${works.map(item => {
        const expanded = this.expandedWorks.has(item.normalized);
        const operations = expanded ? `<div class="viewer-current-operations">${item.work.operations.map(operation => {
          const operationStatus = C.operationStatusAt(operation, this.selectedDate, this.version.date);
          const operationState = statusKey(operationStatus);
          const rangeStart = operation.fs || operation.ps;
          const rangeEnd = operation.ff || operation.pf;
          return `<article><i class="${operationState}"></i><span><b title="${esc(operation.name)}">${esc(operation.name || 'Операция')}</b><small>${formatDate(rangeStart)} — ${formatDate(rangeEnd)}</small></span><em>${esc(operationStatus)}</em></article>`;
        }).join('')}</div>` : '';
        return `<div class="viewer-current-work ${expanded ? 'expanded' : ''}"><button type="button" data-current-work="${esc(item.normalized)}" aria-expanded="${expanded}"><i class="${state}"></i><span><strong title="${esc(item.work.code)}">${esc(item.work.code)}</strong><small>${item.work.operations.length.toLocaleString('ru-RU')} ${item.work.operations.length === 1 ? 'операция' : 'операций'}</small></span><b>${expanded ? '⌃' : '⌄'}</b></button>${operations}</div>`;
      }).join('')}</section>`;
    }).join('');
    if (!items.length) list.innerHTML = '<div class="viewer-current-work-empty">На выбранную дату нет показанных работ в работе или завершённых.</div>';
    const count = this.root.querySelector('.viewer-current-work-count');
    if (count) count.textContent = items.length.toLocaleString('ru-RU');
  }

  setDate(date, syncRange = true) {
    if (!date) return;
    const min = iso(this.bounds.min).getTime();
    const max = iso(this.bounds.max).getTime();
    const time = clamp(iso(date).getTime(), min, max);
    this.selectedDate = toIso(new Date(time));
    this.root.querySelector('#timeline-date').value = this.selectedDate;
    if (syncRange) this.root.querySelector('#timeline-range').value = String(Math.round((time - min) / DAY));
    this.applyStatuses();
  }

  drawTimeline() {
    const range = this.root.querySelector('#timeline-range');
    const minTime = iso(this.bounds.min).getTime();
    const maxTime = iso(this.bounds.max).getTime();
    const days = Math.max(1, Math.round((maxTime - minTime) / DAY));
    range.max = String(days);
    const selected = clamp(iso(this.selectedDate).getTime(), minTime, maxTime);
    this.selectedDate = toIso(new Date(selected));
    range.value = String(Math.round((selected - minTime) / DAY));
    const dateInput = this.root.querySelector('#timeline-date');
    dateInput.min = this.bounds.min;
    dateInput.max = this.bounds.max;
    dateInput.value = this.selectedDate;
    const reportPercent = clamp((iso(this.version.date).getTime() - minTime) / Math.max(maxTime - minTime, DAY) * 100, 0, 100);
    this.root.querySelector('.timeline-fact').style.width = `${reportPercent}%`;
    this.root.querySelector('.timeline-plan').style.left = `${reportPercent}%`;
    this.root.querySelector('.timeline-plan').style.width = `${100 - reportPercent}%`;
    this.root.querySelector('.timeline-report').style.left = `${reportPercent}%`;
    const ticks = [], grid = [];
    let month = new Date(Date.UTC(iso(this.bounds.min).getUTCFullYear(), iso(this.bounds.min).getUTCMonth(), 1));
    if (month.getTime() < minTime) month.setUTCMonth(month.getUTCMonth() + 1);
    while (month.getTime() <= maxTime) {
      const date = toIso(month);
      const percent = (month.getTime() - minTime) / Math.max(maxTime - minTime, DAY) * 100;
      grid.push(`<i style="left:${percent}%"></i>`);
      ticks.push(`<span style="left:${percent}%">${formatMonth(date)}</span>`);
      month = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1));
    }
    this.root.querySelector('.timeline-grid').innerHTML = grid.join('');
    this.root.querySelector('.timeline-ticks').innerHTML = ticks.join('');
    this.root.querySelector('#timeline-date-label').textContent = formatDate(this.selectedDate);
  }

  focusTimeline() {
    const linkedOperations = [];
    const linkedCodes = new Set();
    for (const view of this.modelViews.filter(candidate => !this.hiddenModels.has(candidate.model.id))) {
      for (const code of view.elementCodes.values()) if (code && this.workMap.has(C.normalize(code))) linkedCodes.add(C.normalize(code));
    }
    for (const [code, work] of this.workMap) if (linkedCodes.has(code)) linkedOperations.push(...work.operations);
    const linked = C.timelineBounds(linkedOperations);
    if (!linked.min || !linked.max) return;
    this.stop();
    this.bounds = {
      min: C.max([this.fullBounds.min, offsetDays(linked.min, -7)]),
      max: C.min([this.fullBounds.max, offsetDays(linked.max, 7)]),
    };
    this.root.querySelector('[data-viewer-action="focus"]').disabled = true;
    this.root.querySelector('[data-viewer-action="full"]').disabled = false;
    this.drawTimeline();
    this.setDate(this.selectedDate);
  }

  showFullTimeline() {
    this.stop();
    this.bounds = { ...this.fullBounds };
    this.root.querySelector('[data-viewer-action="focus"]').disabled = false;
    this.root.querySelector('[data-viewer-action="full"]').disabled = true;
    this.drawTimeline();
    this.setDate(this.selectedDate);
  }

  action(action) {
    if (action === 'zoom-in' || action === 'zoom-out') {
      const factor = action === 'zoom-in' ? 0.82 : 1.22;
      this.camera.position.copy(this.controls.target).add(this.camera.position.clone().sub(this.controls.target).multiplyScalar(factor));
      this.controls.update();
      return;
    }
    if (['fit', 'iso', 'top', 'front', 'right'].includes(action)) { this.fit(action === 'fit' ? 'iso' : action); return; }
    if (action === 'play') { this.playTimer ? this.stop() : this.play(); return; }
    if (action === 'focus') this.focusTimeline();
    if (action === 'full') this.showFullTimeline();
  }

  fit(direction = 'iso') {
    const visibleBounds = new THREE.Box3();
    for (const view of this.modelViews) if (!this.hiddenModels.has(view.model.id)) visibleBounds.union(view.geometry.boundingBox);
    if (visibleBounds.isEmpty()) return;
    const sphere = visibleBounds.getBoundingSphere(new THREE.Sphere());
    const center = sphere.center;
    const radius = Math.max(sphere.radius, 1);
    const vectors = {
      iso: new THREE.Vector3(1.15, 0.8, 1.15),
      top: new THREE.Vector3(0, 1, 0),
      front: new THREE.Vector3(0, 0.12, 1),
      right: new THREE.Vector3(1, 0.12, 0),
    };
    this.camera.up.set(0, direction === 'top' ? 0 : 1, direction === 'top' ? -1 : 0);
    this.camera.position.copy(center).add(vectors[direction].normalize().multiplyScalar(radius * 2.35));
    this.camera.near = Math.max(radius / 1000, 0.01);
    this.camera.far = Math.max(radius * 30, 1000);
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
    if (!this.grid) {
      this.grid = new THREE.GridHelper(radius * 4, 48, 0xb6c1c6, 0xd5dde0);
      this.grid.position.set(center.x, visibleBounds.min.y - radius * 0.004, center.z);
      this.scene.add(this.grid);
    }
    this.scheduleRender();
  }

  play() {
    const button = this.root.querySelector('[data-viewer-action="play"]');
    button.textContent = 'Ⅱ';
    button.setAttribute('aria-label', 'Поставить на паузу');
    const tick = () => {
      const next = this.step === 'month' ? offsetMonths(this.selectedDate) : offsetDays(this.selectedDate, this.step);
      if (next > this.bounds.max) { this.stop(); return; }
      this.setDate(next);
    };
    this.playTimer = setInterval(tick, 700);
  }

  stop() {
    clearInterval(this.playTimer);
    this.playTimer = null;
    const button = this.root.querySelector('[data-viewer-action="play"]');
    if (button) { button.textContent = '▶'; button.setAttribute('aria-label', 'Запустить воспроизведение'); }
  }

  scheduleRender() {
    if (!this.active || !this.renderer) return;
    cancelAnimationFrame(this.renderFrame);
    this.renderFrame = requestAnimationFrame(() => this.renderer.render(this.scene, this.camera));
  }

  close() {
    if (!this.active) return;
    this.active = false;
    this.stop();
    document.removeEventListener('keydown', this.escapeHandler);
    this.resizeObserver?.disconnect();
    cancelAnimationFrame(this.renderFrame);
    this.controls?.dispose();
    for (const view of this.modelViews) {
      view.geometry.dispose();
      view.mesh.material.dispose();
    }
    this.renderer?.dispose();
    this.root.innerHTML = '';
    document.body.classList.remove('viewer-open');
    window.dispatchEvent(new CustomEvent('sb-viewer-closed'));
  }
}

let currentSession = null;
window.SBViewer = {
  open(payload) {
    currentSession?.close();
    const root = document.querySelector('#viewer-root');
    currentSession = new ViewerSession(root, payload);
    currentSession.open();
  },
  close() { currentSession?.close(); currentSession = null; },
};
window.dispatchEvent(new CustomEvent('sb-viewer-ready'));

