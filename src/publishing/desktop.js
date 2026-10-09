'use strict';
const { dialog, ipcMain, protocol, net } = require('electron');
const fs = require('node:fs'),
  path = require('node:path'),
  { pathToFileURL } = require('node:url');
const media = require('./media');
const ExcelJS = require('exceljs');
// Registered on the manager's default Session only. Remote environments own
// different Sessions and cannot use this handler or the publishing IPC bridge.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'qiye-media',
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true,
    },
  },
]);
function installDesktop({ window, service, assertManager }) {
  protocol.handle('qiye-media', async (request) => {
    try {
      const u = new URL(request.url),
        parts = u.pathname.split('/').filter(Boolean);
      if (
        u.hostname !== 'local' ||
        parts.length !== 2 ||
        !['video', 'image'].includes(parts[0])
      )
        return new Response(null, { status: 404 });
      const resource = service.store.resource(parts[1], parts[0]);
      return net.fetch(pathToFileURL(resource.path).href, {
        headers: request.headers,
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
  ipcMain.handle('publishing:command', async (event, command, input) => {
    assertManager(event);
    if (typeof command !== 'string') throw new Error('发布操作无效');
    if (
      command === 'files' ||
      command === 'folder' ||
      command === 'cover' ||
      command === 'library-import'
    ) {
      const directory = command === 'folder',
        image = command === 'cover',
        library = command === 'library-import';
      const result = await dialog.showOpenDialog(window, {
        title: directory
          ? '导入视频文件夹'
          : image
            ? '选择本地封面'
            : library
              ? '导入标题 / 话题组'
              : '导入本地视频',
        properties: directory
          ? ['openDirectory']
          : image || library
            ? ['openFile']
            : ['openFile', 'multiSelections'],
        filters: directory
          ? undefined
          : [
              {
                name: image ? '封面图片' : library ? '文案文件' : '视频',
                extensions: image
                  ? ['png', 'jpg', 'jpeg', 'webp']
                  : library
                    ? ['txt', 'csv', 'xlsx']
                    : ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'],
              },
            ],
      });
      if (result.canceled) return { cancelled: true };
      if (image) return service.addCover(result.filePaths[0]);
      if (library) {
        if (!['title', 'topics'].includes(input?.kind))
          throw new Error('资源类型不正确');
        const file = result.filePaths[0],
          stat = await fs.promises.stat(file);
        if (stat.size > 20 * 1024 * 1024)
          throw new Error('导入文件不能超过 20 MB');
        let lines = [];
        if (path.extname(file).toLowerCase() === '.xlsx') {
          const book = new ExcelJS.Workbook();
          await book.xlsx.readFile(file);
          for (const sheet of book.worksheets)
            sheet.eachRow((row) => {
              const value = row.getCell(1).text.trim();
              if (value) lines.push(value);
            });
        } else {
          lines = (await fs.promises.readFile(file, 'utf8'))
            .replace(/^\uFEFF/, '')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
        }
        return service.resources(input.kind, lines, input.group || '');
      }
      return service.importFiles(
        directory ? await media.scan(result.filePaths[0]) : result.filePaths,
      );
    }
    if (command === 'export' || command === 'backup') {
      const backup = command === 'backup';
      const result = await dialog.showSaveDialog(window, {
        title: backup ? '备份发布数据库' : '导出发布记录',
        defaultPath: backup ? 'Qiye-Publishing.sqlite' : 'Qiye-Publishing.xlsx',
        filters: backup
          ? [{ name: 'SQLite 数据库', extensions: ['sqlite'] }]
          : [
              { name: 'Excel', extensions: ['xlsx'] },
              { name: 'CSV', extensions: ['csv'] },
            ],
      });
      if (result.canceled) return { cancelled: true };
      if (backup) {
        if (fs.existsSync(result.filePath))
          throw new Error('为保护已有备份，请使用新的文件名');
        service.store.backup(result.filePath);
        return { saved: true };
      }
      const ids = new Set(input?.ids || []),
        tasks = service.store.tasks().filter((t) => !ids.size || ids.has(t.id));
      const book = new ExcelJS.Workbook(),
        sheet = book.addWorksheet('发布记录');
      sheet.columns = [
        '任务 ID',
        '批次 ID',
        '视频',
        '本地位置',
        '平台',
        '账号',
        '环境 ID',
        '标题',
        '话题组',
        '计划开始时间',
        '实际提交时间',
        '状态',
        '结果 / 原因',
        '作品链接',
        '重试次数',
        '日志',
      ].map((header) => ({ header, width: 24 }));
      const safe = (v) => {
        if (typeof v !== 'string') return v;
        const bounded = v.slice(0, 32000);
        return /^[=+\-@\t\r]/.test(bounded) ? `'${bounded}` : bounded;
      };
      for (const t of tasks)
        sheet.addRow(
          [
            t.id,
            t.batchId,
            t.video.name,
            t.video.path,
            t.platformId,
            t.accountName,
            t.accountId,
            t.title,
            t.topics,
            new Date(t.plannedAt).toISOString(),
            t.result?.submittedAt
              ? new Date(t.result.submittedAt).toISOString()
              : '',
            t.status,
            t.result?.reason || '',
            t.result?.url || '',
            Math.max(0, t.attempts - 1),
            service.store
              .logs(t.id)
              .map((l) => `${new Date(l.time).toISOString()} ${l.message}`)
              .join('\n'),
          ].map(safe),
        );
      if (path.extname(result.filePath).toLowerCase() === '.csv')
        await book.csv.writeFile(result.filePath, {
          encoding: 'utf8',
          formatterOptions: { writeBOM: true },
        });
      else await book.xlsx.writeFile(result.filePath);
      return { saved: true, count: tasks.length };
    }
    if (command === 'file-check') {
      const results = [];
      for (const video of service.store.list('video')) {
        try {
          await media.validate(video);
          results.push({ id: video.id, valid: true });
        } catch (e) {
          results.push({ id: video.id, valid: false, reason: e.message });
        }
      }
      return results;
    }
    return service.dispatch(command, input);
  });
}
module.exports = { installDesktop };
