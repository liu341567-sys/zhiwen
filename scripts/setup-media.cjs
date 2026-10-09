'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const assets = {
  'linux-x64': {
    ffmpeg: 'e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99',
    ffprobe: '4f231a1960d83e403d08f7971e271707bec278a9ae18e21b8b5b03186668450d',
  },
  'win32-x64': {
    ffmpeg: '04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00',
    ffprobe: '3a7e2dc003dc2cd1472827e4c7c4f056ae1ae0ae7c5bbc580c99b49827351ba4',
  },
};
async function hash(file) {
  const h = crypto.createHash('sha256');
  for await (const b of fs.createReadStream(file)) h.update(b);
  return h.digest('hex');
}
(async () => {
  const platform = `${process.platform}-${process.arch}`,
    expected = assets[platform];
  if (!expected)
    throw new Error(
      `媒体工具尚未验证此开发目标：${platform}，支持 Windows x64 和 Linux x64`,
    );
  const ffmpeg = require('ffmpeg-static');
  if ((await hash(ffmpeg)) !== expected.ffmpeg)
    throw new Error('FFmpeg 校验失败，停止使用该文件');
  const dir = path.join(__dirname, '..', '.cache', 'media', platform);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(
    dir,
    process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe',
  );
  if (!fs.existsSync(file) || (await hash(file)) !== expected.ffprobe) {
    const temporary = file + '.download';
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(
          'curl',
          [
            '--fail',
            '--location',
            '--retry',
            '2',
            '--max-time',
            '120',
            '--silent',
            '--show-error',
            `https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffprobe-${platform}`,
            '--output',
            temporary,
          ],
          { stdio: 'inherit', windowsHide: true },
        );
        child.on('error', reject);
        child.on('exit', (code) =>
          code === 0
            ? resolve()
            : reject(new Error(`媒体工具下载失败（${code}）`)),
        );
      });
      if ((await hash(temporary)) !== expected.ffprobe)
        throw new Error('FFprobe SHA256 校验失败');
      fs.renameSync(temporary, file);
      fs.chmodSync(file, 0o755);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  console.log(`Media tools verified: ${platform}`);
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
