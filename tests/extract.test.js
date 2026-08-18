'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../roadbook-core.js');

test('llmChatJson：首次坏JSON自动重试后成功', async () => {
  let calls = 0;
  const fetchImpl = async (url, opts) => {
    calls++;
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(opts.headers.Authorization, 'Bearer test-key');
    const body = JSON.parse(opts.body);
    assert.equal(body.response_format.type, 'json_object');
    const content = calls === 1 ? '抱歉，我无法完成。' : JSON.stringify({ name: '重试成功', days: [{ day: 1, stops: [] }] });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  const obj = await C.llmChatJson({ baseUrl: 'https://api.deepseek.com/', apiKey: 'test-key', model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }], fetchImpl });
  assert.equal(obj.name, '重试成功');
  assert.equal(calls, 2);
});

test('llmChatJson：全部失败抛错', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) });
  await assert.rejects(
    () => C.llmChatJson({ baseUrl: 'https://api.deepseek.com', apiKey: 'bad', model: 'm', messages: [], fetchImpl, attempts: 2 }),
    /LLM 调用失败/
  );
});

test('llmChatJson：Markdown代码块JSON可解析', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '```json\n{"name":"x","days":[]}\n```' } }] }) });
  const obj = await C.llmChatJson({ baseUrl: 'https://x', apiKey: 'k', model: 'm', messages: [], fetchImpl });
  assert.equal(obj.name, 'x');
});

test('DOCX 提取：真实docx经jszip解包出文字', async () => {
  const JSZip = require('jszip');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file('word/document.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:body><w:p><w:r><w:t>第1天</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>08:00 成都出发 &amp; 集合</w:t></w:r></w:p></w:body></w:document>');
  const buf = await zip.generateAsync({ type: 'uint8array' });
  const text = await C.extractDocxText(buf, JSZip);
  assert.ok(text.includes('第1天'));
  assert.ok(text.includes('08:00 成都出发 & 集合'));
});

test('PDF 提取：pdf-lib生成→pdfjs解析', async () => {
  const { PDFDocument, StandardFonts } = require('pdf-lib');
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const page = pdfDoc.addPage([400, 200]);
  page.drawText('Day1 09:00 West Lake', { x: 20, y: 150, font, size: 14 });
  const bytes = await pdfDoc.save();
  const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  const text = await C.extractPdfText(bytes, pdfjsLib);
  assert.ok(/Day1/.test(text));
  assert.ok(/West Lake/.test(text));
});
