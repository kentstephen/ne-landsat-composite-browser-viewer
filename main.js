// The viewer on deck.gl-raster: the pyramid as published, band per array, no copy.
import maplibregl from "maplibre-gl";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { ZarrLayer } from "@developmentseed/deck.gl-zarr";
import * as zarr from "zarrita";

const q = new URLSearchParams(location.search);
const ROOT = q.get("src") || "https://data.source.coop/kentstephen/landsat-mosaics-new-england/pyramid_v1";
const BANDS = ["red", "green", "blue", "nir", "swir1", "swir2", "clear_count", "borrowed_pct", "pick_doy", "source"];
const idx = Object.fromEntries(BANDS.map((b, i) => [b, i]));
const SCALE = 0.0000275, OFFSET = -0.2;
const CLIM = [0.5, 0.92];
const THIN = 4;
const $ = (id) => document.getElementById(id);
const status = (t) => { const s = $("status"); if (t) { s.textContent = t; s.hidden = false; } else s.hidden = true; };

// ---- the store, once. Array opens are free on the consolidated root. ----
const store = await zarr.withConsolidatedMetadata(new zarr.FetchStore(ROOT));
const root = await zarr.open.v3(store, { kind: "group" });
const leafon = await zarr.open.v3(root.resolve("leafon"), { kind: "group" });
const attrs = leafon.attrs;
const layout = attrs.multiscales.layout;
const nLevels = layout.length;
const years = Array.from((await zarr.get(await zarr.open.v3(leafon.resolve("0/time"), { kind: "array" }))).data, Number);
const arrays = await Promise.all(layout.map(async (l) => {
  const out = {};
  for (const b of BANDS) { try { out[b] = await zarr.open.v3(leafon.resolve(`${l.asset}/${b}`), { kind: "array" }); } catch { /* source: level 0 only */ } }
  return out;
}));
// deck.gl-zarr wants each layout asset to be an array; ours are groups of
// bands. Point it at red; getTileData reads the siblings itself.
const metadata = { ...attrs, multiscales: { ...attrs.multiscales, layout: layout.map((l) => ({ ...l, asset: `${l.asset}/red` })) } };

// ---- per-year summary from the coarsest level: shares, clear-look and day histograms ----
const CC_MAX = 24;                       // clear-look histogram bins 0..CC_MAX, last bin is "CC_MAX or more"
const DOY0 = 90, DOY1 = 330, DOY_BIN = 10; // day-of-year bins
const summary = {};
{
  const L = arrays[nLevels - 1], T = years.length;
  const [nirAll, ccAll, bpAll, doyAll] = await Promise.all(["nir", "clear_count", "borrowed_pct", "pick_doy"].map((b) => zarr.get(L[b])));
  const per = nirAll.data.length / T;
  for (let t = 0; t < T; t++) {
    let valid = 0, thin = 0, borrowed = 0, bpSum = 0, unknown = 0;
    const cc = new Uint32Array(CC_MAX + 1), doy = new Uint32Array((DOY1 - DOY0) / DOY_BIN), ccAllv = [];
    for (let i = t * per; i < (t + 1) * per; i++) {
      if (nirAll.data[i] === 0) continue;
      valid++;
      const c = ccAll.data[i]; if (c < THIN) thin++; cc[Math.min(c, CC_MAX)]++; ccAllv.push(c);
      const bp = bpAll.data[i];
      if (bp === 255) unknown++; else if (bp > 0) { borrowed++; bpSum += bp; }
      const d = doyAll.data[i]; if (d >= DOY0 && d < DOY1) doy[Math.floor((d - DOY0) / DOY_BIN)]++;
    }
    ccAllv.sort((a, b) => a - b);
    summary[years[t]] = {
      valid, thin: valid ? thin / valid : 0, borrowed: valid ? borrowed / valid : 0, borrowedFoot: valid ? bpSum / 100 / valid : 0,
      unknown: valid ? unknown / valid : 0, medianCC: valid ? ccAllv[valid >> 1] : 0, cc, doy,
    };
  }
}
const pct = (x) => x < 0.005 ? (x === 0 ? "none" : "under 1%") : x < 0.095 ? `${(x * 100).toFixed(1)}%` : `${Math.round(x * 100)}%`;
function yearNote() {
  const s = summary[year]; if (!s) return "";
  return `${year}: ${pct(s.borrowed)} of the land is an observation from a neighbouring year; ${pct(s.thin)} sits on fewer than ${THIN} clear looks.`;
}

// ---- state ----
let year = Number(q.get("year")) || 2013; if (!years.includes(year)) year = years[years.length - 1];
let mode = 1;          // 0 greenness, 1 true colour, 2 false colour
let doubtOn = false, doubt = 1.0;

// ---- per tile: every band with the same slice, one r32float 2d-array texture ----
let fetched = 0;
async function getTileData(arr, opts) {
  const { device, sliceSpec, width, height, signal, z } = opts;
  const bandArrs = arrays[nLevels - 1 - z];
  const n = width * height, data = new Float32Array(BANDS.length * n);
  await Promise.all(BANDS.map(async (b, i) => {
    const a = bandArrs[b];
    if (!a) { data.fill(b === "source" ? 255 : 0, i * n, (i + 1) * n); return; }
    const r = await zarr.get(a, sliceSpec, { signal });
    data.set(r.data, i * n);
  }));
  fetched++;
  const prov = { valid: new Uint8Array(n), cc: new Uint8Array(n), bp: new Uint8Array(n), src: new Uint8Array(n) };
  for (let i = 0; i < n; i++) {
    prov.valid[i] = data[idx.nir * n + i] > 0 ? 1 : 0;
    prov.cc[i] = data[idx.clear_count * n + i];
    prov.bp[i] = data[idx.borrowed_pct * n + i];
    prov.src[i] = data[idx.source * n + i];
  }
  const texture = device.createTexture({
    dimension: "2d-array", format: "r32float", width, height, depth: BANDS.length, mipLevels: 1, data,
    sampler: { minFilter: "nearest", magFilter: "nearest", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" },
  });
  return { texture, width, height, prov, byteLength: data.byteLength + 4 * n };
}

// ---- one shader, three pictures, the doubt as opacity + stipple ----
const M = "composite";
const Composite = {
  name: M,
  fs: `uniform ${M}Uniforms {
  float mode;
  float doubt;
  float dimRef;
} ${M};
`,
  inject: {
    "fs:#decl": `precision highp sampler2DArray;
uniform sampler2DArray dataTex;
float bandAt(int i) { return texture(dataTex, vec3(geometry.uv, float(i))).r; }`,
    "fs:DECKGL_FILTER_COLOR": `
  float nirDN = bandAt(${idx.nir}), redDN = bandAt(${idx.red});
  if (nirDN == 0.0) discard;
  float nir = nirDN * ${SCALE} + (${OFFSET});
  float red = redDN * ${SCALE} + (${OFFSET});
  float ndvi = (nir - red) / max(nir + red, 1e-4);
  float norm = clamp((ndvi - ${CLIM[0]}) / (${CLIM[1]} - ${CLIM[0]}), 0.0, 1.0);
  vec3 g0 = vec3(0.07,0.19,0.06), g1 = vec3(0.17,0.42,0.18), g2 = vec3(0.35,0.63,0.31), g3 = vec3(0.61,0.81,0.50), g4 = vec3(0.81,0.91,0.70);
  vec3 green = norm < 0.25 ? mix(g0,g1,norm/0.25) : norm < 0.5 ? mix(g1,g2,(norm-0.25)/0.25) : norm < 0.75 ? mix(g2,g3,(norm-0.5)/0.25) : mix(g3,g4,(norm-0.75)/0.25);
  float cc = bandAt(${idx.clear_count}), bp = bandAt(${idx.borrowed_pct}), src = bandAt(${idx.source});
  bool borrowed = bp > 0.0 && bp < 255.0;
  vec3 rgb = green;
  if (${M}.mode == 1.0) {
    vec3 sr = vec3(redDN, bandAt(${idx.green}), bandAt(${idx.blue})) * ${SCALE} + (${OFFSET});
    rgb = pow(clamp(sr / 0.30, 0.0, 1.0), vec3(1.0 / 2.0)); // as the pair notebook: reflectance over 0.3, gamma 2
  } else if (${M}.mode == 2.0) {
    vec3 sr = vec3(bandAt(${idx.swir2}), nirDN, redDN) * ${SCALE} + (${OFFSET});
    rgb = pow(clamp(sr / 0.45, 0.0, 1.0), vec3(1.0 / 1.25));
  }
  float alpha = mix(1.0, smoothstep(0.0, ${M}.dimRef, cc), ${M}.doubt);
  vec2 p = floor(gl_FragCoord.xy / 3.0);
  bool isDot = mod(p.x + p.y, 2.0) == 0.0;
  if (borrowed && isDot && ${M}.doubt > 0.0) {
    vec3 tint = (src == 2.0) ? vec3(0.851, 0.349, 0.149) : vec3(0.224, 0.529, 0.898);
    rgb = mix(rgb, tint, ${M}.doubt * clamp(bp / 100.0, 0.5, 1.0));
    alpha = max(alpha, ${M}.doubt);
  }
  if (src == 3.0 && ${M}.doubt > 0.0) {
    float h = mod(gl_FragCoord.x + gl_FragCoord.y, 7.0);
    if (h < 1.5) rgb = mix(rgb, vec3(0.79, 0.76, 0.71), 0.6 * ${M}.doubt);
  }
  color = vec4(rgb, alpha);
`,
  },
  uniformTypes: { mode: "f32", doubt: "f32", dimRef: "f32" },
  getUniforms: (p) => ({ mode: p.mode ?? 1, doubt: p.doubt ?? 0, dimRef: p.dimRef ?? THIN, dataTex: p.dataTex }),
};

// ---- the layer. Its id carries the year so a year change refetches. ----
let beforeId;
function makeLayer() {
  const d = doubtOn ? doubt : 0;
  return new ZarrLayer({
    id: `composite-${year}`,
    node: leafon, metadata,
    selection: { time: years.indexOf(year) },
    getTileData,
    renderTile: (t) => ({ renderPipeline: [{ module: Composite, props: { dataTex: t.texture, mode, doubt: d, dimRef: THIN } }] }),
    onTileUnload: (t) => t.content?.texture?.destroy(),
    onViewportLoad: () => scheduleInView(),
    updateTriggers: { renderTile: [mode, d] },
    onError: (e) => status(`Layer error: ${e?.message || e}`),
    beforeId,
  });
}

const map = new maplibregl.Map({
  container: "map", style: q.get("basemap") || "https://tiles.openfreemap.org/styles/positron",
  center: [Number(q.get("lng") ?? -70.2), Number(q.get("lat") ?? 44.3)], zoom: Number(q.get("zoom") ?? 6.2), minZoom: 4.5, maxZoom: 15,
  attributionControl: { compact: true, customAttribution: "Landsat: USGS, via Planetary Computer" },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
map.on("moveend", () => scheduleInView());
let overlay;
map.on("load", () => {
  beforeId = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
  overlay = new MapboxOverlay({ interleaved: true, layers: [makeLayer()] });
  map.addControl(overlay);
  status("");
  window.__viewer = { map, overlay, years, get fetched() { return fetched; } };
  window.__set = ({ doubt: d, mode: m, yearIdx }) => {
    if (d != null) setDoubt(Boolean(d));
    if (m != null) setMode(m);
    if (yearIdx != null) { yearEl.value = yearIdx; yearEl.dispatchEvent(new Event("input")); }
  };
});
map.on("error", (e) => status(`Map error: ${e?.error?.message || e}`));
const rerender = () => overlay?.setProps({ layers: [makeLayer()] });

// ---- controls ----
const yearEl = $("year");
yearEl.min = 0; yearEl.max = years.length - 1; yearEl.value = years.indexOf(year);
$("yearOf").textContent = `of ${years[0]} to ${years[years.length - 1]}`;
function showYear() { $("yearOut").textContent = year; $("doubtYear").textContent = year; $("yearNote").textContent = yearNote(); renderRegion(); renderYears(); }
showYear();
let yearTimer;
yearEl.addEventListener("input", () => {
  year = years[Number(yearEl.value)]; showYear();
  clearTimeout(yearTimer);
  yearTimer = setTimeout(() => { rerender(); refreshReadout(); scheduleInView(); }, 120);
});
const stepYear = (d) => { yearEl.value = Math.min(years.length - 1, Math.max(0, Number(yearEl.value) + d)); yearEl.dispatchEvent(new Event("input")); };
$("yearPrev").addEventListener("click", () => stepYear(-1));
$("yearNext").addEventListener("click", () => stepYear(1));
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  if (e.key === "Escape" && doubtOn) { setDoubt(false); return; }
  if (e.key === "[" || e.key === "]") stepYear(e.key === "]" ? 1 : -1);
});

const modeButtons = [$("mColour"), $("mPicture"), $("mFalse")];
function setMode(m) {
  mode = m;
  modeButtons.forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.mode) === m)));
  rerender(); renderLegend();
}
modeButtons.forEach((b) => b.addEventListener("click", () => setMode(Number(b.dataset.mode))));
function setDoubt(on) {
  doubtOn = on;
  $("doubtOn").setAttribute("aria-pressed", String(on));
  $("doubtOn").querySelector(".state").textContent = on ? "on" : "off";
  $("doubt").hidden = !on;
  document.body.classList.toggle("doubt", on);
  $("map").classList.toggle("doubt", on);
  map.resize();
  rerender(); renderLegend();
  if (on) { renderRegion(); renderYears(); scheduleInView(); }
}
$("doubtOn").addEventListener("click", () => setDoubt(!doubtOn));
$("doubtClose").addEventListener("click", () => setDoubt(false));
{ // the "more below" cue hides once the panel is scrolled to its end
  const P = $("doubt");
  const atEnd = () => P.classList.toggle("atEnd", P.scrollTop + P.clientHeight >= P.scrollHeight - 24);
  P.addEventListener("scroll", atEnd, { passive: true });
  new ResizeObserver(atEnd).observe(P);
  P.querySelectorAll(".jump a").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); document.querySelector(a.getAttribute("href"))?.scrollIntoView({ behavior: "smooth", block: "start" }); }));
}
$("doubtStrength").addEventListener("input", (e) => {
  doubt = Number(e.target.value) / 100; $("doubtOut").textContent = `${e.target.value}%`;
  if (doubtOn) rerender();
});

function renderLegend() {
  $("legend").innerHTML = `
    <div class="row"><span class="ramp-fade"></span><span>Faded: fewer than ${THIN} clear looks behind the pixel</span></div>
    <div class="row"><span class="sw-before"></span><span>Observation is from the year before</span></div>
    <div class="row"><span class="sw-after"></span><span>Observation is from the year after (30 m level only; coarser levels show one blue class)</span></div>
    <div class="row"><span class="sw-l7"></span><span>Own year, but Landsat 7 filling a gap (30 m level only)</span></div>
    <div class="row"><span class="sw-nodata"></span><span>No observation that year</span></div>
    <p>Every pixel is one real observation. The picture does not change; this view fades what little sat behind a pixel, and marks what came from another year.</p>`;
}
setMode(mode); renderLegend();

// ---- the panel: this year across the region, from the coarsest level ----
const coarseRes = Math.round(layout[nLevels - 1]["spatial:transform"][0] / 0.00025 * 30);
function svgBars(bins, { W = 356, H = 88, padL = 4, padR = 4, padT = 8, padB = 18, cls = () => "b", labels = [], marks = [], windows = [] } = {}) {
  const n = bins.length, max = Math.max(1e-9, ...bins);
  const bw = (W - padL - padR) / n, x = (i) => padL + i * bw, y = (v) => padT + (1 - v / max) * (H - padT - padB);
  const win = windows.map(([a, b]) => `<rect class="window" x="${x(a).toFixed(1)}" y="${padT}" width="${(x(b) - x(a)).toFixed(1)}" height="${H - padT - padB}"></rect>`).join("");
  const bars = bins.map((v, i) => `<rect class="${cls(i, v)}" x="${(x(i) + 0.5).toFixed(1)}" y="${y(v).toFixed(1)}" width="${Math.max(0.5, bw - 1).toFixed(1)}" height="${(H - padB - y(v)).toFixed(1)}"><title>${labels[i]?.title ?? ""}</title></rect>`).join("");
  const mk = marks.map((i) => `<line class="mark" x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="${padT}" y2="${H - padB}"></line>`).join("");
  const tx = labels.filter((l) => l && l.text != null).map((l, k, all) => `<text x="${(x(l.i) + (l.i === n - 1 ? bw : 0)).toFixed(1)}" y="${H - 4}" text-anchor="${l.i === 0 ? "start" : l.i === n - 1 ? "end" : "middle"}">${l.text}</text>`).join("");
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">${win}<line class="axis" x1="${padL}" x2="${W - padR}" y1="${(H - padB).toFixed(1)}" y2="${(H - padB).toFixed(1)}"></line>${bars}${mk}${tx}</svg>`;
}
function statTiles(items) {
  return items.map((s) => `<div class="stat ${s.cls || ""}"><b>${s.v}</b><span>${s.k}</span></div>`).join("");
}
function renderRegion() {
  if (!doubtOn) return;
  const s = summary[year]; if (!s) return;
  $("regionRes").textContent = `${year}, ${coarseRes} m blocks`;
  $("regionStats").innerHTML = statTiles([
    { v: pct(s.borrowed), k: "of the land is from a neighbouring year", cls: "before" },
    { v: pct(s.thin), k: `sits on fewer than ${THIN} clear looks` },
    { v: s.medianCC, k: "clear looks behind the typical pixel" },
  ]);
  const tot = s.valid || 1;
  const ccLabels = []; for (let i = 0; i <= CC_MAX; i++) ccLabels[i] = { i, title: `${i === CC_MAX ? CC_MAX + "+" : i} clear looks: ${pct(s.cc[i] / tot)}`, text: i === 0 ? "0" : i === THIN ? String(THIN) : i % 8 === 0 ? String(i) : i === CC_MAX ? `${CC_MAX}+` : null };
  $("ccChart").innerHTML = svgBars(Array.from(s.cc, (v) => v / tot), { cls: (i) => i < THIN ? "b thin" : "b", labels: ccLabels, marks: [THIN] });
  $("ccNote").textContent = `Grey bars sit below ${THIN}, where the map fades.` + (s.unknown > 0 ? ` Provenance is unknown for ${pct(s.unknown)} of the land (outside the source pass).` : "");
  const months = [[121, "May"], [152, "Jun"], [182, "Jul"], [213, "Aug"], [244, "Sep"], [274, "Oct"], [305, "Nov"]];
  const dbin = (d) => (d - DOY0) / DOY_BIN;
  const doyLabels = months.map(([d, m]) => ({ i: Math.round(dbin(d)), text: m }));
  const doyBins = Array.from(s.doy, (v) => v / tot);
  doyBins.forEach((v, i) => { doyLabels.push({ i, title: `days ${DOY0 + i * DOY_BIN} to ${DOY0 + (i + 1) * DOY_BIN - 1}: ${pct(v)}` }); });
  const doyLab = []; doyLabels.forEach((l) => { doyLab[l.i] = { ...(doyLab[l.i] || {}), ...l }; });
  $("doyChart").innerHTML = svgBars(doyBins, { cls: () => "b doy", labels: doyLab, windows: [[dbin(152), dbin(274)]] });
}
function renderYears() {
  if (!doubtOn) return;
  const W = 356, H = 110, padL = 4, padR = 4, padT = 8, padB = 18, gap = 2;
  const n = years.length, bw = (W - padL - padR) / n, x = (i) => padL + i * bw;
  const rowH = (H - padT - padB - gap) / 2;
  const maxB = Math.max(0.01, ...years.map((y) => summary[y].borrowed)), maxT = Math.max(0.01, ...years.map((y) => summary[y].thin));
  const g = years.map((y, i) => {
    const s = summary[y];
    const hb = (s.borrowed / maxB) * rowH, ht = (s.thin / maxT) * rowH;
    return `<g class="yr ${y === year ? "now" : ""}" data-i="${i}">
      <rect class="hit" x="${x(i).toFixed(1)}" y="${padT}" width="${bw.toFixed(1)}" height="${H - padT - padB}" rx="2"><title>${y}: ${pct(s.borrowed)} from a neighbouring year, ${pct(s.thin)} on fewer than ${THIN} clear looks</title></rect>
      <rect class="b before" x="${(x(i) + 1).toFixed(1)}" y="${(padT + rowH - hb).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${hb.toFixed(1)}"></rect>
      <rect class="b thin" x="${(x(i) + 1).toFixed(1)}" y="${(padT + rowH + gap + rowH - ht).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${ht.toFixed(1)}"></rect>
    </g>`;
  }).join("");
  $("yearsChart").innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Borrowed and thin share by year">
    <line class="axis" x1="${padL}" x2="${W - padR}" y1="${(padT + rowH).toFixed(1)}" y2="${(padT + rowH).toFixed(1)}"></line>
    <line class="axis" x1="${padL}" x2="${W - padR}" y1="${(H - padB).toFixed(1)}" y2="${(H - padB).toFixed(1)}"></line>
    ${g}
    <text x="${padL}" y="${H - 4}">${years[0]}</text>
    <text x="${W - padR}" y="${H - 4}" text-anchor="end">${years[n - 1]}</text>
  </svg>
  <p class="small">Top row, blue: share from a neighbouring year, tallest bar ${pct(maxB)}. Bottom row, grey: share on fewer than ${THIN} clear looks, tallest bar ${pct(maxT)}.</p>`;
  $("yearsChart").querySelectorAll(".yr").forEach((el) => el.addEventListener("click", () => { yearEl.value = el.dataset.i; yearEl.dispatchEvent(new Event("input")); }));
}

// ---- the panel: what is on screen, from the tiles already loaded ----
let inViewTimer;
function scheduleInView() { if (!doubtOn) return; clearTimeout(inViewTimer); inViewTimer = setTimeout(renderInView, 150); }
function renderInView() {
  if (!doubtOn) return;
  const tl = overlay?._deck?.layerManager?.getLayers().find((l) => l.state?.tileset);
  const tiles = tl ? tl.state.tileset.tiles.filter((t) => t.isVisible && t.content?.prov) : [];
  if (!tiles.length) { $("viewBody").innerHTML = `<p class="empty">Waiting for tiles.</p>`; $("viewNote").textContent = ""; return; }
  const z = Math.max(...tiles.map((t) => t.index.z)), lvl = nLevels - 1 - z;
  const res = Math.round(layout[lvl]["spatial:transform"][0] / 0.00025 * 30);
  const hasSrc = lvl === 0;
  let valid = 0, thin = 0, borrowed = 0, bpSum = 0, unknown = 0, own = 0, before = 0, after = 0, l7 = 0, other = 0, total = 0;
  const cc = new Uint32Array(CC_MAX + 1);
  for (const t of tiles) {
    if (t.index.z !== z) continue;
    const { valid: v, cc: c, bp: b, src: s } = t.content.prov;
    total += v.length;
    for (let i = 0; i < v.length; i++) {
      if (!v[i]) continue;
      valid++;
      if (c[i] < THIN) thin++; cc[Math.min(c[i], CC_MAX)]++;
      const bp = b[i];
      if (bp === 255) unknown++; else if (bp > 0) { borrowed++; bpSum += bp; }
      if (hasSrc) {
        const k = s[i];
        if (k === 1) before++; else if (k === 2) after++; else if (k === 3) l7++;
        else if (k === 0 || (k === 255 && bp === 0)) own++; else other++;
      }
    }
  }
  $("viewWhere").textContent = `${year}, ${res} m pixels`;
  if (!valid) { $("viewBody").innerHTML = `<p class="empty">No observation on screen this year.</p>`; $("viewNote").textContent = ""; return; }
  const seg = hasSrc
    ? [["Own year", own, "var(--own)"], ["Year before", before, "var(--before)"], ["Year after", after, "var(--after)"], ["Landsat 7 fill", l7, "var(--own-l7)"], ["Unknown", other, "var(--ground-doubt)"]]
    : [["Own year", valid - borrowed - unknown, "var(--own)"], ["From a neighbouring year", borrowed, "var(--before)"], ["Unknown", unknown, "var(--ground-doubt)"]];
  const bar = seg.filter(([, v]) => v > 0).map(([, v, col]) => `<i style="width:${(100 * v / valid).toFixed(2)}%;background:${col}"></i>`).join("");
  const keys = seg.map(([k, v, col]) => `<span><i style="background:${col}"></i>${k} ${pct(v / valid)}</span>`).join("");
  const ccLabels = []; for (let i = 0; i <= CC_MAX; i++) ccLabels[i] = { i, title: `${i === CC_MAX ? CC_MAX + "+" : i} clear looks: ${pct(cc[i] / valid)}`, text: i === 0 ? "0" : i === THIN ? String(THIN) : i % 8 === 0 ? String(i) : i === CC_MAX ? `${CC_MAX}+` : null };
  $("viewBody").innerHTML = `
    <div class="stats">${statTiles([
      { v: pct(hasSrc ? (before + after) / valid : borrowed / valid), k: "from a neighbouring year", cls: "before" },
      { v: pct(thin / valid), k: `on fewer than ${THIN} clear looks` },
      { v: pct(valid / total), k: "of the screen has an observation" },
    ])}</div>
    <div class="share"><div class="bar">${bar}</div><div class="keys">${keys}</div></div>
    ${svgBars(Array.from(cc, (v) => v / valid), { H: 72, cls: (i) => i < THIN ? "b thin" : "b", labels: ccLabels, marks: [THIN] })}`;
  $("viewNote").textContent = hasSrc
    ? "At 30 m the source plane says which year each pixel's observation came from."
    : `Coarser than 30 m the source plane is not stored; a block counts as borrowed if any of its footprint came from a neighbouring year (${pct(bpSum / 100 / valid)} of the footprint on screen did). Zoom in for the split between before, after and Landsat 7.`;
}

// ---- the clicked pixel: read the ten arrays at the level on screen, every year ----
function levelOnScreen() {
  const tl = overlay?._deck?.layerManager?.getLayers().find((l) => l.state?.tileset);
  const zs = tl ? tl.state.tileset.tiles.filter((t) => t.isVisible).map((t) => t.index.z) : [];
  return zs.length ? nLevels - 1 - Math.max(...zs) : 0;
}
let clicked = null;
map.on("click", async (e) => {
  if (!overlay) return;
  const { lng, lat } = e.lngLat;
  const lvl = levelOnScreen();
  const [dx, , x0, , dy, y0] = layout[lvl]["spatial:transform"];
  const col = Math.floor((lng - x0) / dx), row = Math.floor((lat - y0) / dy);
  const A = arrays[lvl];
  const a0 = A.red;
  if (row < 0 || col < 0 || row >= a0.shape[1] || col >= a0.shape[2]) return;
  status("Reading the pixel's years");
  try {
    const want = ["nir", "red", "clear_count", "borrowed_pct", "source"].filter((b) => A[b]);
    const got = Object.fromEntries(await Promise.all(want.map(async (b) => [b, (await zarr.get(A[b], [null, row, col])).data])));
    const rows = years.map((y, t) => {
      const nirDN = got.nir[t], redDN = got.red[t];
      const valid = nirDN > 0;
      const nir = nirDN * SCALE + OFFSET, red = redDN * SCALE + OFFSET;
      return { year: y, valid, ndvi: valid ? (nir - red) / Math.max(nir + red, 1e-4) : null, cc: got.clear_count[t], bp: got.borrowed_pct[t], src: got.source ? got.source[t] : null };
    });
    clicked = { lng, lat, lvl, rows };
    if (!doubtOn) setDoubt(true);
    renderPixel();
    $("doubt").scrollTo({ top: 0, behavior: "smooth" });
  } catch (err) { status(`Could not read the pixel: ${err.message}`); return; }
  status("");
});

function renderPixel() {
  if (!clicked) return;
  const { lng, lat, lvl, rows } = clicked;
  const res = Math.round(layout[lvl]["spatial:transform"][0] / 0.00025 * 30);
  $("pixelWhere").textContent = `${lat.toFixed(3)}, ${lng.toFixed(3)} · ${res} m`;
  const W = 356, H = 100, padL = 4, padR = 4, padT = 10, padB = 18;
  const xs = (i) => padL + (i / (rows.length - 1)) * (W - padL - padR);
  const valid = rows.filter((r) => r.valid);
  if (!valid.length) { $("pixelBody").innerHTML = `<p class="empty">No observation at this pixel in any year.</p>`; $("readout").innerHTML = ""; return; }
  const vals = valid.map((r) => r.ndvi);
  let lo = Math.min(...vals) - 0.04, hi = Math.max(...vals) + 0.04;
  if (hi - lo < 0.2) { const m = (hi + lo) / 2; lo = m - 0.1; hi = m + 0.1; }
  const ys = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  const path = valid.map((r, k) => `${k ? "L" : "M"}${xs(rows.indexOf(r)).toFixed(1)},${ys(r.ndvi).toFixed(1)}`).join(" ");
  const cls = (r) => r.bp > 0 && r.bp < 255 ? (r.src === 2 ? "after" : "before") : (r.cc > 0 && r.cc < THIN ? "thin" : "");
  const pts = valid.map((r) => `<circle class="pt ${cls(r)}" cx="${xs(rows.indexOf(r)).toFixed(1)}" cy="${ys(r.ndvi).toFixed(1)}" r="3.5"><title>${r.year}</title></circle>`).join("");
  const first = valid[0], last = valid[valid.length - 1];
  $("pixelBody").innerHTML = `
    <svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="Greenness by year for the clicked pixel">
      <line class="grid" x1="${padL}" x2="${W - padR}" y1="${(H - padB).toFixed(1)}" y2="${(H - padB).toFixed(1)}"></line>
      <path class="line" d="${path}"></path>${pts}
      <line class="cursor" id="cursor" x1="0" x2="0" y1="${padT}" y2="${H - padB}" visibility="hidden"></line>
      <text x="${padL}" y="${H - 4}">${rows[0].year}</text>
      <text x="${W - padR}" y="${H - 4}" text-anchor="end">${rows[rows.length - 1].year}</text>
      <text x="${xs(rows.indexOf(first))}" y="${ys(first.ndvi) - 7}" text-anchor="start">${first.ndvi.toFixed(2)}</text>
      <text x="${xs(rows.indexOf(last))}" y="${ys(last.ndvi) - 7}" text-anchor="end">${last.ndvi.toFixed(2)}</text>
      <rect class="hit" x="0" y="0" width="${W}" height="${H}"></rect>
    </svg>`;
  const svg = $("pixelBody").querySelector("svg"), cursor = $("cursor");
  const pickRow = (ev) => {
    const box = svg.getBoundingClientRect(); const x = ((ev.clientX - box.left) / box.width) * W;
    let best = 0; for (let i = 1; i < rows.length; i++) if (Math.abs(xs(i) - x) < Math.abs(xs(best) - x)) best = i;
    return best;
  };
  svg.addEventListener("pointermove", (ev) => { const i = pickRow(ev); cursor.setAttribute("x1", xs(i)); cursor.setAttribute("x2", xs(i)); cursor.setAttribute("visibility", "visible"); readout(rows[i]); });
  svg.addEventListener("pointerleave", () => { cursor.setAttribute("visibility", "hidden"); refreshReadout(); });
  svg.addEventListener("click", (ev) => { const i = pickRow(ev); yearEl.value = i; yearEl.dispatchEvent(new Event("input")); });
  refreshReadout();
}
function whence(r) {
  if (!r.valid) return "no observation";
  const looks = `${r.cc} clear look${r.cc === 1 ? "" : "s"}`;
  if (r.bp > 0 && r.bp < 255) return `${looks}, observation from ${r.src == null ? "a neighbouring year" : r.src === 2 ? r.year + 1 : r.year - 1}`;
  if (r.src === 3) return `${looks}, Landsat 7 filling a gap`;
  return `${looks}, own year`;
}
function readout(r) {
  $("readout").innerHTML = r ? `<span class="k">${r.year}</span> greenness ${r.valid ? r.ndvi.toFixed(2) : "—"}<br><span class="k">${whence(r)}</span>` : "";
}
function refreshReadout() { if (clicked) readout(clicked.rows.find((r) => r.year === year)); }
