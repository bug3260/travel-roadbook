/* 路书地图 app.js — 浏览器端交互、地图渲染、导入导出 */
(function () {
'use strict';
var C = window.RoadbookCore;
if (!C) { alert('核心模块 roadbook-core.js 加载失败'); return; }

/* ================= 常量与工具 ================= */
var LS_SETTINGS = 'roadbook.settings';
var LS_TRIPS = 'roadbook.trips';
var LS_ACTIVE = 'roadbook.active';

var PROVIDER_PRESETS = {
  deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini' },
  custom: { baseUrl: '', model: '' }
};

function $(sel) { return document.querySelector(sel); }
function $$(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
  });
}
function debounce(fn, ms) {
  var t = null;
  return function () {
    var args = arguments, self = this;
    if (t) clearTimeout(t);
    t = setTimeout(function () { fn.apply(self, args); }, ms);
  };
}
function downloadBlob(blob, filename) {
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

var toastTimer = null;
function toast(msg, kind) {
  var el = $('#toast');
  el.textContent = msg;
  el.className = kind || '';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.classList.add('hidden'); }, 3200);
}

/* ================= 设置 ================= */
function defaultSettings() {
  return {
    provider: 'deepseek',
    baseUrl: PROVIDER_PRESETS.deepseek.baseUrl,
    apiKey: '',
    model: PROVIDER_PRESETS.deepseek.model,
    amapKey: '',
    amapSecurityJsCode: ''
  };
}
function loadSettings() {
  var s = null;
  try { s = JSON.parse(localStorage.getItem(LS_SETTINGS)); } catch (e) { s = null; }
  var d = defaultSettings();
  if (s && typeof s === 'object') {
    ['provider', 'baseUrl', 'apiKey', 'model', 'amapKey', 'amapSecurityJsCode'].forEach(function (k) {
      if (typeof s[k] === 'string') d[k] = s[k];
    });
  }
  return d;
}
function saveSettings(s) { localStorage.setItem(LS_SETTINGS, JSON.stringify(s)); }
function hasLLM() { var s = state.settings; return !!s.apiKey && !!s.baseUrl && !!s.model; }
function hasAmapKey() { return !!state.settings.amapKey; }

/* ================= 状态与存储 ================= */
var state = {
  settings: loadSettings(),
  trips: [],          // [{id, trip}]
  activeId: null,
  map: null,          // AMap.Map 实例
  mapReady: false,
  overlays: [],       // 地图覆盖物（marker/polyline/label）
  infoWindow: null,
  routeCache: {},     // segKey -> {path, distance, duration, straight}
  selectedStopId: null,
  pickTarget: null,   // {kind:'edit'|'new', ...}
  editingStopId: null,
  poiMode: null,      // 'add' | 'pick'
  currentView: { kind: 'all', day: null },
  mapClickHandler: null,
  parseFileText: '',
  geocodeFailed: {},
  amapLoadPromise: null,
  amapLoadAttempt: null,
  amapFailSig: null,
  amapFailError: null,
  amapScriptKey: null
};

function activeTrip() {
  for (var i = 0; i < state.trips.length; i++) {
    if (state.trips[i].id === state.activeId) return state.trips[i];
  }
  return state.trips[0] || null;
}
function activeTripData() { var t = activeTrip(); return t ? t.trip : null; }

function loadTrips() {
  var raw = null;
  try { raw = JSON.parse(localStorage.getItem(LS_TRIPS)); } catch (e) { raw = null; }
  state.trips = [];
  if (Array.isArray(raw)) {
    raw.forEach(function (item) {
      if (item && typeof item === 'object' && item.id && item.trip) {
        state.trips.push({ id: String(item.id), trip: C.normalizeTrip(item.trip) });
      }
    });
  }
  var active = localStorage.getItem(LS_ACTIVE);
  state.activeId = state.trips.some(function (t) { return t.id === active; })
    ? active
    : (state.trips[0] ? state.trips[0].id : null);
}

var saveTripsDebounced = debounce(function () {
  localStorage.setItem(LS_TRIPS, JSON.stringify(state.trips.map(function (t) {
    return { id: t.id, trip: C.tripToExport(t.trip) };
  })));
  localStorage.setItem(LS_ACTIVE, state.activeId || '');
}, 400);

function saveTripsNow() {
  localStorage.setItem(LS_TRIPS, JSON.stringify(state.trips.map(function (t) {
    return { id: t.id, trip: C.tripToExport(t.trip) };
  })));
  localStorage.setItem(LS_ACTIVE, state.activeId || '');
}

function addTrip(trip, activate) {
  var id = C.uid('trip');
  state.trips.push({ id: id, trip: C.normalizeTrip(trip) });
  state.geocodeFailed = {};
  if (activate !== false) state.activeId = id;
  saveTripsNow();
  return id;
}
function updateActiveTrip(mutator) {
  var entry = activeTrip();
  if (!entry) return;
  mutator(entry.trip);
  entry.trip = C.normalizeTrip(entry.trip);
  saveTripsDebounced();
}
function deleteTrip(id) {
  var idx = -1;
  state.trips.forEach(function (t, i) { if (t.id === id) idx = i; });
  if (idx < 0) return;
  state.trips.splice(idx, 1);
  state.activeId = state.trips.length ? state.trips[Math.max(0, idx - 1)].id : null;
  if (!state.trips.length) state.trips.push({ id: C.uid('trip'), trip: C.normalizeTrip({ name: '我的路书', days: [{ day: 1, stops: [] }] }) });
  if (!state.activeId) state.activeId = state.trips[0].id;
  saveTripsNow();
}

function findStopById(trip, id) {
  var flat = C.flattenStops(trip);
  for (var i = 0; i < flat.length; i++) if (flat[i].stop.id === id) return flat[i];
  return null;
}
function removeStopById(trip, id) {
  (trip.days || []).forEach(function (d) {
    d.stops = (d.stops || []).filter(function (s) { return s.id !== id; });
  });
  trip.days = trip.days.filter(function (d) { return d.stops.length > 0; });
  if (!trip.days.length) trip.days = [{ day: 1, stops: [] }];
}
function countLocated(trip) {
  var flat = C.flattenStops(trip);
  var total = flat.length, ok = 0;
  flat.forEach(function (f) { if (f.stop.lng != null && f.stop.lat != null) ok++; });
  return { total: total, ok: ok };
}
/* ================= LLM ================= */
async function llmChatJson(messages) {
  var s = state.settings;
  return C.llmChatJson({
    baseUrl: s.baseUrl,
    apiKey: s.apiKey,
    model: s.model,
    messages: messages,
    fetchImpl: function (url, opts) { return fetch(url, opts); },
    attempts: 2
  });
}

/* ================= 文件文字提取 ================= */
function initPdfjs() {
  if (!window.pdfjsLib) throw new Error('PDF 组件未加载');
  if (!window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
  }
  return window.pdfjsLib;
}

async function extractTextFromFile(file) {
  var name = (file.name || '').toLowerCase();
  if (name.endsWith('.txt') || name.endsWith('.md') || name.endsWith('.text')) {
    return await file.text();
  }
  if (name.endsWith('.docx')) {
    if (!window.JSZip) throw new Error('DOCX 组件未加载');
    return await C.extractDocxText(await file.arrayBuffer(), window.JSZip);
  }
  if (name.endsWith('.pdf')) {
    var pdfjsLib = initPdfjs();
    return await C.extractPdfText(await file.arrayBuffer(), pdfjsLib);
  }
  throw new Error('不支持的文件格式（支持 .txt/.md/.docx/.pdf）');
}

/* ================= 识别路书流程 ================= */
function openParseModal() {
  state.parseFileText = '';
  $('#parseText').value = '';
  $('#dzFileInfo').classList.add('hidden');
  $('#dzFileInfo').textContent = '';
  setStatus('parseStatus', parseModeHintText(), 'info');
  openModal('modalParse');
}
function parseModeHintText() {
  return hasLLM() ? '智能解析：' + state.settings.model + '（失败自动回退规则解析）' : '未配置 API Key，使用内置规则解析';
}
function setStatus(id, text, kind) {
  var el = document.getElementById(id);
  if (!el) return;
  el.textContent = text || '';
  el.className = 'status-line ' + (kind || '');
}

async function handleParseFile(file) {
  try {
    setStatus('parseStatus', '正在提取文件文字…', 'info');
    var text = await extractTextFromFile(file);
    if (!text.trim()) throw new Error('文件中未提取到文字');
    state.parseFileText = text;
    $('#parseText').value = text.slice(0, 20000);
    var info = $('#dzFileInfo');
    info.textContent = '已读取：' + file.name + '（' + text.length + ' 字）';
    info.classList.remove('hidden');
    setStatus('parseStatus', '文件读取完成，可点击「开始解析」', 'ok');
  } catch (e) {
    setStatus('parseStatus', '文件读取失败：' + e.message, 'err');
  }
}

async function doParse() {
  var text = $('#parseText').value.trim();
  if (!text && !state.parseFileText) { setStatus('parseStatus', '请先粘贴路书内容或拖入文件', 'err'); return; }
  text = text || state.parseFileText;
  var btn = $('#btnDoParse');
  btn.disabled = true;
  setStatus('parseStatus', '正在解析路书…', 'info');
  try {
    var raw = null, usedAI = false;
    if (hasLLM()) {
      try {
        var prompt = C.buildParsePrompt(text);
        raw = await llmChatJson(prompt.messages);
        usedAI = !!raw;
      } catch (e) {
        raw = null;
      }
    }
    var trip;
    if (usedAI) {
      var t = C.llmRawToTrip(raw);
      if (t && C.flattenStops(t).length) { trip = t; }
      else { trip = C.normalizeTrip(C.parseRoadbookText(text)); usedAI = false; }
    } else {
      trip = C.normalizeTrip(C.parseRoadbookText(text));
    }
    if (!C.flattenStops(trip).length) {
      setStatus('parseStatus', '未能从内容中解析出地点，请检查路书格式', 'err');
      return;
    }
    addTrip(trip, true);
    closeModal('modalParse');
    toast('解析完成：' + trip.days.length + ' 天、' + C.flattenStops(trip).length + ' 个地点（' + (usedAI ? 'AI 智能解析' : '规则解析') + '）', 'ok');
    renderAll();
  } catch (e) {
    setStatus('parseStatus', '解析失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

/* ================= 生成路书流程 ================= */
function openGenerateModal() {
  $('#genDest').value = '';
  $('#genStart').value = '';
  $('#genDays').value = '3';
  $('#genPrefs').value = '';
  setStatus('genStatus', '', '');
  $('#genModeHint').textContent = hasLLM() ? 'AI 生成：' + state.settings.model : '未配置 Key：将生成空骨架，用 POI 搜索手动添加';
  openModal('modalGenerate');
}

async function doGenerate() {
  var form = {
    destination: $('#genDest').value.trim(),
    startCity: $('#genStart').value.trim(),
    days: parseInt($('#genDays').value, 10) || 3,
    preferences: $('#genPrefs').value.trim()
  };
  if (!form.destination) { setStatus('genStatus', '请填写目的地', 'err'); return; }
  var btn = $('#btnDoGenerate');
  btn.disabled = true;
  setStatus('genStatus', '正在生成路书，请稍候…', 'info');
  try {
    var trip = null, usedAI = false;
    if (hasLLM()) {
      try {
        var prompt = C.buildGeneratePrompt(form);
        var raw = await llmChatJson(prompt.messages);
        trip = C.llmRawToTrip(raw);
        if (trip && C.flattenStops(trip).length) { usedAI = true; trip.city = form.destination; }
        else trip = null;
      } catch (e) { trip = null; }
    }
    if (!trip) {
      var days = [];
      for (var i = 1; i <= Math.max(1, Math.min(30, form.days)); i++) days.push({ day: i, stops: [] });
      trip = C.normalizeTrip({ name: form.destination + '路书', city: form.destination, days: days });
    }
    addTrip(trip, true);
    closeModal('modalGenerate');
    toast(usedAI ? 'AI 生成完成，正在定位地点…' : '已生成空骨架，请用「＋ 添加地点」或 POI 搜索补充', usedAI ? 'ok' : '');
    renderAll();
  } catch (e) {
    setStatus('genStatus', '生成失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}
/* ================= 高德地图 ================= */
var AMAP_AUTH_PATTERN = /请使用正确的 JSAPI Key|INVALID_USER_KEY|USERKEY_PLAT_NOMATCH|INVALID_USER_SCODE/;
var AMAP_INVALID_MSG = '高德 Key 未生效：请确认①Key 类型为「Web端(JS API)」②已填写安全密钥(jscode)③Key 未过期或被禁用。本应用使用 JS API 1.4.15，不强制域名白名单，白名单留空即可；如需填写只能写纯域名（如 localhost，不带协议与端口）。';
function amapLibUsable(lib) {
  return !!(lib && typeof lib.Map === 'function' && typeof lib.ToolBar === 'function' &&
    typeof lib.Geocoder === 'function' && typeof lib.PlaceSearch === 'function');
}
function waitAmapReady(timeoutMs) {
  return new Promise(function (resolve, reject) {
    var started = Date.now();
    var timer = setInterval(function () {
      var lib = window.AMap;
      if (amapLibUsable(lib)) { clearInterval(timer); resolve(lib); return; }
      var hopeless = !lib || typeof lib.Map !== 'function' || Date.now() - started > timeoutMs;
      if (hopeless) { clearInterval(timer); reject(new Error(AMAP_INVALID_MSG)); }
    }, 150);
  });
}
function loadAMapScript() {
  var key = state.settings.amapKey;
  if (!key) return Promise.reject(new Error('未配置高德 Key'));
  if (amapLibUsable(window.AMap) && state.amapScriptKey === key) return Promise.resolve(window.AMap);
  var failSig = key + '|' + (state.settings.amapSecurityJsCode || '');
  if (state.amapFailSig === failSig && state.amapFailError) return Promise.reject(state.amapFailError);
  if (!state.amapLoadPromise) {
    var attempt = failSig + '|' + Date.now();
    state.amapLoadAttempt = attempt;
    var p = new Promise(function (resolve, reject) {
      var authWarned = false;
      var origWarn = null, origError = null;
      try { origWarn = console.warn; console.warn = function () {
        var a = Array.prototype.slice.call(arguments);
        if (AMAP_AUTH_PATTERN.test(a.join(' '))) authWarned = true;
        try { origWarn.apply(console, a); } catch (e) {}
      }; } catch (e) {}
      try { origError = console.error; console.error = function () {
        var a = Array.prototype.slice.call(arguments);
        if (AMAP_AUTH_PATTERN.test(a.join(' '))) authWarned = true;
        try { origError.apply(console, a); } catch (e) {}
      }; } catch (e) {}
      var restoreConsole = function () {
        if (origWarn) { try { console.warn = origWarn; } catch (e) {} }
        if (origError) { try { console.error = origError; } catch (e) {} }
      };
      var finish = function (err, val) {
        restoreConsole();
        if (state.amapLoadAttempt !== attempt) return;
        state.amapLoadPromise = null;
        state.amapLoadAttempt = null;
        if (!err && authWarned) err = new Error(AMAP_INVALID_MSG);
        if (err) { state.amapFailSig = failSig; state.amapFailError = err; reject(err); }
        else { state.amapScriptKey = key; resolve(val); }
      };
      window._AMapSecurityConfig = { securityJsCode: state.settings.amapSecurityJsCode || '' };
      var script = document.createElement('script');
      script.src = 'https://webapi.amap.com/maps?v=1.4.15&key=' + encodeURIComponent(key) +
        '&plugin=AMap.Driving,AMap.Walking,AMap.Transfer,AMap.Geocoder,AMap.PlaceSearch,AMap.ToolBar' +
        '&_t=' + Date.now();
      script.onload = function () {
        waitAmapReady(6000).then(function (lib) { finish(null, lib); }, function (e) { finish(e); });
      };
      script.onerror = function () { finish(new Error('高德地图脚本加载失败，请检查网络后重试')); };
      document.head.appendChild(script);
    });
    state.amapLoadPromise = p;
  }
  return state.amapLoadPromise;
}

async function initMap() {
  var AMapLib = await loadAMapScript();
  var map = new AMapLib.Map('map', {
    zoom: 5,
    center: [104.5, 33.0],
    mapStyle: 'amap://styles/normal'
  });
  map.addControl(new AMapLib.ToolBar({ position: 'RB' }));
  state.infoWindow = new AMapLib.InfoWindow({ offset: new AMapLib.Pixel(0, -36) });
  map.on('click', function (e) {
    if (state.pickTarget) onMapPick(e.lnglat);
  });
  // 选点模式提示条
  var hint = document.createElement('div');
  hint.id = 'pickHint';
  hint.className = 'hidden';
  hint.style.cssText = 'position:absolute;bottom:26px;left:50%;transform:translateX(-50%);background:#2f7de1;color:#fff;padding:6px 14px;border-radius:18px;font-size:12px;z-index:45;box-shadow:0 2px 8px rgba(15,34,58,.3)';
  hint.textContent = '📍 点击地图选择位置，再点「完成选点」';
  hint.addEventListener('click', stopPickMode);
  $('#mapWrap').appendChild(hint);
  return map;
}

function showMapHint(msg, title) {
  var hint = $('#mapHint');
  hint.querySelector('.hint-title').textContent = title || '未配置高德地图 Key';
  hint.querySelector('.hint-text').innerHTML = msg
    ? esc(msg) + '<br><br>解析、编辑与导出功能仍可使用。'
    : '配置后可在地图上标注景点、酒店与路线（免费申请约 5 分钟）。<br>解析、编辑与导出功能仍可使用。';
  hint.classList.remove('hidden');
  $('#geoProgress').classList.add('hidden');
}
function hideMapHint() { $('#mapHint').classList.add('hidden'); }

/* ---------- 地理编码 ---------- */
async function geocodeMissing() {
  var trip = activeTripData();
  if (!trip || !state.mapReady) return;
  var todo = C.flattenStops(trip).filter(function (f) {
    return (f.stop.lng == null || f.stop.lat == null) && !state.geocodeFailed[f.stop.id];
  });
  if (!todo.length) return;
  var progress = $('#geoProgress'), progressText = $('#geoProgressText');
  progress.classList.remove('hidden');
  var geocoder = null;
  try {
    geocoder = new AMap.Geocoder({ city: trip.city || undefined });
  } catch (e) {
    progress.classList.add('hidden');
    console.error('[geocodeMissing] 地理编码初始化失败', e);
    toast('地理编码不可用：' + errText(e, '未知错误'), 'err');
    return;
  }
  var changed = false;
  for (var i = 0; i < todo.length; i++) {
    var f = todo[i];
    progressText.textContent = '正在定位 ' + (i + 1) + '/' + todo.length + '：' + f.stop.name;
    var ok = false;
    try {
      ok = await new Promise(function (resolve) {
        geocoder.getLocation(f.stop.name, function (status, result) {
          if (status === 'complete' && result.geocodes && result.geocodes[0] && result.geocodes[0].location) {
            f.stop.lng = +result.geocodes[0].location.lng;
            f.stop.lat = +result.geocodes[0].location.lat;
            resolve(true);
          } else resolve(false);
        });
      });
    } catch (e) {
      ok = false;
    }
    if (ok) {
      delete state.geocodeFailed[f.stop.id];
      changed = true;
    } else {
      f.stop.lng = null;
      f.stop.lat = null;
      state.geocodeFailed[f.stop.id] = true;
    }
    await wait(220);
  }
  progress.classList.add('hidden');
  if (changed) {
    saveTripsNow();
    renderAll();
  }
}

/* ---------- 绘制 ---------- */
var drawGen = 0;
function clearOverlays() {
  state.overlays.forEach(function (o) { try { state.map.remove(o); } catch (e) {} });
  state.overlays = [];
  if (state.infoWindow) state.infoWindow.close();
}

function markerHtml(f) {
  var t = C.STOP_TYPES[f.stop.type];
  var time = f.stop.arrive ? ('D' + f.day + ' ' + f.stop.arrive) : ('D' + f.day);
  return '<div class="mk" data-id="' + esc(f.stop.id) + '">' +
    '<div class="mk-badge" style="background:' + t.color + '">' + esc(t.char) + '</div>' +
    '<div class="mk-time">' + esc(time) + '</div></div>';
}

function drawMarkers(trip, markerById) {
  C.flattenStops(trip).forEach(function (f) {
    var s = f.stop;
    if (s.lng == null || s.lat == null) return;
    var marker = new AMap.Marker({
      position: [s.lng, s.lat],
      content: markerHtml(f),
      offset: new AMap.Pixel(-13, -42),
      zIndex: 80,
      draggable: true
    });
    marker.on('click', function () { selectStop(s.id, true); });
    marker.on('dragend', function (e) {
      var st = findStopById(activeTripData(), s.id);
      if (!st) return;
      st.stop.lng = +e.lnglat.lng.toFixed(6);
      st.stop.lat = +e.lnglat.lat.toFixed(6);
      saveTripsDebounced();
      renderAll();
    });
    marker.setMap(state.map);
    state.overlays.push(marker);
    if (markerById) markerById[s.id] = marker;
  });
}

function haversineKm(a, b) {
  var R = 6371, rad = Math.PI / 180;
  var dLat = (b[1] - a[1]) * rad, dLng = (b[0] - a[0]) * rad;
  var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(x));
}
function estimateMinutes(distKm, transit) {
  var speed = transit === 'walk' ? 5 : (transit === 'transit' ? 35 : 40);
  return Math.max(1, Math.round(distKm / speed * 60));
}

function planRoute(seg, fromPos, toPos) {
  var transit = seg.transit;
  if (transit === 'drive') {
    return new Promise(function (resolve) {
      try {
        var dr = new AMap.Driving({ policy: AMap.DrivingPolicy.LEAST_TIME });
        dr.search(new AMap.LngLat(fromPos[0], fromPos[1]), new AMap.LngLat(toPos[0], toPos[1]), function (status, result) {
          if (status === 'complete' && result.routes && result.routes[0]) {
            var r = result.routes[0];
            resolve({ path: r.path, distance: r.distance, duration: Math.max(1, Math.round(r.time / 60)) });
          } else resolve(null);
        });
      } catch (e) { resolve(null); }
    });
  }
  if (transit === 'walk') {
    return new Promise(function (resolve) {
      try {
        var wk = new AMap.Walking();
        wk.search(new AMap.LngLat(fromPos[0], fromPos[1]), new AMap.LngLat(toPos[0], toPos[1]), function (status, result) {
          if (status === 'complete' && result.routes && result.routes[0]) {
            var r = result.routes[0];
            resolve({ path: r.path, distance: r.distance, duration: Math.max(1, Math.round(r.time / 60)) });
          } else resolve(null);
        });
      } catch (e) { resolve(null); }
    });
  }
  // transit：取总时长/距离，路线用直线虚线表示
  return new Promise(function (resolve) {
    try {
      var city = (activeTripData().city || '全国');
      var tr = new AMap.Transfer({ city: city, cityd: city, policy: AMap.TransferPolicy.LEAST_TIME });
      tr.search(new AMap.LngLat(fromPos[0], fromPos[1]), new AMap.LngLat(toPos[0], toPos[1]), function (status, result) {
        if (status === 'complete' && result.plans && result.plans[0]) {
          var p = result.plans[0];
          resolve({ path: null, distance: p.distance, duration: Math.max(1, Math.round((p.time || 0) / 60)) });
        } else resolve(null);
      });
    } catch (e) { resolve(null); }
  });
}

function drawSegments(trip) {
  var segs = C.deriveSegments(trip);
  var gen = ++drawGen;
  segs.forEach(function (seg) {
    var from = seg.from.stop, to = seg.to.stop;
    if (from.lng == null || from.lat == null || to.lng == null || to.lat == null) return;
    var color = C.dayColor(seg.day);
    var fromPos = [from.lng, from.lat], toPos = [to.lng, to.lat];
    var straightKm = haversineKm(fromPos, toPos);
    var estMin = estimateMinutes(straightKm, seg.transit);

    // 先画直线虚线 + 估算标签
    var poly = new AMap.Polyline({
      path: [fromPos, toPos],
      strokeColor: color,
      strokeWeight: 5,
      strokeOpacity: 0.8,
      strokeStyle: 'dashed',
      showDir: true,
      lineJoin: 'round',
      zIndex: 20
    });
    poly.setMap(state.map);
    state.overlays.push(poly);

    var mid = [(fromPos[0] + toPos[0]) / 2, (fromPos[1] + toPos[1]) / 2];
    var label = new AMap.Marker({
      position: mid,
      content: segLabelHtml(seg, estMin, straightKm, color),
      offset: new AMap.Pixel(-30, -16),
      zIndex: 70
    });
    label.setMap(state.map);
    state.overlays.push(label);

    // 异步取真实路线，成功后替换
    planRoute(seg, fromPos, toPos).then(function (route) {
      if (gen !== drawGen) return;
      if (!route || !route.path || !route.path.length) return;
      try { state.map.remove(poly); } catch (e) {}
      var real = new AMap.Polyline({
        path: route.path,
        strokeColor: color,
        strokeWeight: 5,
        strokeOpacity: 0.85,
        showDir: true,
        lineJoin: 'round',
        zIndex: 20
      });
      real.setMap(state.map);
      state.overlays.push(real);
      var p = route.path[Math.floor(route.path.length / 2)];
      label.setContent(segLabelHtml(seg, route.duration, route.distance / 1000, color));
      label.setPosition(new AMap.LngLat(p.lng, p.lat));
    });
  });
}

function segLabelHtml(seg, minutes, km, color) {
  var mode = C.TRANSIT_LABELS[seg.transit] || '??';
  var kmText = km == null || !isFinite(km) ? '' : (Math.round(km * 10) / 10) + 'km · ';
  return '<div class="seg-label" style="border-color:' + color + '">' + mode + ' ' + kmText + C.formatDuration(minutes) + '</div>';
}

function renderLegend(trip) {
  var el = $('#legend');
  var html = '<div class="legend-row"><b style="margin-right:2px">图例</b></div>';
  C.TYPE_KEYS.forEach(function (k) {
    var t = C.STOP_TYPES[k];
    html += '<div class="legend-row"><span class="legend-badge" style="background:' + t.color + '">' + esc(t.char) + '</span>' + esc(t.label) + '</div>';
  });
  var dayNos = trip.days.map(function (d) { return d.day; });
  if (dayNos.length > 1) {
    html += '<div class="legend-row" style="margin-top:4px"><b>天数</b></div>';
    dayNos.forEach(function (d) {
      html += '<div class="legend-row"><span class="legend-swatch" style="background:' + C.dayColor(d) + '"></span>第' + d + '天</div>';
    });
  }
  el.innerHTML = html;
  el.classList.remove('hidden');
}

function renderViewChips(trip) {
  var wrap = $('#viewChips');
  var html = '<button class="view-chip' + (state.currentView.kind === 'all' ? ' active' : '') + '" data-view="all">全程</button>';
  trip.days.forEach(function (d) {
    html += '<button class="view-chip' + (state.currentView.kind === 'day' && state.currentView.day === d.day ? ' active' : '') + '" data-view="day" data-day="' + d.day + '" style="border-left:4px solid ' + C.dayColor(d.day) + '">D' + d.day + '</button>';
  });
  wrap.innerHTML = html;
  $$('#viewChips .view-chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      state.currentView = chip.dataset.view === 'day' ? { kind: 'day', day: +chip.dataset.day } : { kind: 'all', day: null };
      applyCurrentView();
      renderViewChips(trip);
    });
  });
}

function boundsFor(trip, dayFilter) {
  var bounds = null;
  C.flattenStops(trip).forEach(function (f) {
    if (dayFilter != null && f.day !== dayFilter) return;
    var s = f.stop;
    if (s.lng == null || s.lat == null) return;
    if (!bounds) bounds = new AMap.Bounds([s.lng, s.lat], [s.lng, s.lat]);
    else bounds.extend([s.lng, s.lat]);
  });
  return bounds;
}
function applyCurrentView() {
  if (!state.mapReady) return;
  var trip = activeTripData();
  if (!trip) return;
  var bounds = state.currentView.kind === 'day'
    ? boundsFor(trip, state.currentView.day)
    : boundsFor(trip, null);
  if (bounds) state.map.setBounds(bounds);
}
function fitAll() { state.currentView = { kind: 'all', day: null }; applyCurrentView(); renderViewChips(activeTripData()); }
function fitDay(day) { state.currentView = { kind: 'day', day: day }; applyCurrentView(); renderViewChips(activeTripData()); }
function focusStop(id) {
  var f = findStopById(activeTripData(), id);
  if (!f || f.stop.lng == null || f.stop.lat == null) return;
  state.map.setZoomAndCenter(Math.max(12, state.map.getZoom()), [f.stop.lng, f.stop.lat]);
}

/* ---------- 信息窗 ---------- */
function stopTimeText(f) {
  var s = f.stop;
  if (s.arrive && s.leave) return s.arrive + ' – ' + s.leave;
  if (s.arrive) return s.arrive + ' 到达';
  if (s.leave) return s.leave + ' 离开';
  return '时间未标注';
}
function openInfoWindow(id) {
  var f = findStopById(activeTripData(), id);
  if (!f || !state.mapReady || f.stop.lng == null || f.stop.lat == null) return;
  var s = f.stop;
  var t = C.STOP_TYPES[s.type];
  var html = '<div class="amap-info-content">' +
    '<div class="iw-title"><span style="color:' + t.color + '">' + esc(t.char) + ' ' + esc(t.label) + '</span> ' + esc(s.name) + '</div>' +
    '<div class="iw-row">📅 <b>行程</b>第' + f.day + '天 · 第' + (f.index + 1) + '站</div>' +
    '<div class="iw-row">🕐 <b>时间</b>' + esc(stopTimeText(f)) + '</div>' +
    '<div class="iw-row">🚕 <b>前往下一站</b>' + esc(C.TRANSIT_LABELS[s.transit]) + '</div>' +
    (s.note ? '<div class="iw-note">📝 ' + esc(s.note) + '</div>' : '') +
    '<div class="iw-actions">' +
    '<button class="btn small" id="iw-edit">✏️ 编辑</button>' +
    '<button class="btn small" id="iw-amap">🗺️ 高德查看</button>' +
    '</div></div>';
  state.infoWindow.setContent(html);
  state.infoWindow.open(state.map, new AMap.LngLat(s.lng, s.lat));
  setTimeout(function () {
    var b1 = document.getElementById('iw-edit');
    var b2 = document.getElementById('iw-amap');
    if (b1) b1.addEventListener('click', function () { openStopEditor(id); });
    if (b2) b2.addEventListener('click', function () {
      window.open('https://uri.amap.com/marker?position=' + s.lng + ',' + s.lat + '&name=' + encodeURIComponent(s.name) + '&callnative=0', '_blank');
    });
  }, 30);
}

/* ---------- 选点模式 ---------- */
function startPickMode() {
  state.pickTarget = { active: true };
  $('#pickHint').classList.remove('hidden');
}
function stopPickMode() {
  state.pickTarget = null;
  var h = $('#pickHint');
  if (h) h.classList.add('hidden');
  setStatus('editStatus', '', '');
}
function onMapPick(lnglat) {
  var lng = +lnglat.lng.toFixed(6), lat = +lnglat.lat.toFixed(6);
  var coordInput = $('#editCoord');
  if (coordInput) {
    coordInput.value = lng + ', ' + lat;
    coordInput.dataset.lng = lng;
    coordInput.dataset.lat = lat;
  }
  toast('已选择位置：' + lng + ', ' + lat, 'ok');
}

function drawTrip() {
  if (!state.mapReady || !state.map) return;
  clearOverlays();
  var trip = activeTripData();
  if (!trip) { renderLegend({ days: [] }); return; }
  var firstErr = null;
  var stages = [
    function () { drawMarkers(trip, null); },
    function () { drawSegments(trip); }
  ];
  stages.forEach(function (fn) {
    try { fn(); } catch (e) {
      if (!firstErr) firstErr = e;
      console.error('[drawTrip] 阶段绘制失败', e);
    }
  });
  try { renderLegend(trip); } catch (e) { console.error('[drawTrip] 图例失败', e); }
  try { renderViewChips(trip); } catch (e) { console.error('[drawTrip] 视图切换失败', e); }
  try { applyCurrentView(); } catch (e) {
    console.error('[drawTrip] 视野调整失败', e);
    if (!firstErr) firstErr = e;
  }
  if (firstErr) toast('部分地图元素未能显示：' + errText(firstErr, '未知错误'), 'err');
}
/* ================= 侧栏 ================= */
function renderTripHead() {
  var trip = activeTripData();
  if (!trip) { $('#tripName').textContent = '未命名路书'; $('#tripMeta').textContent = ''; return; }
  $('#tripName').textContent = trip.name;
  var flat = C.flattenStops(trip);
  var loc = countLocated(trip);
  $('#tripMeta').textContent = trip.days.length + ' 天 · ' + flat.length + ' 个地点 · 已定位 ' + loc.ok + '/' + loc.total;
  var warns = C.tripWarnings(trip).filter(function (w) { return w.kind === 'nopos'; });
  var warnEl = $('#tripWarn');
  if (warns.length) {
    warnEl.innerHTML = '⚠️ 有 <b>' + warns.length + '</b> 个地点未能自动定位（红色标注），点击地点 → 编辑 → 地图选点 / POI 搜索修正，或修改名称后重试。 <button id="btnRetryGeocode" class="btn small" style="margin-left:4px">重试定位</button>';
    warnEl.classList.remove('hidden');
    var retryBtn = $('#btnRetryGeocode');
    if (retryBtn) retryBtn.addEventListener('click', function () {
      state.geocodeFailed = {};
      toast('正在重新定位未定位地点…', 'ok');
      renderAll();
    });
  } else {
    warnEl.classList.add('hidden');
  }
}

function renderSidebar() {
  renderTripHead();
  renderTripSelector();
  var trip = activeTripData();
  var tl = $('#timeline');
  if (!trip) { tl.innerHTML = '<div class="empty-tip">还没有路书<br>点击「识别路书」或「生成路书」开始</div>'; return; }
  var html = '';
  trip.days.forEach(function (d, di) {
    var color = C.dayColor(d.day);
    html += '<div class="day-block">' +
      '<div class="day-head" data-day="' + d.day + '"><span class="day-dot" style="background:' + color + '"></span>第 ' + d.day + ' 天' +
      '<span class="day-count">' + d.stops.length + ' 站 · 点击聚焦</span></div>' +
      '<div class="day-stops">';
    d.stops.forEach(function (s, si) {
      var t = C.STOP_TYPES[s.type];
      var unlocated = s.lng == null || s.lat == null;
      var sub = stopTimeText({ stop: s });
      html += '<div class="stop-item' + (unlocated ? ' unlocated' : '') + (state.selectedStopId === s.id ? ' selected' : '') + '" data-id="' + esc(s.id) + '" style="border-left-color:' + t.color + '">' +
        '<div class="stop-badge" style="background:' + t.color + '">' + esc(t.char) + '</div>' +
        '<div class="stop-main"><div class="stop-name">' + esc(s.name) + '</div><div class="stop-sub">🕐 ' + esc(sub) + '</div></div>' +
        (unlocated ? '<span class="stop-warn" title="未定位">⚠️</span>' : '') +
        '<span class="stop-transit" title="前往下一站交通">' + (C.TRANSIT_ICONS[s.transit] || '') + '</span>' +
        '<div class="stop-ops">' +
        '<button class="op-up" title="上移" data-act="up">↑</button>' +
        '<button class="op-down" title="下移" data-act="down">↓</button>' +
        '<button class="op-edit" title="编辑" data-act="edit">✏️</button>' +
        '<button class="op-del" title="删除" data-act="del">🗑</button>' +
        '</div></div>';
    });
    html += '<div class="add-day-row"><button class="btn small" data-add-day="' + d.day + '">＋ 在本天添加地点</button></div>';
    html += '</div></div>';
  });
  tl.innerHTML = html;

  // 事件绑定
  $$('#timeline .stop-item').forEach(function (item) {
    item.addEventListener('click', function (e) {
      if (e.target.closest('.stop-ops')) return;
      selectStop(item.dataset.id, true);
    });
  });
  $$('#timeline .stop-ops button').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var id = btn.closest('.stop-item').dataset.id;
      var act = btn.dataset.act;
      if (act === 'edit') openStopEditor(id);
      else if (act === 'del') deleteStop(id);
      else if (act === 'up' || act === 'down') moveStop(id, act === 'up' ? -1 : 1);
    });
  });
  $$('#timeline .day-head').forEach(function (head) {
    head.addEventListener('click', function () { fitDay(+head.dataset.day); });
  });
  $$('#timeline [data-add-day]').forEach(function (btn) {
    btn.addEventListener('click', function () { openStopEditor(null, +btn.dataset.addDay); });
  });
}

function renderTripSelector() {
  var sel = $('#tripSelector');
  sel.innerHTML = '';
  state.trips.forEach(function (t) {
    var opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.trip.name + '（' + t.trip.days.length + '天）';
    if (t.id === state.activeId) opt.selected = true;
    sel.appendChild(opt);
  });
}
function selectTrip(id) {
  state.activeId = id;
  saveTripsNow();
  state.selectedStopId = null;
  renderAll();
}
function selectStop(id, openInfo) {
  state.selectedStopId = id;
  renderSidebar();
  if (openInfo) openInfoWindow(id);
  else focusStop(id);
}

function moveStop(id, delta) {
  var trip = activeTripData();
  if (!trip) return;
  var flat = C.flattenStops(trip);
  var idx = -1;
  flat.forEach(function (f, i) { if (f.stop.id === id) idx = i; });
  if (idx < 0) return;
  var target = idx + delta;
  if (target < 0 || target >= flat.length) return;
  var from = flat[idx], to = flat[target];
  var dayFrom = trip.days[from.dayIndex], dayTo = trip.days[to.dayIndex];
  var a = dayFrom.stops.splice(from.index, 1)[0];
  dayTo.stops.splice(to.index, 0, a);
  if (from.dayIndex !== to.dayIndex) {
    // 跨天移动后清理空天
    trip.days = trip.days.filter(function (d) { return d.stops.length > 0; });
  }
  trip.days.forEach(function (d, i) { d.day = i + 1; });
  saveTripsDebounced();
  renderAll();
}
function deleteStop(id) {
  if (!confirm('确定删除这个地点吗？')) return;
  var trip = activeTripData();
  if (!trip) return;
  removeStopById(trip, id);
  saveTripsDebounced();
  renderAll();
}

/* ================= 地点编辑器 ================= */
function openStopEditor(stopId, presetDay) {
  var trip = activeTripData();
  if (!trip) return;
  state.editingStopId = stopId || null;
  state.poiMode = 'pick';
  var f = stopId ? findStopById(trip, stopId) : null;
  var s = f ? f.stop : null;
  $('#editDay').value = f ? f.day : (presetDay || 1);
  $('#editType').value = s ? s.type : 'attraction';
  $('#editName').value = s ? s.name : '';
  $('#editArrive').value = s && s.arrive ? s.arrive : '';
  $('#editLeave').value = s && s.leave ? s.leave : '';
  $('#editTransit').value = s ? s.transit : 'drive';
  $('#editNote').value = s ? s.note : '';
  var coordInput = $('#editCoord');
  if (s && s.lng != null && s.lat != null) {
    coordInput.value = s.lng + ', ' + s.lat;
    coordInput.dataset.lng = s.lng;
    coordInput.dataset.lat = s.lat;
  } else {
    coordInput.value = '未定位，请选点或搜索';
    delete coordInput.dataset.lng;
    delete coordInput.dataset.lat;
  }
  $('#btnDeleteStop').classList.toggle('hidden', !stopId);
  setStatus('editStatus', stopId ? '' : '新增地点：可先在地图选点或 POI 搜索定位', 'info');
  stopPickMode();
  openModal('modalEdit');
}

function saveStop() {
  var trip = activeTripData();
  if (!trip) return;
  var name = $('#editName').value.trim();
  if (!name) { setStatus('editStatus', '请填写地点名称', 'err'); return; }
  var day = Math.max(1, Math.min(30, parseInt($('#editDay').value, 10) || 1));
  var coordInput = $('#editCoord');
  var lng = coordInput.dataset.lng != null ? +coordInput.dataset.lng : null;
  var lat = coordInput.dataset.lat != null ? +coordInput.dataset.lat : null;
  if (state.editingStopId) {
    var f = findStopById(trip, state.editingStopId);
    if (f) {
      Object.assign(f.stop, {
        name: name, type: $('#editType').value, arrive: $('#editArrive').value || null,
        leave: $('#editLeave').value || null, transit: $('#editTransit').value, note: $('#editNote').value.trim()
      });
      if (lng != null && lat != null) { f.stop.lng = lng; f.stop.lat = lat; }
      delete state.geocodeFailed[f.stop.id];
      if (f.day !== day) {
        removeStopById(trip, f.stop.id);
        addStopToDay(trip, f.stop, day);
      }
    }
  } else {
    addStopToDay(trip, {
      id: C.uid(),
      type: $('#editType').value,
      name: name,
      lng: lng, lat: lat,
      arrive: $('#editArrive').value || null,
      leave: $('#editLeave').value || null,
      transit: $('#editTransit').value,
      note: $('#editNote').value.trim()
    }, day);
  }
  stopPickMode();
  closeModal('modalEdit');
  saveTripsDebounced();
  renderAll();
}
function addStopToDay(trip, stop, day) {
  var target = trip.days.filter(function (d) { return d.day === day; })[0];
  if (!target) { target = { day: day, stops: [] }; trip.days.push(target); trip.days.sort(function (a, b) { return a.day - b.day; }); }
  target.stops.push(stop);
}

/* ================= POI 搜索 ================= */
function openPoiModal(mode, presetDay) {
  state.poiMode = mode || 'add';
  $('#poiQuery').value = '';
  $('#poiDay').value = presetDay || 1;
  $('#poiType').value = 'attraction';
  $('#poiResults').innerHTML = '';
  setStatus('poiStatus', state.mapReady ? '输入关键词后点击搜索' : '需要先配置高德 Key 才能搜索', state.mapReady ? 'info' : 'err');
  openModal('modalPoi');
}
function doPoiSearch() {
  if (!state.mapReady) { setStatus('poiStatus', '地图未就绪，请先在设置中配置高德 Key', 'err'); return; }
  var q = $('#poiQuery').value.trim();
  if (!q) { setStatus('poiStatus', '请输入搜索关键词', 'err'); return; }
  setStatus('poiStatus', '正在搜索…', 'info');
  var city = activeTripData() && activeTripData().city ? activeTripData().city : '';
  var ps = new AMap.PlaceSearch({ city: city || undefined, pageSize: 20, pageIndex: 1 });
  ps.search(q, function (status, result) {
    if (status === 'complete' && result.poiList && result.poiList.pois) {
      var pois = result.poiList.pois;
      var html = '';
      pois.forEach(function (p, i) {
        var lnglat = p.location;
        html += '<div class="poi-item" data-i="' + i + '">' +
          '<div class="stop-badge" style="background:#3498db">' + esc(C.STOP_TYPES[$('#poiType').value].char) + '</div>' +
          '<div class="poi-main"><div class="poi-name">' + esc(p.name) + '</div>' +
          '<div class="poi-addr">' + esc(p.pname || '') + esc(p.cityname || '') + esc(p.adname || '') + ' ' + esc(p.address || '') + '</div></div>' +
          '<button class="btn small primary" data-act="add">' + (state.poiMode === 'pick' ? '选为坐标' : '添加') + '</button>' +
          '</div>';
      });
      $('#poiResults').innerHTML = html || '<div class="hint-text">未找到相关地点，试试更简短的名称</div>';
      setStatus('poiStatus', '找到 ' + pois.length + ' 个结果', 'ok');
      // 保存结果数据供点击使用
      window._poiCache = pois;
      $$('#poiResults .poi-item').forEach(function (item) {
        item.addEventListener('click', function () {
          var p = window._poiCache[+item.dataset.i];
          if (!p) return;
          usePoiResult(p);
        });
      });
    } else {
      $('#poiResults').innerHTML = '<div class="hint-text">搜索失败，请稍后重试</div>';
      setStatus('poiStatus', '搜索失败', 'err');
    }
  });
}
function usePoiResult(p) {
  var lng = +p.location.lng, lat = +p.location.lat;
  if (state.poiMode === 'pick') {
    var coordInput = $('#editCoord');
    coordInput.value = lng + ', ' + lat;
    coordInput.dataset.lng = lng;
    coordInput.dataset.lat = lat;
    $('#editName').value = $('#editName').value.trim() || p.name;
    closeModal('modalPoi');
    toast('已选择：' + p.name, 'ok');
  } else {
    var trip = activeTripData();
    if (!trip) return;
    var day = Math.max(1, parseInt($('#poiDay').value, 10) || 1);
    addStopToDay(trip, {
      id: C.uid(),
      type: $('#poiType').value,
      name: p.name,
      lng: lng, lat: lat,
      arrive: null, leave: null,
      transit: 'drive',
      note: (p.adname || '') + (p.address ? ' ' + p.address : '')
    }, day);
    closeModal('modalPoi');
    saveTripsDebounced();
    toast('已添加：' + p.name, 'ok');
    renderAll();
  }
}
/* ================= 弹窗通用 ================= */
function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }
function bindModalClose() {
  $$('.modal-close, [data-close]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var id = btn.dataset.close || btn.closest('.modal-mask').id;
      if (id === 'modalEdit') stopPickMode();
      closeModal(id);
    });
  });
  $$('.modal-mask').forEach(function (mask) {
    mask.addEventListener('mousedown', function (e) {
      if (e.target === mask) {
        if (mask.id === 'modalEdit') stopPickMode();
        closeModal(mask.id);
      }
    });
  });
}

/* ================= 导入导出 ================= */
function exportJSON() {
  var trip = activeTripData();
  if (!trip) { toast('当前没有路书', 'err'); return; }
  var data = C.tripToExport(trip);
  var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  downloadBlob(blob, (data.name || '路书').replace(/[\\/:*?"<>|]/g, '_') + '.roadbook.json');
  toast('已导出路书 JSON', 'ok');
}
function importJSON(file) {
  var reader = new FileReader();
  reader.onload = function () {
    try {
      var raw = JSON.parse(String(reader.result));
      var trip = C.normalizeTrip(raw);
      if (!trip.days.length || !C.flattenStops(trip).length) throw new Error('JSON 中没有行程数据');
      addTrip(trip, true);
      toast('导入成功：' + trip.name, 'ok');
      renderAll();
    } catch (e) {
      toast('导入失败：' + e.message, 'err');
    }
  };
  reader.readAsText(file);
}

/* ================= 长图导出 ================= */
function buildExportContent() {
  var trip = activeTripData();
  if (!trip) return;
  $('#exportTitle').textContent = trip.name;
  var html = '';
  trip.days.forEach(function (d) {
    var color = C.dayColor(d.day);
    html += '<div class="et-day"><div class="et-day-head"><span class="legend-swatch" style="background:' + color + '"></span> 第 ' + d.day + ' 天</div>';
    d.stops.forEach(function (s) {
      var t = C.STOP_TYPES[s.type];
      html += '<div class="et-row">' +
        '<span class="et-badge" style="background:' + t.color + '">' + esc(t.char) + '</span>' +
        '<span class="et-time">' + esc(s.arrive || '') + (s.leave ? ' – ' + esc(s.leave) : '') + '</span>' +
        '<span class="et-name">' + esc(s.name) + '</span>' +
        (s.note ? '<span class="et-note">（' + esc(s.note) + '）</span>' : '') +
        '</div>';
    });
    html += '</div>';
  });
  $('#exportTimeline').innerHTML = html;
}

async function captureSection(el, opts) {
  return await html2canvas(el, Object.assign({
    useCORS: true,
    allowTaint: false,
    scale: 2,
    backgroundColor: '#ffffff',
    logging: false
  }, opts || {}));
}

async function exportLongImage() {
  var trip = activeTripData();
  if (!trip) { toast('当前没有路书', 'err'); return; }
  if (!state.mapReady) { toast('请先配置高德 Key 后再导出地图长图', 'err'); return; }
  var btn = $('#btnLongImage');
  btn.disabled = true;
  toast('正在生成长图，请稍候…');
  try {
    buildExportContent();
    document.body.classList.add('exporting');
    fitAll();
    await wait(1200); // 等待地图瓦片与真实路线加载
    var mapCanvas = await captureSection($('#mapWrap'));
    var titleCanvas = await captureSection($('#exportTitle'));
    var tlCanvas = await captureSection($('#exportTimeline'));
    var gap = 8;
    var width = Math.max(mapCanvas.width, titleCanvas.width, tlCanvas.width);
    var height = titleCanvas.height + gap + mapCanvas.height + gap + tlCanvas.height;
    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(titleCanvas, (width - titleCanvas.width) / 2, 0);
    ctx.drawImage(mapCanvas, (width - mapCanvas.width) / 2, titleCanvas.height + gap);
    ctx.drawImage(tlCanvas, 20, titleCanvas.height + gap + mapCanvas.height + gap);
    var blob = await new Promise(function (resolve) {
      canvas.toBlob(function (b) { resolve(b); }, 'image/png');
    });
    downloadBlob(blob, (trip.name || '路书').replace(/[\\/:*?"<>|]/g, '_') + '_地图长图.png');
    toast('长图已生成', 'ok');
  } catch (e) {
    var msg = String(e && e.message || e);
    if (/tainted|security|SecurityError/i.test(msg)) {
      toast('地图底图受跨域限制，已生成文字版长图（地图区域为空）', 'err');
      try {
        var t1 = await captureSection($('#exportTitle'));
        var t2 = await captureSection($('#exportTimeline'));
        var c2 = document.createElement('canvas');
        c2.width = Math.max(t1.width, t2.width);
        c2.height = t1.height + t2.height + 8;
        var cx = c2.getContext('2d');
        cx.fillStyle = '#fff';
        cx.fillRect(0, 0, c2.width, c2.height);
        cx.drawImage(t1, (c2.width - t1.width) / 2, 0);
        cx.drawImage(t2, 20, t1.height + 8);
        var b2 = await new Promise(function (r) { c2.toBlob(r, 'image/png'); });
        downloadBlob(b2, '路书文字版.png');
      } catch (e2) {
        toast('长图导出失败：' + (e2 && e2.message || e2), 'err');
      }
    } else {
      toast('长图导出失败：' + msg, 'err');
    }
  } finally {
    document.body.classList.remove('exporting');
    btn.disabled = false;
    renderAll();
  }
}

/* ================= 示例路书 ================= */
var DEMO_TEXT = [
  '川西小环线3日自驾',
  '第1天',
  '08:00 成都出发',
  '11:00 途经泸定桥',
  '13:00 午餐(泸定县城)',
  '15:30 游览海螺沟冰川森林公园',
  '19:00 入住磨西古镇',
  '第2天',
  '08:30 磨西古镇出发',
  '10:00 途经红石滩',
  '12:30 午餐(康定)',
  '14:00 游览木格措景区',
  '18:00 入住康定情歌大酒店',
  '第3天',
  '09:00 康定出发',
  '10:30 途经折多山观景台',
  '12:00 午餐(新都桥)',
  '14:00 游览塔公草原',
  '17:00 返程回成都'
].join('\n');

function loadDemo() {
  var trip = C.normalizeTrip(C.parseRoadbookText(DEMO_TEXT));
  trip.city = '甘孜';
  addTrip(trip, true);
  toast('已载入示例路书，正在定位…', 'ok');
  renderAll();
}

/* ================= 设置弹窗 ================= */
function openSettingsModal() {
  var s = state.settings;
  $('#setProvider').value = PROVIDER_PRESETS[s.provider] ? s.provider : 'custom';
  $('#setBaseUrl').value = s.baseUrl;
  $('#setModel').value = s.model;
  $('#setApiKey').value = s.apiKey;
  $('#setAmapKey').value = s.amapKey;
  $('#setAmapCode').value = s.amapSecurityJsCode;
  openModal('modalSettings');
}
function saveSettingsFromModal() {
  var s = state.settings;
  var provider = $('#setProvider').value;
  s.provider = provider;
  s.baseUrl = $('#setBaseUrl').value.trim();
  s.model = $('#setModel').value.trim();
  s.apiKey = $('#setApiKey').value.trim();
  s.amapKey = $('#setAmapKey').value.trim();
  s.amapSecurityJsCode = $('#setAmapCode').value.trim();
  saveSettings(s);
  closeModal('modalSettings');
  toast('设置已保存' + (s.amapKey ? '，正在加载地图…' : ''), 'ok');
  // Key 变化后重载地图
  state.map = null;
  state.mapReady = false;
  state.routeCache = {};
  state.amapLoadAttempt = null;
  state.amapFailSig = null;
  state.amapFailError = null;
  state.geocodeFailed = {};
  renderAll();
}

/* ================= renderAll ================= */
function errText(e, fallback) {
  if (!e) return fallback || '';
  if (typeof e === 'string') return e || (fallback || '');
  if (e.message) return e.message;
  if (e.info) return String(e.info);
  if (e.code) return String(e.code);
  return fallback || '';
}

async function renderAll() {
  renderSidebar();
  if (!hasAmapKey()) {
    state.map = null;
    state.mapReady = false;
    showMapHint(null, '未配置高德地图 Key');
    $('#legend').classList.add('hidden');
    $('#viewChips').innerHTML = '';
    return;
  }
  try {
    if (!state.map) {
      $('#geoProgressText').textContent = '正在加载高德地图…';
      $('#geoProgress').classList.remove('hidden');
      state.map = await initMap();
      state.mapReady = true;
      hideMapHint();
      $('#geoProgress').classList.add('hidden');
    }
  } catch (e) {
    state.map = null;
    state.mapReady = false;
    showMapHint(errText(e, '地图加载失败'), hasAmapKey() ? '高德地图加载失败' : '未配置高德地图 Key');
    $('#geoProgress').classList.add('hidden');
    return;
  }
  try {
    await geocodeMissing();
    drawTrip();
  } catch (e) {
    console.error('[renderAll] 定位/绘制失败', e);
    toast('地图绘制出错：' + errText(e, '未知错误'), 'err');
    $('#geoProgress').classList.add('hidden');
  }
}

/* ================= 事件绑定与初始化 ================= */
function bindEvents() {
  $('#btnParse').addEventListener('click', openParseModal);
  $('#btnGenerate').addEventListener('click', openGenerateModal);
  $('#btnSettings').addEventListener('click', openSettingsModal);
  $('#btnSaveSettings').addEventListener('click', saveSettingsFromModal);
  $('#btnHintSettings').addEventListener('click', openSettingsModal);
  $('#btnDoParse').addEventListener('click', doParse);
  $('#btnDoGenerate').addEventListener('click', doGenerate);
  $('#btnPickFile').addEventListener('click', function () {
    $('#fileInput').accept = '.txt,.md,.docx,.pdf';
    $('#fileInput').dataset.mode = 'parse';
    $('#fileInput').click();
  });
  $('#btnNew').addEventListener('click', function () {
    addTrip({ name: '我的路书', days: [{ day: 1, stops: [] }] }, true);
    renderAll();
    toast('已新建路书，点击「＋ 添加地点」开始规划', 'ok');
  });
  $('#btnRename').addEventListener('click', function () {
    var trip = activeTripData();
    if (!trip) return;
    var name = prompt('路书名称：', trip.name);
    if (name && name.trim()) { trip.name = name.trim(); saveTripsDebounced(); renderAll(); }
  });
  $('#btnDeleteTrip').addEventListener('click', function () {
    if (state.trips.length <= 1) { toast('至少保留一个路书（可以先新建再删除）', 'err'); return; }
    if (!confirm('确定删除当前路书「' + (activeTripData().name || '') + '」吗？')) return;
    deleteTrip(state.activeId);
    renderAll();
  });
  $('#tripSelector').addEventListener('change', function () { selectTrip(this.value); });
  $('#btnExport').addEventListener('click', exportJSON);
  $('#btnImport').addEventListener('click', function () {
    $('#fileInput').accept = '.json,application/json';
    $('#fileInput').dataset.mode = 'import';
    $('#fileInput').click();
  });
  $('#btnLongImage').addEventListener('click', exportLongImage);
  $('#btnDemo').addEventListener('click', loadDemo);
  $('#btnAddStop').addEventListener('click', function () { openStopEditor(null, null); });
  $('#btnFitAll').addEventListener('click', fitAll);
  $('#btnSaveStop').addEventListener('click', saveStop);
  $('#btnDeleteStop').addEventListener('click', function () {
    if (state.editingStopId) {
      closeModal('modalEdit');
      deleteStop(state.editingStopId);
    }
  });
  $('#btnPickCoord').addEventListener('click', function () {
    if (!state.mapReady) { toast('请先配置高德 Key', 'err'); return; }
    startPickMode();
    setStatus('editStatus', '请在地图上点击目标位置（点提示条可取消）', 'info');
  });
  $('#btnPoiPick').addEventListener('click', function () { openPoiModal('pick', +$('#editDay').value || 1); });
  $('#btnPoiSearch').addEventListener('click', doPoiSearch);
  $('#poiQuery').addEventListener('keydown', function (e) { if (e.key === 'Enter') doPoiSearch(); });

  $('#fileInput').addEventListener('change', function () {
    var file = this.files && this.files[0];
    this.value = '';
    if (!file) return;
    if (this.dataset.mode === 'import') importJSON(file);
    else handleParseFile(file);
  });

  // 拖拽文件到解析弹窗
  var dz = $('#dropZone');
  dz.addEventListener('dragover', function (e) { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', function () { dz.classList.remove('dragover'); });
  dz.addEventListener('drop', function (e) {
    e.preventDefault();
    dz.classList.remove('dragover');
    var file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleParseFile(file);
  });

  $('#setProvider').addEventListener('change', function () {
    var p = PROVIDER_PRESETS[this.value];
    if (p && p.baseUrl) $('#setBaseUrl').value = p.baseUrl;
    if (p && p.model) $('#setModel').value = p.model;
  });

  // 生成弹窗快捷键
  $('#genDest').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('#btnDoGenerate').click(); });
}

function init() {
  loadTrips();
  if (!state.trips.length) {
    state.trips.push({ id: C.uid('trip'), trip: C.normalizeTrip({ name: '我的路书', days: [{ day: 1, stops: [] }] }) });
    state.activeId = state.trips[0].id;
    saveTripsNow();
  }
  bindEvents();
  bindModalClose();
  renderAll();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
})();
