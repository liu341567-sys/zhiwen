'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  { createHash, randomUUID } = require('node:crypto'),
  { spawn } = require('node:child_process');
const probePath = () =>
  process.versions.electron && require('electron').app.isPackaged
    ? path.join(process.resourcesPath, 'media', 'ffprobe.exe')
    : path.join(
        __dirname,
        '..',
        '..',
        '.cache',
        'media',
        `${process.platform}-${process.arch}`,
        process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe',
      );
const EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v']);
const binary = (file) =>
  file.replace(/app\.asar([/\\])/, 'app.asar.unpacked$1');
function run(executable, args, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary(executable), args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '',
      error = '',
      settled = false;
    const timer = setTimeout(() => {
      child.kill();
      done(new Error('视频工具处理超时'));
    }, timeout);
    function done(e) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      e ? reject(e) : resolve(output);
    }
    child.stdout.on('data', (b) => {
      output += b.toString();
      if (output.length > 2e6) {
        child.kill();
        done(new Error('视频元数据过大'));
      }
    });
    child.stderr.on(
      'data',
      (b) => (error = (error + b.toString()).slice(-2000)),
    );
    child.once('error', (e) => done(new Error(`视频工具不可用：${e.message}`)));
    child.once('close', (code) =>
      done(
        code
          ? new Error(`视频文件无法读取（${code}）：${error.slice(-350)}`)
          : null,
      ),
    );
  });
}
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function inspect(file, cache, frame = 0) {
  const real = await fs.promises.realpath(file),
    stat = await fs.promises.stat(real);
  if (!stat.isFile() || !EXTENSIONS.has(path.extname(real).toLowerCase()))
    throw new Error('只支持 MP4、MOV、MKV、WebM、AVI、M4V 视频');
  await fs.promises.access(real, fs.constants.R_OK);
  const meta = JSON.parse(
    await run(
      probePath(),
      [
        '-v',
        'error',
        '-show_format',
        '-show_streams',
        '-print_format',
        'json',
        real,
      ],
      30000,
    ),
  );
  const stream = meta.streams?.find((s) => s.codec_type === 'video');
  const duration = Number(stream?.duration || meta.format?.duration);
  if (
    !stream ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    !stream.width ||
    !stream.height
  )
    throw new Error('未读到有效视频轨道、时长或分辨率');
  const id = randomUUID();
  fs.mkdirSync(cache, { recursive: true });
  const thumbnail = path.join(cache, `${id}.jpg`);
  await run(
    require('ffmpeg-static'),
    [
      '-nostdin',
      '-v',
      'error',
      '-ss',
      String(Math.min(frame, duration - 0.01)),
      '-i',
      real,
      '-frames:v',
      '1',
      '-vf',
      'scale=320:-2',
      '-y',
      thumbnail,
    ],
    60000,
  );
  const sha256 = await digest(real);
  return {
    id,
    path: real,
    name: path.basename(real),
    bytes: stat.size,
    mtime: stat.mtimeMs,
    duration,
    width: stream.width,
    height: stream.height,
    format: path.extname(real).slice(1).toLowerCase(),
    codec: stream.codec_name,
    sha256,
    thumbnail,
    group: '',
  };
}
async function validate(video) {
  const stat = await fs.promises.stat(video.path).catch(() => null);
  if (!stat?.isFile()) throw new Error(`视频不存在：${video.name}`);
  await fs.promises.access(video.path, fs.constants.R_OK);
  if (stat.size !== video.bytes || Math.abs(stat.mtimeMs - video.mtime) > 1)
    throw new Error(`视频文件已发生变化，请重新导入：${video.name}`);
  if ((await digest(video.path)) !== video.sha256)
    throw new Error(`视频内容已发生变化：${video.name}`);
  return true;
}
async function scan(folder) {
  const entries = await fs.promises.readdir(folder, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    if (e.isFile() && EXTENSIONS.has(path.extname(e.name).toLowerCase()))
      files.push(path.join(folder, e.name));
  }
  return files.sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
}
async function frame(video, seconds, cache) {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds >= video.duration)
    throw new Error('指定帧时间超出视频时长');
  const file = path.join(cache, `${randomUUID()}.jpg`);
  await run(require('ffmpeg-static'), [
    '-nostdin',
    '-v',
    'error',
    '-ss',
    String(seconds),
    '-i',
    video.path,
    '-frames:v',
    '1',
    '-y',
    file,
  ]);
  return file;
}
module.exports = { EXTENSIONS, run, inspect, validate, scan, frame, digest };
