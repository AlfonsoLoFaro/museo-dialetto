/*
  Compiles the AR target image into a MindAR .mind file.

    npm run build:target

  Input : assets/poesia.jpeg   (falls back to assets/ar/liberta/poesia.jpeg)
  Output: assets/ar/liberta/targets.mind

  Uses MindAR's own compiler code (mind-ar) with @napi-rs/canvas, because the
  "canvas" package that mind-ar's offline compiler needs has no prebuilt
  binary for recent Node versions.
*/
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { CompilerBase } from 'mind-ar/src/image-target/compiler-base.js';
import { buildTrackingImageList } from 'mind-ar/src/image-target/image-list.js';
import { extractTrackingFeatures } from 'mind-ar/src/image-target/tracker/extract-utils.js';
import 'mind-ar/src/image-target/detector/kernels/cpu/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(root, 'assets', 'ar', 'liberta', 'targets.mind');
const INPUTS = [
  path.join(root, 'assets', 'poesia.jpeg'),
  path.join(root, 'assets', 'ar', 'liberta', 'poesia.jpeg'),
];

class NodeCompiler extends CompilerBase {
  createProcessCanvas(img) {
    return createCanvas(img.width, img.height);
  }

  async compileTrack({ progressCallback, targetImages, basePercent }) {
    const percentPerImage = (100 - basePercent) / targetImages.length;
    let percent = 0;
    const list = [];
    for (const targetImage of targetImages) {
      const imageList = buildTrackingImageList(targetImage);
      const percentPerAction = percentPerImage / imageList.length;
      list.push(extractTrackingFeatures(imageList, () => {
        percent += percentPerAction;
        progressCallback(basePercent + percent);
      }));
    }
    return list;
  }
}

const input = INPUTS.find(existsSync);
if (!input) {
  console.error('Target image not found. Looked for:\n  ' + INPUTS.join('\n  '));
  process.exit(1);
}

console.log('Image : ' + path.relative(root, input));
const image = await loadImage(input);
console.log(`Size  : ${image.width} x ${image.height}`);

const compiler = new NodeCompiler();
let last = -1;
await compiler.compileImageTargets([image], (p) => {
  const pct = Math.floor(p);
  if (pct !== last && pct % 10 === 0) {
    last = pct;
    console.log(`Compiling... ${pct}%`);
  }
});

const buffer = compiler.exportData();
await mkdir(path.dirname(OUTPUT), { recursive: true });
await writeFile(OUTPUT, buffer);
console.log(`Done  : ${path.relative(root, OUTPUT)} (${buffer.byteLength} bytes)`);
