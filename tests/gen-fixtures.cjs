'use strict';
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { PDFDocument, StandardFonts } = require('pdf-lib');

const dir = path.join(__dirname, 'fixtures');
fs.mkdirSync(dir, { recursive: true });

(async () => {
  const txt = '测试路书\n第1天\n09:00 西湖\n12:00 午餐(楼外楼)\n18:00 入住西湖大酒店\n第2天\n09:00 灵隐寺\n';
  fs.writeFileSync(path.join(dir, 'sample.txt'), txt, 'utf8');

  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file('word/document.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    '<w:p><w:r><w:t>Docx路书</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>第1天</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>08:00 出发黄山</w:t></w:r></w:p>' +
    '</w:body></w:document>');
  const docxBuf = await zip.generateAsync({ type: 'uint8array' });
  fs.writeFileSync(path.join(dir, 'sample.docx'), docxBuf);

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const page = pdfDoc.addPage([400, 200]);
  page.drawText('PdfRoadbook', { x: 20, y: 150, font, size: 14 });
  page.drawText('Day1 09:00 West Lake', { x: 20, y: 120, font, size: 12 });
  const pdfBytes = await pdfDoc.save();
  fs.writeFileSync(path.join(dir, 'sample.pdf'), pdfBytes);

  console.log('fixtures OK');
})().catch(e => { console.error(e); process.exit(1); });
