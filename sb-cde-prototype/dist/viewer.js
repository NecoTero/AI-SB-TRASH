import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const C = window.Core;
const DAY = 86400000;
const HEADER_BYTES = 20;
const COLOR = {
  completed: [30, 201, 126, 255],
  inProgress: [48, 137, 235, 255],
  notStarted: [188, 199, 205, 92],
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
    this.hiddenStates = new Set();
    this.selectedDate = this.version.date;
    this.step = 1;
    this.playTimer = null;
    this.active = true;
    this.renderFrame = 0;
    this.fullBounds = timelineBounds(this.version.ops, this.version.date);
    this.bounds = { ...this.fullBounds };
    this.linkedCodes = new Set();
    for (const model of this.models) {
      for (const code of modelElementCodes(model, payload.traits).values()) {
        if (code && this.workMap.has(C.normalize(code))) this.linkedCodes.add(C.normalize(code));
      }
    }
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
      this.updateStats();
    } catch (error) {
      if (!this.active) return;
      const loading = this.root.querySelector('.viewer-loading');
      loading.classList.add('error');
      loading.innerHTML = `<strong>Модель не открылась</strong><span>${esc(error?.message || 'Не удалось загрузить геометрию')}</span>`;
    }
  }

  template() {
    const selectedNames = this.models.map(model => model.name.replace(/\.ifc$/i, '')).join(', ');
    return `<section class="viewer-screen" aria-label="Статусная модель СМР">
      <header class="viewer-header">
        <div class="viewer-brand"><b>КСУП</b> BIM</div>
        <div class="viewer-heading"><strong>Статусная модель СМР</strong><span>Название проекта</span></div>
        <div class="viewer-context"><span>График СМР <b>v${this.version.n}</b></span><span>Отчётная дата <b>${formatDate(this.version.date)}</b></span><span title="${esc(selectedNames)}">Моделей <b>${this.models.length}</b></span></div>
        <button class="viewer-close" type="button" aria-label="Закрыть 3D" title="Вернуться к реестру">×</button>
      </header>
      <div class="viewer-workspace">
        <div class="viewer-canvas" aria-label="Область 3D-модели"></div>
        <div class="viewer-tools" role="toolbar" aria-label="Управление камерой">
          <button data-viewer-action="zoom-in" title="Приблизить">+</button>
          <button data-viewer-action="zoom-out" title="Отдалить">−</button>
          <button data-viewer-action="fit">Вписать</button>
          <button data-viewer-action="iso">3D</button>
          <button data-viewer-action="top">Сверху</button>
          <button data-viewer-action="front">Спереди</button>
          <button data-viewer-action="right">Справа</button>
        </div>
        <aside class="viewer-legend">
          <div class="viewer-legend-head"><div><small>Статусная модель</small><strong>Статус СМР</strong></div><span class="viewer-ready" hidden>●</span></div>
          <button data-state="completed"><i class="completed"></i><span>Завершено</span><b id="count-completed">0</b></button>
          <button data-state="inProgress"><i class="in-progress"></i><span>В работе</span><b id="count-inProgress">0</b></button>
          <button data-state="notStarted"><i class="not-started"></i><span>Не начато</span><b id="count-notStarted">0</b></button>
          <div class="viewer-hidden-note"><i></i><span>Без КФО или связи</span><b id="count-hidden">0</b></div>
        </aside>
        <div class="viewer-loading"><span class="viewer-spinner"></span><strong>Подготавливаем IFC-геометрию…</strong><small id="viewer-load-progress">Это может занять время при первом открытии</small></div>
        <div class="viewer-help">ЛКМ — вращение · ПКМ — перемещение · колесо — масштаб</div>
      </div>
      <section class="viewer-timeline" aria-label="Таймлайн статусов">
        <div class="timeline-top">
          <div class="timeline-title"><small>Дата просмотра</small><strong id="timeline-date-label">${formatDate(this.selectedDate)}</strong></div>
          <input id="timeline-date" type="date" value="${this.selectedDate}" aria-label="Дата просмотра">
          <button data-viewer-action="play" class="timeline-play" aria-label="Запустить воспроизведение">▶</button>
          <div class="timeline-steps" aria-label="Шаг воспроизведения">
            <button data-step="1" class="active">1 день</button><button data-step="3">3 дня</button><button data-step="7">1 неделя</button>
          </div>
          <div class="timeline-spacer"></div>
          <button data-viewer-action="focus" class="timeline-focus">Фокус на BIM</button>
          <button data-viewer-action="full" class="timeline-full" disabled>Весь график</button>
        </div>
        <div class="timeline-track-wrap">
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
        this.step = Number(button.dataset.step);
        this.root.querySelectorAll('[data-step]').forEach(item => item.classList.toggle('active', item === button));
      };
    });
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
    const response = await fetch(`/api/models/${encodeURIComponent(model.id)}/versions/${model.selected}/geometry`);
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
    const counts = { completed: 0, inProgress: 0, notStarted: 0, hidden: 0 };
    for (const view of this.modelViews) {
      let changed = false;
      for (const [expressId, ranges] of view.ranges) {
        const code = view.elementCodes.get(expressId);
        const work = code ? this.workMap.get(C.normalize(code)) : null;
        let state = work ? statusKey(C.aggregateStatusAt(work.operations, this.selectedDate, this.version.date)) : 'hidden';
        counts[state] += 1;
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
    this.scheduleRender();
  }

  updateStats() {
    const elements = this.modelViews.reduce((sum, view) => sum + view.ranges.size, 0);
    const triangles = this.modelViews.reduce((sum, view) => sum + view.triangles, 0);
    this.root.querySelector('.viewer-help').textContent = `${elements.toLocaleString('ru-RU')} элементов · ${Math.round(triangles).toLocaleString('ru-RU')} треугольников · ЛКМ — вращение · ПКМ — перемещение · колесо — масштаб`;
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
    const ticks = [];
    const count = Math.min(6, days + 1);
    for (let index = 0; index < count; index += 1) {
      const percent = count === 1 ? 0 : index / (count - 1);
      const date = toIso(new Date(minTime + (maxTime - minTime) * percent));
      ticks.push(`<span style="left:${percent * 100}%">${formatDate(date)}</span>`);
    }
    this.root.querySelector('.timeline-ticks').innerHTML = ticks.join('');
    this.root.querySelector('#timeline-date-label').textContent = formatDate(this.selectedDate);
  }

  focusTimeline() {
    const linkedOperations = [];
    for (const [code, work] of this.workMap) if (this.linkedCodes.has(code)) linkedOperations.push(...work.operations);
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
    if (this.combinedBounds.isEmpty()) return;
    const sphere = this.combinedBounds.getBoundingSphere(new THREE.Sphere());
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
      this.grid.position.set(center.x, this.combinedBounds.min.y - radius * 0.004, center.z);
      this.scene.add(this.grid);
    }
    this.scheduleRender();
  }

  play() {
    const button = this.root.querySelector('[data-viewer-action="play"]');
    button.textContent = 'Ⅱ';
    button.setAttribute('aria-label', 'Поставить на паузу');
    const tick = () => {
      const next = offsetDays(this.selectedDate, this.step);
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

