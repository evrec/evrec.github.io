import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

// Dati generati da tools/export_region.py:
//   data/index.json      [{id, nome}]
//   data/<id>.glb        mesh con userData.id (id di un nodo foglia)
//   data/<id>.json       {nodes:{id:{it,la,tipo,parent}}, landmarks:[{id,di,it,la,pos}]}
// Schede scritte a mano, fuse sopra i dati generati:
//   content/<id>.json    {structures:{id:{it?,testo,campi}}, landmarks:{id:{it?,testo}}}
const loader = new GLTFLoader().setDRACOLoader(
  new DRACOLoader().setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/draco/'));

const $ = s => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids);
  return n;
};
const COLORS = { osso: 0xe6dcc3, muscolo: 0xb5483f, altro: 0x9aa7b8 };
const GLOW = 0x1d4f94, SEL = 0x2f7fe0, MARK = 0xffc400;  // GLOW: struttura selezionata; SEL: rilievo selezionato

const view = $('#view'), tip = $('#tip');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
view.prepend(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 0.001, 100);
camera.add(new THREE.DirectionalLight(0xffffff, 2.2));
scene.add(camera, new THREE.HemisphereLight(0xffffff, 0x444455, 1.3));
const controls = new OrbitControls(camera, renderer.domElement);
const model = new THREE.Group(), dots = new THREE.Group();
scene.add(model, dots);

let region = null, regions = [];
let data = { nodes: {}, landmarks: [] };
let meshes = {};                  // id foglia -> [Mesh]
let kids = {};                    // id -> [id figli]
let sel = null, mark = null;      // nodo selezionato (foglia o gruppo) e rilievo selezionato
let hidden = new Set(), iso = null, dotSize = 0.004;
const layers = { osso: true, muscolo: true, altro: true };
const open = new Set();           // gruppi aperti nell'albero

function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(view);
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });

function frame(objs) {
  const box = new THREE.Box3();
  for (const o of objs) box.expandByObject(o);
  if (box.isEmpty()) return;
  const c = box.getCenter(new THREE.Vector3()), r = box.getSize(new THREE.Vector3()).length() / 2;
  const dir = camera.position.clone().sub(controls.target).normalize();
  controls.target.copy(c);
  const half = THREE.MathUtils.degToRad(camera.fov / 2);  // su schermi stretti il limite è il campo orizzontale
  camera.position.copy(c).addScaledVector(dir, r / Math.sin(Math.min(half, Math.atan(Math.tan(half) * camera.aspect))));
  camera.near = r / 100; camera.far = r * 100; camera.updateProjectionMatrix();
}

const node = id => data.nodes[id] ?? { it: id };
const name = id => node(id).it;
const marksOf = id => data.landmarks.filter(l => l.di === id);
const leaves = id => meshes[id] ? [id] : (kids[id] ?? []).flatMap(leaves);
const ancestors = id => { const a = []; for (let p = node(id).parent; p; p = node(p).parent) a.unshift(p); return a; };
const shown = id => layers[node(id).tipo] !== false && !hidden.has(id) && (!iso || iso.has(id));

async function loadRegion(id, pick = null) {
  region = id;
  model.clear(); dots.clear(); meshes = {}; kids = {}; sel = mark = iso = null; hidden = new Set(); open.clear();
  for (const b of $('#regions').children) b.setAttribute('aria-pressed', b.dataset.id === id);
  $('#card').replaceChildren(el('p', { textContent: 'Caricamento…' }));
  const [json, content, gltf] = await Promise.all([
    fetch(`data/${id}.json`).then(r => r.json()),
    fetch(`content/${id}.json`).then(r => r.ok ? r.json() : {}),
    loader.loadAsync(`data/${id}.glb`),
  ]);
  if (region !== id) return;  // nel frattempo è stata scelta un'altra regione
  data = json;
  // le schede possono rinominare, spostare (parent), ordinare (ord) e aggiungere gruppi, per seguire il trattato
  for (const [k, v] of Object.entries(content.structures ?? {})) data.nodes[k] = Object.assign(data.nodes[k] ?? { tipo: 'gruppo' }, v);
  for (const l of data.landmarks) Object.assign(l, content.landmarks?.[l.id]);
  data.landmarks.sort((a, b) => a.it.localeCompare(b.it, 'it'));
  for (const [k, n] of Object.entries(data.nodes)) (kids[n.parent ?? ''] ??= []).push(k);
  for (const list of Object.values(kids))
    list.sort((a, b) => (node(a).ord ?? 999) - (node(b).ord ?? 999) || name(a).localeCompare(name(b), 'it'));
  gltf.scene.traverse(o => {
    if (!o.isMesh) return;
    o.material = new THREE.MeshStandardMaterial({ color: COLORS[node(o.userData.id).tipo] ?? COLORS.altro, roughness: 0.75 });
    (meshes[o.userData.id] ??= []).push(o);
  });
  model.add(gltf.scene);
  dotSize = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3()).length() / 350;
  for (const k of kids[''] ?? []) open.add(k);
  camera.position.set(0, 0, 1); controls.target.set(0, 0, 0);
  frame([model]);
  const [nid, mid] = pick ?? [];
  select(data.nodes[nid] ? nid : null, mid ?? null);
}

// --- albero: gruppi apribili, foglie, rilievi sotto l'osso selezionato o trovati dalla ricerca
function renderTree() {
  const q = $('#q').value.trim().toLowerCase();
  const hit = o => `${o.it} ${o.la ?? ''}`.toLowerCase().includes(q);
  const matches = id => !q || hit(node(id)) || marksOf(id).some(hit) || (kids[id] ?? []).some(matches);
  const alive = id => meshes[id] ? layers[node(id).tipo] !== false : (kids[id] ?? []).some(alive);
  const row = (id, markId, label, cls, twisty) => {
    const b = el('button', { className: 'name', onclick: () => select(id, markId) }, label);
    b.setAttribute('aria-current', id === sel && markId === mark);
    b.dataset.key = markId ?? id;
    return el('li', { className: cls }, el('div', { className: 'row' }, twisty ?? el('span', { className: 'tw' }), b));
  };
  const build = ids => el('ul', {}, ...ids.filter(id => alive(id) && matches(id)).flatMap(id => {
    if (!meshes[id]) {
      const isOpen = q || open.has(id);
      const tw = el('button', { className: 'tw', textContent: isOpen ? '▾' : '▸', title: isOpen ? 'Chiudi' : 'Apri',
        onclick: () => { open.has(id) ? open.delete(id) : open.add(id); renderTree(); } });
      tw.setAttribute('aria-expanded', !!isOpen);
      const li = row(id, null, name(id), 'grp', tw);
      if (isOpen) li.append(build(kids[id] ?? []));
      return [li];
    }
    const dot = el('span', { className: 'dot' });
    dot.style.background = '#' + (COLORS[node(id).tipo] ?? COLORS.altro).toString(16).padStart(6, '0');
    const li = row(id, null, el('span', {}, dot, name(id)), shown(id) ? '' : 'off');
    const ms = q ? marksOf(id).filter(hit) : id === sel ? marksOf(id) : [];
    if (ms.length) li.append(el('ul', {}, ...ms.map(l => row(id, l.id, l.it, 'mark'))));
    return [li];
  }));
  $('#tree').replaceChildren(build(kids[''] ?? []));
}

function apply() {
  const on = new Set(sel ? leaves(sel) : []);
  for (const [id, ms] of Object.entries(meshes)) for (const m of ms) {
    m.visible = shown(id);
    m.material.emissive.setHex(on.has(id) ? GLOW : 0);
  }
  for (const d of dots.children) {
    const cur = d.userData.mark === mark;
    d.material.color.setHex(cur ? SEL : MARK);
    d.scale.setScalar(cur ? 1.8 : 1);
  }
}

function select(id, markId = null) {
  if (id !== sel) {
    dots.clear();
    for (const l of id ? marksOf(id) : []) {
      const d = new THREE.Mesh(new THREE.SphereGeometry(dotSize, 12, 8),
        new THREE.MeshBasicMaterial({ color: MARK, depthTest: false }));
      d.renderOrder = 1;
      d.position.fromArray(l.pos);
      d.userData.mark = l.id;
      dots.add(d);
    }
  }
  sel = id; mark = markId;
  if (id) for (const a of ancestors(id)) open.add(a);
  history.replaceState(null, '', '#' + [region, id, markId].filter(Boolean).map(encodeURIComponent).join('/'));
  apply(); renderTree(); renderCard();
  $('#tree').querySelector('[aria-current=true]')?.scrollIntoView({ block: 'nearest' });
}

function renderCard() {
  const card = $('#card');
  if (!sel) return card.replaceChildren(
    el('h2', { textContent: regions.find(r => r.id === region)?.nome ?? '' }),
    el('p', { textContent: 'Clicca una struttura nel modello o nell\'elenco per vederne la scheda. Selezionando un osso compaiono i suoi rilievi come punti gialli.' }));
  const link = (id, markId = null, text = name(id)) => el('button', { textContent: text, onclick: () => select(id, markId) });
  const m = data.landmarks.find(l => l.id === mark), o = m ?? node(sel);
  const crumbs = el('div', { className: 'crumbs' });
  for (const a of [...ancestors(sel), ...(m ? [sel] : [])]) crumbs.append(link(a), ' › ');
  const out = [crumbs, el('h2', { textContent: o.it })];
  if (o.la) out.push(el('p', { className: 'la', textContent: o.la }));
  if (o.testo) out.push(el('p', { textContent: o.testo }));
  else out.push(el('p', { className: 'todo', textContent: 'Scheda in preparazione.' }));
  for (const [k, v] of Object.entries(o.campi ?? {})) out.push(el('h3', { textContent: k }), el('p', { textContent: v }));
  const list = (title, items) => items.length && out.push(el('h3', { textContent: title }),
    el('ul', { className: 'parts' }, ...items.map(i => el('li', {}, i))));
  if (!m) {
    list(meshes[sel] ? '' : 'Comprende', (kids[sel] ?? []).map(k => link(k)));
    list('Rilievi e parti', marksOf(sel).map(l => link(sel, l.id, l.it)));
  }
  card.replaceChildren(...out);
  $('#right').scrollTop = 0;
}

// --- puntamento: clic = selezione, trascinamento = rotazione
const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
let down = null;
function pick(e) {
  const r = renderer.domElement.getBoundingClientRect();
  ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ptr, camera);
  const d = ray.intersectObjects(dots.children)[0];
  if (d) return { id: sel, mark: d.object.userData.mark };
  const m = ray.intersectObjects(model.children, true).find(h => h.object.visible);
  return m ? { id: m.object.userData.id } : null;
}
renderer.domElement.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', e => {
  if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
  const p = pick(e);
  select(p?.id ?? null, p?.mark ?? null);
});
renderer.domElement.addEventListener('pointermove', e => {
  const p = e.buttons ? null : pick(e);
  tip.style.display = p ? 'block' : 'none';
  if (!p) return;
  tip.textContent = p.mark ? data.landmarks.find(l => l.id === p.mark).it : name(p.id);
  const r = view.getBoundingClientRect();
  tip.style.left = e.clientX - r.left + 14 + 'px';
  tip.style.top = e.clientY - r.top + 14 + 'px';
});
renderer.domElement.addEventListener('pointerleave', () => { tip.style.display = 'none'; });
addEventListener('keydown', e => { if (e.key === 'Escape' && e.target.id !== 'q') select(null); });

const refresh = () => { apply(); renderTree(); };
$('#hide').onclick = () => { if (!sel) return; for (const id of leaves(sel)) hidden.add(id); select(null); };
$('#iso').onclick = () => { if (!sel) return; iso = new Set(leaves(sel)); refresh(); frame(leaves(sel).flatMap(id => meshes[id])); };
$('#all').onclick = () => { hidden.clear(); iso = null; refresh(); frame([model]); };
$('#q').oninput = renderTree;
for (const c of document.querySelectorAll('[data-layer]'))
  c.onchange = () => { layers[c.dataset.layer] = c.checked; refresh(); };

regions = await fetch('data/index.json').then(r => r.json());
$('#regions').append(...regions.map(r => {
  const b = el('button', { textContent: r.nome, onclick: () => loadRegion(r.id) });
  b.dataset.id = r.id;
  return b;
}));
resize();
const [rid, ...rest] = location.hash.slice(1).split('/').map(decodeURIComponent);
loadRegion(regions.some(r => r.id === rid) ? rid : regions[0].id, rest);
