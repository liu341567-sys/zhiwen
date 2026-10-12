'use strict';
const { scrub, compare } = require('./data');
const { evidenceHealth } = require('./evidence');
const { packedReport } = require('./codec');
const { deflateRawSync } = require('node:zlib');
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
  const snapshots = new Map(report.snapshots.map((s) => [s.id, s]));
  const pairs = new Map(), differences = [];
  const steps = report.steps.map((s, i) => {
    if (!s.beforeId || !s.afterId || !snapshots.has(s.beforeId) || !snapshots.has(s.afterId))
      return { ...s, sequence: i + 1 };
    const key = s.beforeId + ':' + s.afterId;
    if (!pairs.has(key)) {
      pairs.set(key, differences.length);
      differences.push(compare(snapshots.get(s.beforeId), snapshots.get(s.afterId)));
    }
    return { ...s, sequence: i + 1, diff: { ...s.diff, differenceIndex: pairs.get(key) } };
  });
  const data = scrub({
    ...safe,
    evidenceHealth: evidenceHealth(report),
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
    steps,
    differences,
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
  const d = packedReport(reportData(report, technical)).data,
    json = JSON.stringify(d, null, 2);
  const md = [
    '# 栖页网页调试报告',
    '',
    `版本：${technical.applicationVersion} · 开始：${new Date(d.createdAt).toISOString()}`,
    `状态：${d.status} · 操作 ${d.steps.length} 步 · 快照 ${d.snapshots.length} 份`,
    '',
    '输入值、凭据、本地文件路径和网址查询参数均不导出。截图需在工具中确认后才能导出。',
    `证据检查：操作快照关联缺失 ${d.evidenceHealth.missingStepSnapshots.length} 个；采集未完成 ${d.evidenceHealth.incompleteSteps.length} 步；结构截断 ${d.evidenceHealth.truncatedFrames.length} 个框架快照。`,
    '',
  ];
  if (d.assistance && !d.assistance.taskId) {
    md.push(d.assistance.kind === 'record' ? '## 人工操作录制摘要' : '## 网页问题排查摘要', '',
      `流程名称：${d.assistance.name || d.name}`,
      `范围：${d.assistance.scope === 'partial' ? '部分模块 / 步骤' : '完整流程'}`,
      `问题说明：${d.assistance.issue || '未填写'}`,
      '来源：直接连接已有账号环境；无需发布计划，工具没有创建或启动自动任务。',
      '请按模块标记、暂停 / 继续和人工演示标记还原操作。输入事件保留控件与动作，不包含实际输入值。', '',
      '### 模块 / 步骤索引', '',
      ...(d.assistance.segments || []).map((m) => `- ${m.label} · 步骤 ${m.stepId} · 快照 ${m.snapshotId}`), '',
    );
  }
  if (d.assistance?.taskId) {
    md.push('## 发布问题摘要', '',
      `用户描述：${d.assistance.issue || '未填写'}`,
      `任务参考：${d.assistance.taskId}`,
      `平台：${d.assistance.task?.platform || '未知'} · 当前状态：${d.assistance.task?.stateLabel || '未知'}`,
      `等待或失败原因：${d.assistance.task?.reason || d.assistance.task?.wait?.message || '未提供'}`,
      '人工演示开始处会在时间线中标注，请对照自动操作与随后人工操作；资料包不会自动修改脚本。', '',
      '### 最近任务日志', '',
      ...(d.assistance.task?.logs || []).map((l) => `- ${new Date(l.time).toISOString()} [${l.level}] ${l.message}`), '',
    );
  }
  md.push('## 操作时间线', '');
  for (const s of d.steps) {
    md.push(
      `### 第 ${s.sequence} 步 · ${s.type}`,
      `时间：${new Date(s.time).toISOString()} · 框架：${s.frame || 'main'}`,
      ...(s.eventCount > 1 ? [`连续操作合并：${s.eventCount} 次 · 结束：${new Date(s.lastEventAt).toISOString()}`] : []),
      `说明：${s.note || '无'}`,
      `控件：${s.target?.semantic?.name || s.target?.context?.text || s.target?.text || s.target?.semantic?.label || '无文字 / 输入内容已隐藏'}`,
      `所属区域：${JSON.stringify(s.target?.context?.ancestors || [])}`,
      `定位：${JSON.stringify(s.target?.locators || s.locator || [])}`,
      `前快照：${s.beforeId || '无'} · 后快照：${s.afterId || '无'}`,
      `变化：${s.diff?.total ?? 0} 处`,
      `详细变化索引：${s.diff?.differenceIndex ?? '无'}（report.json 的 differences 数组）`,
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
    '详细 DOM、属性、Shadow 根路径、定位建议和前后差异见 report.json。schemaVersion=2、domEncoding=node-pool-v1：每个快照 frames[].nodeRefs 中的数字依次关联全局 domNodes 数组（从 0 开始）；展开方法是 frame.nodes = frame.nodeRefs.map((i, j) => ({...report.domNodes[i], ...frame.nodeStates[j]}))。该共享是无损的，顺序、框架、定位路径与状态均保留，不可把索引当成元素身份。步骤 diff.differenceIndex 关联 differences 数组，同一前后快照的详细变化只保存一份。evidenceHealth 标记截断与缺失，不能把缺失快照当成已验证结果。定位器必须结合 frame 和 roots 使用；位置不是执行坐标。连续输入保留首末时间、eventCount 与最终后快照，点击、话题结束空格、选择、上传、跳转及模块标记不与输入合并。',
    '',
    ...d.warnings.map((s) => '- ' + s),
  );
  const body = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>栖页调试报告</title><style>body{font:15px/1.6 system-ui;color:#18253b;background:#f6f8fc;margin:32px}article{max-width:1200px;margin:auto}section{background:white;padding:20px;border-radius:10px;margin:16px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}img{max-width:100%}summary{cursor:pointer;font-weight:600}</style><article><h1>栖页网页调试报告</h1><p>${html(d.name)} · ${html(d.status)}</p><p>输入值和凭据均已排除；定位器请结合框架与 Shadow 根路径。</p>${d.assistance ? `<section><h2>录制用途与问题说明</h2><pre>${html(JSON.stringify(d.assistance, null, 2))}</pre></section>` : ''}${d.steps.map((s) => `<section><h2>${s.sequence}. ${html(s.type)}</h2><p>${html(s.note)}</p><pre>${html(JSON.stringify(s, null, 2))}</pre></section>`).join('')}${d.snapshots.map((s) => `<details><summary>结构快照 ${html(s.id)} · ${html(new Date(s.time).toISOString())}</summary><pre>${html(JSON.stringify(s, null, 2))}</pre></details>`).join('')}<details><summary>共享元素词典 · ${d.domNodes.length} 个元素版本</summary><p>快照 frame.nodeRefs 数字按顺序指向以下 domNodes 数组，索引从 0 开始。id 与 rect 的逐快照信息位于同位置的 nodeStates；复用不改变快照内容。</p><pre>${html(JSON.stringify(d.domNodes, null, 2))}</pre></details><h2>操作前后变化</h2>${d.differences.map((difference, i) => `<details><summary>变化 ${i} · ${html(difference.total)} 处</summary><pre>${html(JSON.stringify(difference, null, 2))}</pre></details>`).join('')}<h2>脚本执行</h2><pre>${html(JSON.stringify(d.scripts, null, 2))}</pre>${report.screenshots
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
// Compress repetitive DOM reports; PNGs are already compressed. Standard ZIP
// methods, UTF-8 names and CRC32 need no extra dependency or shell tools.
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
      checksum = crc(data),
      compressed = f.name.endsWith('.png') ? data : deflateRawSync(data),
      payload = compressed.length < data.length ? compressed : data,
      method = payload === data ? 0 : 8;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0x800, 6);
    h.writeUInt16LE(method, 8);
    h.writeUInt32LE(checksum, 14);
    h.writeUInt32LE(payload.length, 18);
    h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(name.length, 26);
    parts.push(h, name, payload);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x800, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt32LE(checksum, 16);
    c.writeUInt32LE(payload.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += h.length + name.length + payload.length;
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
