'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../roadbook-core.js');

test('时间转换', () => {
  assert.equal(C.timeToMinutes('08:30'), 510);
  assert.equal(C.timeToMinutes('8:5'), 485);
  assert.equal(C.timeToMinutes('8点30'), 510);
  assert.equal(C.timeToMinutes('25:00'), null);
  assert.equal(C.minutesToTime(510), '08:30');
  assert.equal(C.formatDuration(95), '1小时35分');
});

test('多天切分与标题', () => {
  const text = '川西小环线三日游\n第1天\n08:00 成都出发\n12:00 午餐(雅安)\n18:00 入住康定情歌大酒店\n第2天\n09:00 游览木格措景区\nDay3\n10:00 新都桥观景台 途经\n';
  const t = C.parseRoadbookText(text);
  assert.equal(t.name, '川西小环线三日游');
  assert.equal(t.days.length, 3);
  assert.equal(t.days[0].stops.length, 3);
  assert.equal(t.days[0].stops[0].type, 'start');
  assert.equal(t.days[0].stops[2].type, 'hotel');
  assert.equal(t.days[0].stops[2].name, '康定情歌大酒店');
  assert.equal(t.days[1].stops[0].name, '木格措景区');
  assert.equal(t.days[2].stops[0].type, 'waypoint');
});

test('中文数字天数与D前缀', () => {
  const t = C.parseRoadbookText('第一天\n08:00 出发杭州\n第二天\n09:00 西湖');
  assert.equal(t.days.length, 2);
  assert.equal(t.days[0].day, 1);
  assert.equal(t.days[1].day, 2);
  const t2 = C.parseRoadbookText('D1\n08:00 出发\nD2\n09:00 黄山');
  assert.equal(t2.days[0].day, 1);
  assert.equal(t2.days[1].day, 2);
});

test('时间提取与停留时长', () => {
  const t = C.parseRoadbookText('第1天\n08:00 成都出发\n10:30-12:00 游览泸定桥 停留2小时\n');
  assert.equal(t.days[0].stops[1].arrive, '10:30');
  assert.equal(t.days[0].stops[1].leave, '12:00');
  const t2 = C.parseRoadbookText('第1天\n09:00 峨眉山 停留2小时\n');
  assert.equal(t2.days[0].stops[0].leave, '11:00');
});

test('关键词分类', () => {
  const t = C.parseRoadbookText('第1天\n07:00 从成都出发\n09:00 途经泸定服务区\n12:00 午餐于雅安\n14:00 入住酒店A\n18:00 返程回家\n');
  const types = t.days[0].stops.map(s => s.type);
  assert.deepEqual(types, ['start', 'waypoint', 'food', 'hotel', 'end']);
});

test('箭头摘要行：有时间线时忽略，无时间线时拆分', () => {
  const withTimes = C.parseRoadbookText('第1天\n成都→泸定→康定\n08:00 成都出发\n');
  assert.equal(withTimes.days[0].stops.length, 1);
  const noTimes = C.parseRoadbookText('第1天\n成都→泸定→康定\n');
  assert.deepEqual(noTimes.days[0].stops.map(s => s.name), ['成都', '泸定', '康定']);
});

test('无天标记按单天处理', () => {
  const t = C.parseRoadbookText('厦门一日游\n09:00 鼓浪屿\n12:00 午餐\n');
  assert.equal(t.days.length, 1);
  assert.equal(t.days[0].stops.length, 2);
  assert.equal(t.days[0].stops[1].type, 'food');
});

test('空输入', () => {
  const t = C.parseRoadbookText('');
  assert.equal(t.days.length, 0);
});

test('normalizeTrip：坐标/时间校验与起终点补齐', () => {
  const t = C.normalizeTrip({
    name: ' 测试 ',
    days: [
      { stops: [{ type: 'hotel', name: 'A', lng: 200, lat: 40, arrive: '99:00', transit: 'fly' }, { name: 'B' }] }
    ]
  });
  assert.equal(t.name, '测试');
  const a = t.days[0].stops[0], b = t.days[0].stops[1];
  assert.equal(a.type, 'start'); // 自动补起点
  assert.equal(a.lng, null);
  assert.equal(a.arrive, null);
  assert.equal(a.transit, 'drive');
  assert.equal(b.type, 'end'); // 末站自动终点
});

test('docxXmlToText', () => {
  const xml = '<w:document><w:p><w:r><w:t>第1天</w:t></w:r></w:p><w:p><w:t>08:00 出发 &amp; 集合</w:t></w:p></w:document>';
  const txt = C.docxXmlToText(xml);
  assert.ok(txt.includes('第1天'));
  assert.ok(txt.includes('08:00 出发 & 集合'));
});

test('pdfItemsToText', () => {
  const items = [
    { str: '第1', transform: [0, 0, 0, 0, 0, 100] },
    { str: '天', transform: [0, 0, 0, 0, 0, 100] },
    { str: '08:00 出发', transform: [0, 0, 0, 0, 0, 85], hasEOL: true }
  ];
  const txt = C.pdfItemsToText(items);
  assert.ok(txt.includes('第1天'));
  assert.ok(txt.includes('08:00 出发'));
});

test('parseLLMJsonOutput', () => {
  const raw = '```json\n{"name":"测试","days":[{"day":1,"stops":[]}]}\n```';
  const obj = C.parseLLMJsonOutput(raw);
  assert.equal(obj.name, '测试');
  assert.equal(C.parseLLMJsonOutput('不是JSON'), null);
});

test('llmRawToTrip 丢弃坐标', () => {
  const raw = { name: 'x', days: [{ day: 1, stops: [{ name: 'A', lng: 120, lat: 30 }] }] };
  const t = C.llmRawToTrip(raw);
  assert.equal(t.days[0].stops[0].lng, null);
});

test('deriveSegments 与警告', () => {
  const t = C.normalizeTrip({ days: [{ stops: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] }] });
  const segs = C.deriveSegments(t);
  assert.equal(segs.length, 2);
  const warns = C.tripWarnings(t);
  assert.equal(warns.filter(w => w.kind === 'nopos').length, 3);
});
