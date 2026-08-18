/* roadbook-core.js — 路书核心逻辑（浏览器 + Node 通用）
 * 全局名: RoadbookCore ；CommonJS: module.exports
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RoadbookCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = 1;

  var STOP_TYPES = {
    start: { key: 'start', label: '起点', char: '起', color: '#27ae60' },
    attraction: { key: 'attraction', label: '景点', char: '景', color: '#e67e22' },
    waypoint: { key: 'waypoint', label: '途经点', char: '途', color: '#3498db' },
    hotel: { key: 'hotel', label: '酒店', char: '宿', color: '#e74c3c' },
    food: { key: 'food', label: '餐饮', char: '餐', color: '#f39c12' },
    end: { key: 'end', label: '终点', char: '终', color: '#2c3e50' }
  };
  var TYPE_KEYS = Object.keys(STOP_TYPES);

  var TRANSIT_LABELS = { drive: '驾车', walk: '步行', transit: '公交' };
  var TRANSIT_ICONS = { drive: '🚗', walk: '🚶', transit: '🚌' };

  var DAY_COLORS = ['#2f7de1', '#2ca02c', '#e67e22', '#9b59b6', '#e74c3c', '#16a085', '#d35400', '#34495e'];
  function dayColor(dayNo) { return DAY_COLORS[(Math.max(1, dayNo) - 1) % DAY_COLORS.length]; }

  var uidCounter = 0;
  function uid(prefix) {
    uidCounter += 1;
    return (prefix || 's') + '_' + Date.now().toString(36) + uidCounter.toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /* ---------- 时间工具 ---------- */
  function timeToMinutes(t) {
    if (t == null) return null;
    if (typeof t === 'number') return t;
    var m = String(t).trim().match(/^(\d{1,2})(?:[:：点时](\d{1,2}))?$/);
    if (!m) return null;
    var h = parseInt(m[1], 10);
    var min = m[2] ? parseInt(m[2], 10) : 0;
    if (h < 0 || h > 23 || min < 0 || min > 59) return null;
    return h * 60 + min;
  }
  function minutesToTime(min) {
    if (min == null || !isFinite(min)) return null;
    min = Math.round(min) % (24 * 60);
    var h = Math.floor(min / 60), m = min % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  }
  function formatDuration(min) {
    if (min == null || !isFinite(min)) return '—';
    min = Math.round(min);
    if (min < 60) return min + '分钟';
    var h = Math.floor(min / 60), m = min % 60;
    return m ? h + '小时' + m + '分' : h + '小时';
  }
  function chineseNumToInt(s) {
    var map = { '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    var total = 0, cur = 0, num = 0;
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (ch === '十') { num = num || 1; cur += num * 10; num = 0; }
      else if (map[ch] != null) { num = map[ch]; }
      else return null;
    }
    total = cur + num;
    return total || null;
  }

  /* ---------- 规则解析器 ---------- */
  var TIME_RE = /((?:[01]?\d|2[0-3])[:：点](?:[0-5]\d)?)/g;
  var DAY_RE = /^(第\s*([0-9一二三四五六七八九十]+)\s*[天日]|d(?:ay)?\s*([0-9]+)|d([0-9]+))/i;
  var ARROW_RE = /[→➔➡⟶—–>]+/;

  function classifyLine(line) {
    var t = line;
    if (/(结束|返程|回家|终点|行程结束|返家|回程|返回)/.test(t)) return 'end';
    if (/(入住|住宿|酒店|宾馆|民宿|客栈|青旅|旅店|下榻)/.test(t)) return 'hotel';
    if (/(出发|启程|起点|集合)/.test(t)) return 'start';
    if (/(途经|路过|经过|经停|服务区|休息站|观景台|垭口|停车)/.test(t)) return 'waypoint';
    if (/(午餐|晚餐|早餐|早饭|午饭|晚饭|用餐|餐厅|美食|小吃|吃饭|夜宵|大餐)/.test(t)) return 'food';
    return 'attraction';
  }

  var PREFIX_VERBS_RE = /^(抵达|到达|前往|去往|去|游览|参观|游玩|玩|入住|住宿|住|途经|路过|经过|经停|出发|集合于|集合|返程|返回|回|结束于|结束|午餐于|午餐|晚餐|早餐|早饭|午饭|晚饭|用餐|就餐|在|前往|去到)/;
  var TRAIL_RE = /(游览|参观|游玩|拍照|打卡|休息|用餐|午餐|晚餐|早餐|住宿|入住|出发|返程|返回|结束|集合|出发地|下车|午餐后|晚餐后)+$/;

  function extractNameAndNote(line) {
    var cleaned = String(line).trim()
      .replace(TIME_RE, ' ')
      .replace(/^\s*(?:[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮\d]+(?:[.、．:：\-–—]\s*|\s+)|[•·*\-–—]+\s*|【[^】]*】)\s*/, '')
      .trim();
    var note = '';
    var pm = cleaned.match(/[（(]([^（()）]*)[)）]/);
    if (pm) { note = pm[1].trim(); cleaned = cleaned.replace(pm[0], ' ').trim(); }
    cleaned = cleaned.replace(PREFIX_VERBS_RE, '').trim();
    cleaned = cleaned.replace(TRAIL_RE, ' ').trim();
    cleaned = cleaned.replace(/^[\s,，、;；:：.。-]+/, '').replace(/[\s,，、;；:：.。-]+$/, '');
    if (!cleaned) {
      cleaned = String(line).replace(TIME_RE, ' ').replace(/[^\u4e00-\u9fa5A-Za-z0-9·・ ]/g, ' ').trim();
    }
    if (cleaned.length > 24) cleaned = cleaned.slice(0, 24);
    return { name: cleaned.trim(), note: note };
  }

  function timesFromLine(line) {
    var found = [];
    var m, re = new RegExp(TIME_RE.source, 'g');
    while ((m = re.exec(line)) !== null) {
      var mm = timeToMinutes(m[1].replace(/[点时]/, ':'));
      if (mm != null) found.push(mm);
    }
    return found;
  }

  function stopFromLine(line, defaultType) {
    var times = timesFromLine(line);
    var en = extractNameAndNote(line);
    if (!en.name) return null;
    var stop = {
      type: classifyLine(line) !== 'attraction' ? classifyLine(line) : (defaultType || 'attraction'),
      name: en.name,
      arrive: times.length ? minutesToTime(times[0]) : null,
      leave: times.length > 1 ? minutesToTime(times[1]) : null,
      note: en.note || '',
      transit: 'drive'
    };
    // 停留时长描述，如 "停留2小时"
    var sm = line.match(/停留\s*(\d+(?:\.\d+)?)\s*(小时|分钟|h|min)/i);
    if (sm && stop.arrive && !stop.leave) {
      var mins = parseFloat(sm[1]) * (/(小时|h)/i.test(sm[2]) ? 60 : 1);
      stop.leave = minutesToTime(timeToMinutes(stop.arrive) + mins);
    }
    return stop;
  }

  function splitArrowLine(line) {
    var parts = line.split(ARROW_RE).map(function (s) { return s.trim(); }).filter(Boolean);
    return parts.length > 1 ? parts : null;
  }

  function parseRoadbookText(text) {
    if (!text || !String(text).trim()) return { name: '未命名路书', days: [] };
    var rawLines = String(text).replace(/\r\n?/g, '\n').split('\n').map(function (s) { return s.trim(); }).filter(Boolean);

    var title = '我的路书';
    var sections = []; // {dayNo, lines}
    var current = null;
    var started = false;

    for (var i = 0; i < rawLines.length; i++) {
      var line = rawLines[i];
      var dm = line.match(DAY_RE);
      if (dm) {
        started = true;
        var dayNo = 0;
        if (dm[2] != null) dayNo = chineseNumToInt(dm[2]) || 1;
        else if (dm[3] != null) dayNo = parseInt(dm[3], 10) || 1;
        else if (dm[4] != null) dayNo = parseInt(dm[4], 10) || 1;
        current = { dayNo: dayNo, lines: [] };
        sections.push(current);
      } else if (current) {
        current.lines.push(line);
      } else if (!started) {
        // 标题候选：不含时间、较短的第一行
        if (!title || title === '我的路书') {
          if (!TIME_RE.test(line) && line.length <= 30 && !ARROW_RE.test(line)) title = line.replace(/[:：#]\s*$/, '').trim();
        }
      }
    }
    TIME_RE.lastIndex = 0;

    if (sections.length === 0) {
      var lines = rawLines;
      var first = lines[0];
      if (first && !TIME_RE.test(first) && first.length <= 30 && !ARROW_RE.test(first)) { title = first.replace(/[:：#]\s*$/, '').trim(); lines = lines.slice(1); }
      sections = [{ dayNo: 1, lines: lines }];
    }

    var days = [];
    sections.forEach(function (sec) {
      var stops = [];
      var timedStops = [];
      sec.lines.forEach(function (line) {
        if (ARROW_RE.test(line)) return;
        var s = stopFromLine(line);
        if (s) { if (s.arrive || s.leave) timedStops.push(s); else stops.push(s); }
      });
      // 有时间线时忽略箭头摘要行；否则用箭头行拆分地点
      if (timedStops.length === 0) {
        sec.lines.forEach(function (line) {
          if (ARROW_RE.test(line)) {
            var parts = splitArrowLine(line);
            if (parts) {
              parts.forEach(function (p) {
                var en = extractNameAndNote(p);
                if (en.name) stops.push({ type: 'attraction', name: en.name, arrive: null, leave: null, note: en.note, transit: 'drive' });
              });
            }
          }
        });
        stops = stops.concat(timedStops);
      } else {
        stops = stops.concat(timedStops);
      }
      // 去重连续同名
      var seen = '';
      var dedup = [];
      stops.forEach(function (s) {
        if (s.name === seen) return;
        seen = s.name;
        dedup.push(s);
      });
      if (dedup.length) days.push({ day: sec.dayNo, stops: dedup });
    });

    if (days.length === 0) days = [{ day: 1, stops: [] }];
    return { name: title, days: days };
  }

  /* ---------- Trip 模型 ---------- */
  function normalizeStop(raw, idx) {
    var s = raw || {};
    var type = TYPE_KEYS.indexOf(s.type) >= 0 ? s.type : 'attraction';
    var name = String(s.name == null ? '' : s.name).trim() || '未命名地点';
    var lng = typeof s.lng === 'number' && isFinite(s.lng) && Math.abs(s.lng) <= 180 ? s.lng : (s.lng == null ? null : Number(s.lng));
    var lat = typeof s.lat === 'number' && isFinite(s.lat) && Math.abs(s.lat) <= 90 ? s.lat : (s.lat == null ? null : Number(s.lat));
    if (lng != null && !(Math.abs(lng) <= 180)) lng = null;
    if (lat != null && !(Math.abs(lat) <= 90)) lat = null;
    var arrive = timeToMinutes(s.arrive) != null ? minutesToTime(timeToMinutes(s.arrive)) : null;
    var leave = timeToMinutes(s.leave) != null ? minutesToTime(timeToMinutes(s.leave)) : null;
    if (arrive && leave && timeToMinutes(leave) < timeToMinutes(arrive)) leave = null;
    var transit = TRANSIT_LABELS[s.transit] ? s.transit : 'drive';
    return {
      id: typeof s.id === 'string' && s.id ? s.id : uid(),
      type: type,
      name: name,
      lng: lng, lat: lat,
      arrive: arrive, leave: leave,
      note: s.note == null ? '' : String(s.note),
      transit: transit
    };
  }

  function normalizeTrip(raw) {
    var r = raw || {};
    var daysRaw = Array.isArray(r.days) ? r.days : [];
    var days = daysRaw.map(function (d, di) {
      var stopsRaw = Array.isArray(d && d.stops) ? d.stops : [];
      return { day: (typeof d.day === 'number' && d.day >= 1) ? Math.round(d.day) : di + 1, stops: stopsRaw.map(normalizeStop) };
    }).filter(function (d) { return d.stops.length > 0; });
    if (days.length === 0) days = [{ day: 1, stops: [] }];
    // 自动补起/终点类型
    var first = days[0].stops[0];
    var lastDay = days[days.length - 1];
    var last = lastDay.stops[lastDay.stops.length - 1];
    var hasStart = days.some(function (d) { return d.stops.some(function (s) { return s.type === 'start'; }); });
    if (first && !hasStart && first.type !== 'start') first.type = 'start';
    if (last && last.type !== 'end' && last.type !== 'hotel') last.type = 'end';
    // 跨天衔接：每天首站若与前一天末站不同且为酒店/景点，保持原样；这里仅做数据规整
    return {
      version: VERSION,
      name: String(r.name == null || !String(r.name).trim() ? '我的路书' : r.name).trim(),
      city: r.city == null ? '' : String(r.city),
      days: days
    };
  }

  function tripToExport(trip) {
    var t = normalizeTrip(trip);
    return JSON.parse(JSON.stringify(t));
  }

  function flattenStops(trip) {
    var out = [];
    (trip.days || []).forEach(function (d) {
      (d.stops || []).forEach(function (s, si) {
        out.push({ day: d.day, index: si, stop: s, dayIndex: trip.days.indexOf(d) });
      });
    });
    return out;
  }

  function deriveSegments(trip) {
    var flat = flattenStops(trip);
    var segments = [];
    for (var i = 0; i + 1 < flat.length; i++) {
      segments.push({ from: flat[i], to: flat[i + 1], fromId: flat[i].stop.id, toId: flat[i + 1].stop.id, day: flat[i].day, transit: flat[i].stop.transit });
    }
    return segments;
  }

  function tripWarnings(trip) {
    var warns = [];
    flattenStops(trip).forEach(function (f) {
      if (f.stop.lng == null || f.stop.lat == null) warns.push({ kind: 'nopos', id: f.stop.id, day: f.day, name: f.stop.name });
      if (f.stop.arrive == null && f.stop.leave == null) warns.push({ kind: 'notime', id: f.stop.id, day: f.day, name: f.stop.name });
    });
    return warns;
  }

  /* ---------- LLM ---------- */
  var TRIP_SCHEMA_TEXT = [
    '只输出一个 JSON 对象，不要输出任何解释或 Markdown。',
    'JSON 结构（字段名必须完全一致）：',
    '{',
    '  "name": "路书标题字符串",',
    '  "days": [',
    '    {',
    '      "day": 1,',
    '      "stops": [',
    '        {',
    '          "type": "start|attraction|waypoint|hotel|food|end",',
    '          "name": "地点名称（用于地图搜索，请使用规范中文名称，如：峨眉山景区、康定情歌大酒店）",',
    '          "arrive": "HH:MM 或 null",',
    '          "leave": "HH:MM 或 null",',
    '          "note": "备注或 null",',
    '          "transit": "drive|walk|transit"',
    '        }',
    '      ]',
    '    }',
    '  ]',
    '}',
    '规则：',
    '1. type 取值：start=出发地/起点，attraction=景点，waypoint=途经点，hotel=酒店/住宿，food=餐饮，end=终点/返回地。',
    '2. 每天至少一个 stop；arrive/leave 使用 24 小时制 HH:MM，没有时间就填 null。',
    '3. transit 表示前往下一个地点的交通方式，默认 drive。',
    '4. name 只写地点名称，不要包含时间、动词（如"出发""入住"）。'
  ].join('\n');

  function buildParsePrompt(text) {
    return {
      messages: [
        { role: 'system', content: '你是旅行路书解析助手，把用户提供的路书文本转换为结构化行程 JSON。\n' + TRIP_SCHEMA_TEXT },
        { role: 'user', content: '请解析下面的路书文本：\n\n' + String(text) }
      ]
    };
  }

  function buildGeneratePrompt(form) {
    var dest = String(form.destination || '').trim() || '热门旅游城市';
    var daysN = Math.max(1, Math.min(30, parseInt(form.days, 10) || 3));
    var prefs = String(form.preferences || '').trim() || '休闲观光、当地美食';
    var startCity = String(form.startCity || '').trim();
    var userContent = '请为我生成一份' + daysN + '天的旅行路书：\n' +
      '- 目的地：' + dest + '\n' +
      '- 出发地：' + (startCity || dest) + '\n' +
      '- 偏好：' + prefs + '\n' +
      '要求：每天安排合理（景点、午餐、晚餐、每晚酒店），时间紧凑不赶路，地点之间交通时间符合常识。' +
      '\n\n' + TRIP_SCHEMA_TEXT;
    return {
      messages: [
        { role: 'system', content: '你是专业的旅行行程规划师，输出的行程真实可执行，地点名称使用规范中文名称（便于地图定位），每天包含当晚酒店。\n' + TRIP_SCHEMA_TEXT },
        { role: 'user', content: userContent }
      ]
    };
  }

  function parseLLMJsonOutput(content) {
    if (!content) return null;
    var s = String(content).trim();
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    var a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
  }

  async function llmChatJson(opts) {
    var baseUrl = String(opts.baseUrl || '').replace(/\/+$/, '');
    var attempts = Math.max(1, opts.attempts || 2);
    var messages = (opts.messages || []).slice();
    var lastError = null;
    for (var i = 0; i < attempts; i++) {
      try {
        var res = await opts.fetchImpl(baseUrl + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + opts.apiKey },
          body: JSON.stringify({ model: opts.model, messages: messages, response_format: { type: 'json_object' }, temperature: 0.3 })
        });
        if (!res.ok) { lastError = new Error('HTTP ' + res.status); }
        else {
          var data = await res.json();
          var content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
          var obj = parseLLMJsonOutput(content);
          if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
          lastError = new Error('响应不是有效 JSON');
        }
      } catch (e) { lastError = e instanceof Error ? e : new Error(String(e)); }
      messages = messages.concat([
        { role: 'assistant', content: '(上一步输出无效)' },
        { role: 'user', content: '请重新直接输出符合要求的 JSON 对象，不要包含解释或 Markdown 代码块。' }
      ]);
    }
    throw new Error('LLM 调用失败：' + (lastError ? lastError.message : '未知错误'));
  }

  async function extractDocxText(arrayBuffer, JSZipImpl) {
    var zip = await JSZipImpl.loadAsync(arrayBuffer);
    var f = zip.file('word/document.xml');
    if (!f) throw new Error('不是有效的 DOCX 文件');
    return docxXmlToText(await f.async('string'));
  }

  async function extractPdfText(data, pdfjsImpl) {
    var doc = await pdfjsImpl.getDocument({ data: data }).promise;
    var pages = [];
    for (var p = 1; p <= doc.numPages; p++) {
      var page = await doc.getPage(p);
      var tc = await page.getTextContent();
      pages.push(pdfItemsToText(tc.items));
    }
    return pages.join('\n');
  }

  function llmRawToTrip(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.days)) return null;
    // 丢弃坐标：坐标一律由高德地理编码生成
    var t = normalizeTrip(raw);
    flattenStops(t).forEach(function (f) { f.stop.lng = null; f.stop.lat = null; });
    return t;
  }

  /* ---------- 文件文字提取（纯函数部分） ---------- */
  function docxXmlToText(xml) {
    if (!xml) return '';
    var s = String(xml)
      .replace(/<w:p[ >]/g, '\n<w:p>')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<w:tab[^>]*\/>/g, '\t')
      .replace(/<w:br[^>]*\/>/g, '\n');
    s = s.replace(/<[^>]+>/g, '');
    s = s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/&#(\d+);/g, function (m, n) { return String.fromCharCode(parseInt(n, 10)); });
    return s.split('\n').map(function (l) { return l.trim(); }).filter(Boolean).join('\n');
  }

  function pdfItemsToText(items) {
    var lines = [];
    var cur = '';
    var lastY = null;
    (items || []).forEach(function (it) {
      var y = it.transform && it.transform[5] != null ? it.transform[5] : null;
      var ch = it.str || '';
      if (lastY != null && y != null && Math.abs(y - lastY) > 2) { lines.push(cur.trimEnd()); cur = ''; }
      cur += ch;
      if (it.hasEOL) { lines.push(cur.trimEnd()); cur = ''; lastY = null; }
      else if (y != null) lastY = y;
    });
    if (cur.trim()) lines.push(cur.trimEnd());
    return lines.map(function (l) { return l.trim(); }).filter(Boolean).join('\n');
  }

  /* ---------- 停靠点顺序/序号展示工具 ---------- */
  function stopBadge(f) {
    return 'D' + f.day + '·' + (f.index + 1);
  }

  return {
    VERSION: VERSION,
    STOP_TYPES: STOP_TYPES,
    TYPE_KEYS: TYPE_KEYS,
    TRANSIT_LABELS: TRANSIT_LABELS,
    TRANSIT_ICONS: TRANSIT_ICONS,
    DAY_COLORS: DAY_COLORS,
    dayColor: dayColor,
    uid: uid,
    timeToMinutes: timeToMinutes,
    minutesToTime: minutesToTime,
    formatDuration: formatDuration,
    parseRoadbookText: parseRoadbookText,
    classifyLine: classifyLine,
    extractNameAndNote: extractNameAndNote,
    normalizeStop: normalizeStop,
    normalizeTrip: normalizeTrip,
    tripToExport: tripToExport,
    flattenStops: flattenStops,
    deriveSegments: deriveSegments,
    tripWarnings: tripWarnings,
    buildParsePrompt: buildParsePrompt,
    buildGeneratePrompt: buildGeneratePrompt,
    parseLLMJsonOutput: parseLLMJsonOutput,
    llmRawToTrip: llmRawToTrip,
    llmChatJson: llmChatJson,
    extractDocxText: extractDocxText,
    extractPdfText: extractPdfText,
    docxXmlToText: docxXmlToText,
    pdfItemsToText: pdfItemsToText,
    stopBadge: stopBadge
  };
});
