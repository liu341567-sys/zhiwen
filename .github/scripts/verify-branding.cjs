#!/usr/bin/env node
'use strict';

// Inspect the actual PE resources, including installer and installed uninstaller.
// A Windows shortcut with icon index 0 uses the first RT_GROUP_ICON resource.
// Compare RT_ICON bytes directly: resedit's IconItem.generate() can normalize DIB
// headers and getIconItemsFromEntries() follows resource rather than group order.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { inflateSync } = require('node:zlib');

const REQUIRED_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function readAsset(filename, kind) {
  const resolved = path.resolve(filename);
  assert(fs.existsSync(resolved), `${kind} does not exist: ${resolved}`);
  assert(fs.statSync(resolved).isFile(), `${kind} is not a file: ${resolved}`);
  return { filename: resolved, data: fs.readFileSync(resolved) };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function pngHasTransparency(data, size, label) {
  assert(data.length >= 33 && data.subarray(0, 8).equals(PNG_SIGNATURE), `${label}: invalid PNG`);
  assert(data.toString('ascii', 12, 16) === 'IHDR' && data.readUInt32BE(8) === 13, `${label}: missing PNG IHDR`);
  assert(data.readUInt32BE(16) === size && data.readUInt32BE(20) === size, `${label}: PNG dimensions differ from ICO directory`);
  assert(data[24] === 8 && data[25] === 6, `${label}: PNG must contain 8-bit RGBA (32bpp) pixels`);
  assert(data[26] === 0 && data[27] === 0 && data[28] === 0, `${label}: unsupported PNG compression, filter method, or interlacing`);
  const chunks = [];
  let ended = false;
  for (let offset = 8; offset < data.length;) {
    assert(offset + 12 <= data.length, `${label}: truncated PNG chunk`);
    const length = data.readUInt32BE(offset);
    const end = offset + 12 + length;
    assert(end <= data.length, `${label}: truncated PNG chunk data`);
    const type = data.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') chunks.push(data.subarray(offset + 8, offset + 8 + length));
    if (type === 'IEND') {
      assert(length === 0 && end === data.length, `${label}: invalid PNG end`);
      ended = true;
      break;
    }
    offset = end;
  }
  assert(ended && chunks.length, `${label}: missing PNG image data or end`);
  const stride = size * 4;
  const expectedLength = (stride + 1) * size;
  const pixels = inflateSync(Buffer.concat(chunks), { maxOutputLength: expectedLength });
  assert(pixels.length === expectedLength, `${label}: incorrect PNG pixel data size`);
  let previous = Buffer.alloc(stride);
  let transparent = false, visible = false;
  for (let y = 0; y < size; y++) {
    const offset = y * (stride + 1);
    const filter = pixels[offset];
    assert(filter <= 4, `${label}: invalid PNG scanline filter`);
    const row = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? row[x - 4] : 0;
      const above = previous[x];
      const upperLeft = x >= 4 ? previous[x - 4] : 0;
      const predictor = [0, left, above, Math.floor((left + above) / 2), paeth(left, above, upperLeft)][filter];
      row[x] = (pixels[offset + 1 + x] + predictor) & 255;
      if (x % 4 === 3) {
        transparent ||= row[x] < 255;
        visible ||= row[x] > 0;
      }
    }
    previous = row;
  }
  assert(visible, `${label}: icon contains no visible pixels`);
  return transparent;
}

function validateImage(data, size, label) {
  if (data.subarray(0, 8).equals(PNG_SIGNATURE)) {
    assert(pngHasTransparency(data, size, label), `${label}: PNG has no transparent pixels`);
    return 'PNG';
  }
  assert(data.length >= 40 && data.readUInt32LE(0) === 40, `${label}: expected PNG or BITMAPINFOHEADER DIB`);
  assert(data.readInt32LE(4) === size && Math.abs(data.readInt32LE(8)) === size * 2, `${label}: DIB dimensions differ from ICO directory`);
  assert(data.readUInt16LE(12) === 1 && data.readUInt16LE(14) === 32 && data.readUInt32LE(16) === 0, `${label}: DIB must contain uncompressed 32bpp pixels`);
  assert(data.readUInt32LE(32) === 0, `${label}: 32bpp DIB must not have a palette`);
  const pixelLength = size * size * 4;
  const maskLength = Math.ceil(size / 32) * 4 * size;
  assert(data.length === 40 + pixelLength + maskLength, `${label}: incorrect DIB pixel/mask data size`);
  let transparent = false, visible = false;
  for (let offset = 43; offset < 40 + pixelLength; offset += 4) {
    transparent ||= data[offset] < 255;
    visible ||= data[offset] > 0;
  }
  assert(transparent && visible, `${label}: DIB must contain both transparent and visible pixels`);
  return 'DIB';
}

function validateSizes(frames, label) {
  const actual = frames.map(frame => frame.size).sort((a, b) => a - b);
  assert(actual.join(',') === REQUIRED_SIZES.join(','), `${label}: expected exactly [${REQUIRED_SIZES.join(', ')}] 32bpp frames; found [${actual.join(', ')}]`);
}

function readSourceIco(filename) {
  const source = readAsset(filename, 'Source ICO');
  const data = source.data;
  assert(data.length >= 6 && data.readUInt16LE(0) === 0 && data.readUInt16LE(2) === 1, `${source.filename}: invalid ICO header`);
  const count = data.readUInt16LE(4);
  const directoryEnd = 6 + count * 16;
  assert(count > 0 && directoryEnd <= data.length, `${source.filename}: invalid ICO frame directory`);
  const frames = [];
  const ranges = [];
  for (let i = 0; i < count; i++) {
    const offset = 6 + i * 16;
    const width = data[offset] || 256;
    const height = data[offset + 1] || 256;
    const planes = data.readUInt16LE(offset + 4);
    const bitCount = data.readUInt16LE(offset + 6);
    const length = data.readUInt32LE(offset + 8);
    const start = data.readUInt32LE(offset + 12);
    const label = `${source.filename}: frame ${i} (${width}x${height})`;
    assert(width === height && planes === 1 && bitCount === 32, `${label}: expected square, one-plane, 32bpp frame`);
    assert(data[offset + 2] === 0 && data[offset + 3] === 0, `${label}: unexpected palette or reserved field`);
    assert(length > 0 && start >= directoryEnd && start + length <= data.length, `${label}: frame data is missing or truncated`);
    assert(!ranges.some(([a, b]) => start < b && a < start + length), `${label}: overlapping ICO frame data`);
    ranges.push([start, start + length]);
    const image = data.subarray(start, start + length);
    const format = validateImage(image, width, label);
    frames.push({ size: width, planes, bitCount, length, hash: sha256(image), format });
  }
  validateSizes(frames, source.filename);
  return { filename: source.filename, frames, hash: sha256(data) };
}

function validateGroupHeader(entry, label) {
  const bin = Buffer.from(entry.bin);
  assert(bin.length >= 6 && bin.readUInt16LE(0) === 0 && bin.readUInt16LE(2) === 1, `${label}: invalid RT_GROUP_ICON header`);
  assert(bin.readUInt16LE(4) > 0 && bin.length === 6 + bin.readUInt16LE(4) * 14, `${label}: truncated RT_GROUP_ICON directory`);
}

function verifyExecutable(filename, source, pe, resedit) {
  const asset = readAsset(filename, 'Windows executable');
  const exe = pe.NtExecutable.from(asset.data, { ignoreCert: true });
  const resources = pe.NtExecutableResource.from(exe);
  const groupEntries = resources.entries.filter(entry => entry.type === 14);
  assert(groupEntries.length > 0, `${asset.filename}: no RT_GROUP_ICON resource`);
  // PE resource enumeration is preserved by pe-library and resedit. Check every
  // language variant of the first group so locale selection cannot hide an old icon.
  const firstId = groupEntries[0].id;
  const firstEntries = groupEntries.filter(entry => entry.id === firstId);
  for (const entry of firstEntries) {
    const label = `${asset.filename}: icon index 0, group ${JSON.stringify(firstId)}, language ${JSON.stringify(entry.lang)}`;
    validateGroupHeader(entry, label);
    const group = resedit.Resource.IconGroupEntry.fromEntries([entry])[0];
    const frames = group.icons.map(icon => ({ size: icon.width || 256, icon }));
    validateSizes(frames, label);
    for (const { size, icon } of frames) {
      const expected = source.frames.find(frame => frame.size === size);
      assert((icon.height || 256) === size && icon.planes === expected.planes && icon.bitCount === expected.bitCount, `${label}: ${size}px frame dimensions/planes/bit depth differ from source ICO`);
      const matches = resources.entries.filter(resource => resource.type === 3 && resource.id === icon.iconID && resource.lang === entry.lang);
      assert(matches.length === 1, `${label}: ${size}px RT_ICON ${icon.iconID} is missing or duplicated`);
      const image = Buffer.from(matches[0].bin);
      assert(icon.dataSize === image.length && image.length === expected.length, `${label}: ${size}px image byte length differs from source ICO`);
      const actualHash = sha256(image);
      assert(actualHash === expected.hash, `${label}: ${size}px raw image SHA256 mismatch (source ${expected.hash}, PE ${actualHash})`);
    }
  }
  console.log(`Verified PE: ${asset.filename}; shortcut icon index 0, group ${JSON.stringify(firstId)}, ${firstEntries.length} language variant(s), all ${source.frames.length} raw frames match source ICO.`);
}

function parseArgs(args) {
  const usage = 'Usage: node .github/scripts/verify-branding.cjs --ico src/assets/qiye.ico --exe <Windows.exe> [--exe <installer-or-uninstaller.exe> ...]';
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log(usage);
    return null;
  }
  let ico;
  const executables = [];
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    assert(['--ico', '--exe'].includes(option), `Unknown option: ${option}\n${usage}`);
    const value = args[++i];
    assert(value && !value.startsWith('--'), `Missing value for ${option}\n${usage}`);
    if (option === '--ico') {
      assert(!ico, `Specify --ico only once\n${usage}`);
      ico = value;
    } else executables.push(value);
  }
  assert(ico && executables.length, `Both --ico and at least one --exe are required\n${usage}`);
  return { ico, executables };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) return;
  const source = readSourceIco(args.ico);
  const [pe, resedit] = await Promise.all([import('pe-library'), import('resedit')]);
  console.log(`Verified source ICO: ${source.filename}; ${source.frames.length} transparent 32bpp frames [${REQUIRED_SIZES.join(', ')}]; SHA256 ${source.hash}.`);
  for (const executable of args.executables) verifyExecutable(executable, source, pe, resedit);
}

main().catch(error => {
  console.error(`Branding verification failed: ${error.message}`);
  process.exitCode = 1;
});
