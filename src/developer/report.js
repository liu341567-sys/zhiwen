'use strict';
const { scrub } = require('./data');
const html = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
function reportData(report, technical) {
  const { accountId, options, ...safe } = report;
  const data = scrub({
    ...safe,
    environment: { reference: 'selected-existing-environment', ...technical },
    privacy: {
      inputValues: false,
      credentials: false,
      urlQueries: false,
      filePaths: false,
      screenshots: 'masked and user-reviewed',
      excludedSelectors: options.exclude || [],
      textIncluded: options.includeText !== false,
    },
    steps: report.steps.map((s, i) => ({ ...s, sequence: i + 1 })),
    screenshots: report.screenshots.map((s) => ({
      id: s.id,
      time: s.time,
      snapshotId: s.snapshotId,
      stepId: s.stepId,
      reviewed: s.reviewed,
    })),
  });
  // Trusted internal file references must not be mistaken for opaque tokens.
  for (const shot of data.screenshots)
    shot.file = 'screenshots/' + shot.id + '.png';
  return data;
}
function filesFor(report, technical) {
  const d = reportData(report, technical),
    json = JSON.stringify(d, null, 2);
  const md = [
    '# 栖页网页调试报告',
    '',
    `版本：${technical.applicationVersion} · 开始：${new Date(d.createdAt).toISOString()}`,
    `状态：${d.status} · 操作 ${d.steps.length} 步 · 快照 ${d.snapshots.length} 份`,
    '',
    '输入值、凭据、本地文件路径和网址查询参数均不导出。截图需在工具中确认后才能导出。',
    '',
    '## 操作时间线',
    '',
  ];
  for (const s of d.steps) {
    md.push(
      `### 第 ${s.sequence} 步 · ${s.type}`,
      `时间：${new Date(s.time).toISOString()} · 框架：${s.frame || 'main'}`,
      `说明：${s.note || '无'}`,
      `定位：${JSON.stringify(s.target?.locators || s.locator || [])}`,
      `前快照：${s.beforeId || '无'} · 后快照：${s.afterId || '无'}`,
      `变化：${s.diff?.total ?? 0} 处`,
      '',
    );
  }
  md.push('## 脚本步骤与错误', '');
  for (const s of d.scripts)
    md.push(
      `- ${s.operation} / ${s.phase}：${s.message || s.reason || ''} · ${s.durationMs ?? 0} ms · ${JSON.stringify(s.locator || {})} · 快照 ${s.snapshotId || '无'}`,
    );
  md.push(
    '',
    '## 阅读索引',
    '详细 DOM、属性、Shadow 根路径、定位建议和前后差异见 report.json。定位器必须结合 frame 和 roots 使用；位置不是执行坐标。',
    '',
    ...d.warnings.map((s) => '- ' + s),
  );
  const body = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>栖页调试报告</title><style>body{font:15px/1.6 system-ui;color:#18253b;background:#f6f8fc;margin:32px}article{max-width:1200px;margin:auto}section{background:white;padding:20px;border-radius:10px;margin:16px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}img{max-width:100%}summary{cursor:pointer;font-weight:600}</style><article><h1>栖页网页调试报告</h1><p>${html(d.name)} · ${html(d.status)}</p><p>输入值和凭据均已排除；定位器请结合框架与 Shadow 根路径。</p>${d.steps.map((s) => `<section><h2>${s.sequence}. ${html(s.type)}</h2><p>${html(s.note)}</p><pre>${html(JSON.stringify(s, null, 2))}</pre></section>`).join('')}${d.snapshots.map((s) => `<details><summary>结构快照 ${html(s.id)} · ${html(new Date(s.time).toISOString())}</summary><pre>${html(JSON.stringify(s, null, 2))}</pre></details>`).join('')}<h2>脚本执行</h2><pre>${html(JSON.stringify(d.scripts, null, 2))}</pre>${report.screenshots
    .filter((s) => s.reviewed)
    .map(
      (s) =>
        `<section><h2>截图 · ${html(s.snapshotId || s.stepId)}</h2><img alt="已脱敏页面截图" src="${s.data}"></section>`,
    )
    .join('')}</article>`;
  const files = [
    { name: 'report.json', data: Buffer.from(json) },
    { name: 'report.md', data: Buffer.from(md.join('\n')) },
    { name: 'report.html', data: Buffer.from(body) },
  ];
  for (const s of report.screenshots) {
    if (!s.reviewed)
      throw new Error('请先预览并确认所有截图，或删除不需要导出的截图');
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(s.data))
      throw new Error('截图格式无效');
    files.push({
      name: 'screenshots/' + s.id + '.png',
      data: Buffer.from(s.data.split(',')[1], 'base64'),
    });
  }
  return files;
}
// ZIP store format, UTF-8 names and CRC32; no runtime dependency or shell tools.
function zip(files) {
  const parts = [],
    central = [];
  let offset = 0;
  const crc = (b) => {
    let c = 0xffffffff;
    for (const byte of b) {
      c ^= byte;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  for (const f of files) {
    if (!/^(report\.(json|md|html)|screenshots\/[\w-]+\.png)$/.test(f.name))
      throw new Error('不安全的资料路径');
    const name = Buffer.from(f.name),
      data = f.data,
      checksum = crc(data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0x800, 6);
    h.writeUInt32LE(checksum, 14);
    h.writeUInt32LE(data.length, 18);
    h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(name.length, 26);
    parts.push(h, name, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x800, 8);
    c.writeUInt32LE(checksum, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += h.length + name.length + data.length;
  }
  const size = central.reduce((n, b) => n + b.length, 0),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}
module.exports = { reportData, filesFor, zip };
