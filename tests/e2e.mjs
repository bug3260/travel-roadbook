/* 端到端冒烟测试：file:// 双击场景（无高德Key、无LLM Key） */
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const INDEX = pathToFileURL(path.join(ROOT, 'index.html')).href;

let pass = 0, fail = 0;
const fails = [];
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  PASS', name); }
  else { fail++; fails.push(name + (extra ? ' :: ' + extra : '')); console.log('  FAIL', name, extra || ''); }
}


/* mock AMap：真实 1.4.15 行为的关键部分（setBounds 多余参数会抛字符串异常） */
const MOCK_AMAP_JS = `
window.__amapCalls = [];
(function () {
  function finitePos(p) {
    if (!Array.isArray(p) || p.length !== 2) throw new Error('mock: position must be [lng,lat]');
    var lng = +p[0], lat = +p[1];
    if (!isFinite(lng) || !isFinite(lat)) throw new Error('mock: non-finite position');
    return [lng, lat];
  }
  function Marker(opts) { finitePos(opts.position); }
  Marker.prototype.setMap = function (m) {};
  Marker.prototype.on = function (e, f) {};
  Marker.prototype.setContent = function (c) {};
  Marker.prototype.setPosition = function (p) { finitePos(p.lng != null ? [p.lng, p.lat] : p); };
  function Polyline(opts) { if (!opts || !opts.path || !opts.path.length) throw new Error('mock: Polyline bad path'); }
  Polyline.prototype.setMap = function (m) {};
  function Map(container, options) {
    if (typeof container !== 'string') throw new Error('mock: Map container must be id');
    if (!document.getElementById(container)) throw new Error('mock: Map container missing');
    this._zoom = options.zoom || 5;
    window.__amapCalls.push('map.new');
  }
  Map.prototype.addControl = function (c) {};
  Map.prototype.on = function (e, f) {};
  Map.prototype.remove = function (o) {};
  Map.prototype.setBounds = function (b, imm, pad) {
    if (arguments.length > 1) throw 'Invalid Object: Pixel(NaN, NaN)';
    window.__amapCalls.push('map.setBounds');
  };
  Map.prototype.setZoomAndCenter = function (z, c) {};
  Map.prototype.getZoom = function () { return this._zoom; };
  function LngLat(lng, lat) { this.lng = +lng; this.lat = +lat; }
  function Bounds(a, b) {}
  Bounds.prototype.extend = function (p) {};
  function Geocoder(opts) { window.__amapCalls.push('geocoder.new'); }
  Geocoder.prototype.getLocation = function (name, cb) {
    window.__amapCalls.push('geocoder.getLocation');
    if (name === '家') { setTimeout(function () { cb('error', {}); }, 3); return; }
    setTimeout(function () { cb('complete', { geocodes: [{ location: { lng: '120.1', lat: '30.2' } }] }); }, 3);
  };
  function DriveLike() {}
  DriveLike.prototype.search = function (from, to, cb) {
    setTimeout(function () { cb('complete', { routes: [{ path: [{ lng: from.lng, lat: from.lat }, { lng: to.lng, lat: to.lat }], distance: 2000, time: 300 }] }); }, 3);
  };
  function TransferLike() {}
  TransferLike.prototype.search = function (from, to, cb) {
    setTimeout(function () { cb('complete', { plans: [{ distance: 2000, time: 300 }] }); }, 3);
  };
  window.AMap = {
    Map: Map, Marker: Marker, Polyline: Polyline, LngLat: LngLat, Bounds: Bounds,
    Pixel: function (x, y) { this.x = x; this.y = y; },
    InfoWindow: function (opts) { this.setContent = function (c) {}; this.open = function (m, p) {}; this.close = function () {}; },
    ToolBar: function (opts) {},
    Geocoder: Geocoder,
    PlaceSearch: function (opts) {},
    Driving: function (opts) { return new DriveLike(); },
    Walking: function (opts) { return new DriveLike(); },
    Transfer: function (opts) { return new TransferLike(); },
    DrivingPolicy: { LEAST_TIME: 0 },
    WalkingPolicy: { LEAST_TIME: 0 },
    TransferPolicy: { LEAST_TIME: 0 },
    plugin: function (names, cb) { if (cb) cb(); }
  };
})();
`;
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('dialog', d => d.accept());
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });

try {
  await page.goto(INDEX, { waitUntil: 'load' });

  // 1. 初始状态：无 Key 显示提示
  check('初始显示地图Key提示', await page.locator('#mapHint:not(.hidden)').count() === 1);
  check('初始存在默认路书', await page.locator('#tripSelector option').count() === 1);

  // 2. 载入示例路书
  await page.click('#btnDemo');
  await page.waitForTimeout(300);
  check('示例路书3天', await page.locator('#timeline .day-block').count() === 3, 'days=' + await page.locator('#timeline .day-block').count());
  check('示例路书15个地点', await page.locator('#timeline .stop-item').count() === 15, 'stops=' + await page.locator('#timeline .stop-item').count());
  check('示例名称正确', (await page.textContent('#tripName')).includes('川西小环线'));

  // 3. 识别路书（规则解析，无Key）
  await page.click('#btnParse');
  await page.fill('#parseText', '杭州两日游\n第1天\n09:00 西湖\n12:00 午餐(楼外楼)\n18:00 入住西湖大酒店\n第2天\n09:00 灵隐寺\n15:00 返程回家\n');
  await page.click('#btnDoParse');
  await page.waitForTimeout(600);
  check('解析弹窗关闭', await page.locator('#modalParse:not(.hidden)').count() === 0);
  check('解析出标题', (await page.textContent('#tripName')) === '杭州两日游', await page.textContent('#tripName'));
  check('解析出5个地点', await page.locator('#timeline .stop-item').count() === 5, 'stops=' + await page.locator('#timeline .stop-item').count());

  // 4. 添加地点
  await page.click('#btnAddStop');
  await page.fill('#editName', '测试地点A');
  await page.click('#btnSaveStop');
  await page.waitForTimeout(300);
  check('添加地点成功', (await page.textContent('#timeline')).includes('测试地点A'));

  // 5. 删除地点
  const before = await page.locator('#timeline .stop-item').count();
  await page.locator('#timeline .stop-item').last().hover();
  await page.locator('#timeline .stop-item').last().locator('.op-del').click();
  await page.waitForTimeout(300);
  check('删除地点成功', await page.locator('#timeline .stop-item').count() === before - 1, 'before=' + before + ' after=' + await page.locator('#timeline .stop-item').count());

  // 6. 导出JSON
  const dl = page.waitForEvent('download');
  await page.click('#btnExport');
  const download = await dl;
  check('导出JSON下载', (await download.suggestedFilename()).endsWith('.roadbook.json'), await download.suggestedFilename());

  // 7. txt 文件上传解析
  await page.click('#btnParse');
  await page.setInputFiles('#fileInput', path.join(__dirname, 'fixtures', 'sample.txt'));
  await page.waitForTimeout(600);
  const dzInfo = await page.textContent('#dzFileInfo');
  check('txt文件读取', dzInfo.includes('已读取'), dzInfo);
  await page.click('#btnDoParse');
  await page.waitForTimeout(600);
  check('txt解析出西湖', (await page.textContent('#timeline')).includes('西湖'), '');

  // 8. docx 文件上传解析
  await page.click('#btnParse');
  await page.setInputFiles('#fileInput', path.join(__dirname, 'fixtures', 'sample.docx'));
  await page.waitForTimeout(800);
  check('docx文件读取', (await page.textContent('#dzFileInfo')).includes('已读取'), await page.textContent('#dzFileInfo'));
  const docxText = await page.inputValue('#parseText');
  check('docx提取文字', docxText.includes('黄山') && docxText.includes('Docx路书'), docxText.slice(0, 60));
  await page.click('#btnDoParse');
  await page.waitForTimeout(600);
  check('docx解析出黄山', (await page.textContent('#timeline')).includes('黄山'), '');

  // 9. pdf 文件上传解析（file:// fake worker 路径）
  await page.click('#btnParse');
  await page.setInputFiles('#fileInput', path.join(__dirname, 'fixtures', 'sample.pdf'));
  await page.waitForTimeout(1500);
  const pdfInfo = await page.textContent('#dzFileInfo');
  check('pdf文件读取', pdfInfo.includes('已读取'), pdfInfo);
  const pdfText = await page.inputValue('#parseText');
  check('pdf提取文字', pdfText.includes('West Lake'), pdfText.slice(0, 60));
  await page.click('[data-close="modalParse"]');
  await page.waitForTimeout(200);

  // 10. 长图导出无Key提示
  await page.click('#btnLongImage');
  await page.waitForTimeout(300);
  const toastText = await page.textContent('#toast');
  check('长图导出提示需Key', toastText.includes('高德 Key'), toastText);

  // 11. 编辑地点弹窗
  await page.locator('#timeline .stop-item').first().hover();
  await page.locator('#timeline .stop-item').first().locator('.op-edit').click();
  check('编辑弹窗打开', await page.locator('#modalEdit:not(.hidden)').count() === 1);
  await page.fill('#editName', '改名地点');
  await page.click('#btnSaveStop');
  await page.waitForTimeout(300);
  check('改名生效', (await page.textContent('#timeline')).includes('改名地点'));

  // 12. 设置弹窗打开与保存
  await page.click('#btnSettings');
  check('设置弹窗打开', await page.locator('#modalSettings:not(.hidden)').count() === 1);
  check('默认服务商DeepSeek', await page.inputValue('#setBaseUrl') === 'https://api.deepseek.com');
  check('默认模型deepseek-v4-flash', await page.inputValue('#setModel') === 'deepseek-v4-flash');
  await page.click('#btnSaveSettings');
  await page.waitForTimeout(300);


  // 13. 无效高德 Key：提示应指向 Key/白名单问题，而不是「未配置」
  await page.click('#btnSettings');
  await page.fill('#setAmapKey', 'invalid-test-key');
  await page.fill('#setAmapCode', 'invalid-test-code');
  await page.click('#btnSaveSettings');
  await page.waitForTimeout(8000);
  const hintTitle = await page.textContent('#mapHint .hint-title');
  const hintText = await page.textContent('#mapHint .hint-text');
  check('无效Key标题为加载失败', (hintTitle || '').includes('加载失败'), hintTitle);
  check('无效Key提示可操作', (hintText || '').includes('白名单') || (hintText || '').includes('网络'), (hintText || '').slice(0, 80));

  // 14. 回归：真实绘制流程（mock AMap）不得向 setBounds 传 v1.4.15 不支持的 padding
  await page.route('https://webapi.amap.com/**', route => {
    return route.fulfill({ status: 200, contentType: 'text/javascript', body: MOCK_AMAP_JS });
  });
  await page.evaluate(() => {
    localStorage.setItem('roadbook.settings', JSON.stringify({
      provider: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: '',
      model: 'deepseek-v4-flash', amapKey: 'mock-key', amapSecurityJsCode: 'mock-code'
    }));
    localStorage.setItem('roadbook.trips', JSON.stringify([{ id: 't1', trip: {
      version: 1, name: '回归测试路书', city: '杭州',
      days: [{ day: 1, stops: [
        { id: 'a', type: 'start', name: '西湖', arrive: '09:00', leave: null, note: '', transit: 'drive' },
        { id: 'b', type: 'attraction', name: '灵隐寺', arrive: '11:00', leave: null, note: '', transit: 'drive' },
        { id: 'c', type: 'hotel', name: '杭州大酒店', arrive: '18:00', leave: null, note: '', transit: 'drive' }
      ] }]
    }}]));
    localStorage.setItem('roadbook.active', 't1');
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(3500);
  check('mock绘制无遮罩', await page.locator('#mapHint:not(.hidden)').count() === 0);
  const mockToast = await page.textContent('#toast');
  check('mock绘制无错误提示', !mockToast.includes('出错') && !mockToast.includes('未能显示'), mockToast);
  const setBoundsCalls = await page.evaluate(() => (window.__amapCalls || []).filter(c => c === 'map.setBounds').length);
  check('视野调整已调用', setBoundsCalls >= 1, 'setBounds calls=' + setBoundsCalls);

  // 15. 回归：无法定位的地点（如「家」）不得反复自动重试
  await page.evaluate(() => {
    localStorage.setItem('roadbook.trips', JSON.stringify([{ id: 't2', trip: {
      version: 1, name: '循环回归路书', city: '杭州',
      days: [{ day: 1, stops: [
        { id: 'x', type: 'start', name: '家', arrive: '08:00', leave: null, note: '', transit: 'drive' },
        { id: 'y', type: 'attraction', name: '西湖', arrive: '10:00', leave: null, note: '', transit: 'drive' }
      ] }]
    }}]));
    localStorage.setItem('roadbook.active', 't2');
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(3000);
  const geoCalls1 = await page.evaluate(() => (window.__amapCalls || []).filter(c => c === 'geocoder.getLocation').length);
  await page.waitForTimeout(1800);
  const geoCalls2 = await page.evaluate(() => (window.__amapCalls || []).filter(c => c === 'geocoder.getLocation').length);
  check('定位请求不重复', geoCalls1 === 2 && geoCalls2 === 2, 'calls1=' + geoCalls1 + ' calls2=' + geoCalls2);
  check('定位进度已结束', await page.locator('#geoProgress:not(.hidden)').count() === 0);
  const warnText = await page.textContent('#tripWarn');
  check('未定位警告提示', warnText.includes('未能自动定位') && warnText.includes('重试定位'), warnText);

  // 16. 手机视口布局：地图在上、时间轴在下、操作按钮可见
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(500);
  await page.click('#btnDemo');
  await page.waitForTimeout(500);
  const m = await page.evaluate(() => {
    const vh = window.innerHeight;
    const map = document.querySelector('#mapWrap').getBoundingClientRect();
    const sb = document.querySelector('#sidebar').getBoundingClientRect();
    const ops = document.querySelector('.stop-item .stop-ops');
    return {
      vh,
      mapH: Math.round(map.height),
      mapTop: Math.round(map.top),
      sbTop: Math.round(sb.top),
      sbBottom: Math.round(sb.bottom),
      opsDisplay: ops ? getComputedStyle(ops).display : 'none',
      hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  });
  check('手机布局地图在上', m.mapTop >= 0 && m.mapH >= Math.round(m.vh * 0.4), JSON.stringify(m));
  check('手机布局时间轴在下', m.sbTop >= m.vh * 0.45 && Math.abs(m.sbBottom - m.vh) <= 1, JSON.stringify(m));
  check('手机操作按钮可见', m.opsDisplay === 'flex', 'ops=' + m.opsDisplay);
  check('手机无横向滚动', !m.hScroll);
  await page.setViewportSize({ width: 1280, height: 720 });

} catch (e) {
  fail++;
  fails.push('异常: ' + e.message);
  console.log('EXCEPTION', e);
}

if (pageErrors.length) {
  fail++;
  fails.push('页面JS错误: ' + pageErrors.join(' | '));
  console.log('PAGE ERRORS:', pageErrors.slice(0, 10));
}

await browser.close();
console.log('----');
console.log('PASS', pass, 'FAIL', fail);
if (fails.length) { console.log(fails.join('\n')); process.exit(1); }
