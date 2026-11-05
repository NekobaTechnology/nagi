import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LaneTracker,
  detectLaneMarks,
  fitLaneLine,
  inLane,
  lineToSource,
  lineX,
  toGray,
} from '../lane-core.js';

const W = 480;
const H = 90;
const BOTTOM = H - 1;

function noise(seed = 3) {
  let x = seed;
  return () => {
    x = (x * 16807) % 2147483647;
    return x / 2147483647 - 0.5;
  };
}

// 消失点へ向かう白線を描いた路面を作る
function road({
  vpX = 240,
  vpY = -60,
  lines = [90, 390],
  dashed = false,
  phase = 0,
  level = 90,
  markLevel = 200,
  extra = null,
  seed = 3,
} = {}) {
  const gray = new Uint8ClampedArray(W * H);
  const random = noise(seed);
  for (let i = 0; i < gray.length; i++) gray[i] = level + random() * 8;
  for (const bottomX of lines) {
    const a = (bottomX - vpX) / (BOTTOM - vpY);
    for (let y = 0; y < H; y++) {
      if (dashed && Math.floor((y + phase) / 12) % 2 === 0) continue;
      const x = vpX + a * (y - vpY);
      const half = 1 + ((y - vpY) / (BOTTOM - vpY)) * 3;
      for (let px = Math.round(x - half); px <= Math.round(x + half); px++) {
        if (px >= 0 && px < W) gray[y * W + px] = markLevel + random() * 8;
      }
    }
  }
  if (extra) extra(gray);
  return gray;
}

const rngFixed = () => {
  let x = 99;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
};

function runFrames(makeFrame, { seconds = 1, fps = 10, masks = [], tracker = new LaneTracker(), start = 0 } = {}) {
  let result;
  for (let i = 0; i < seconds * fps; i++) {
    result = tracker.update(start + i / fps, makeFrame(i), W, H, masks);
  }
  return result;
}

test('toGray は明るさの配列に変換する', () => {
  const gray = toGray(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]), 2, 1);
  assert.ok(gray[0] >= 254);
  assert.equal(gray[1], 0);
});

test('左右の白線を実際の位置の近くに検出する', () => {
  const r = runFrames(() => road());
  assert.equal(r.status, 'both');
  assert.ok(Math.abs(lineX(r.left, BOTTOM) - 90) < 8, `${lineX(r.left, BOTTOM)}`);
  assert.ok(Math.abs(lineX(r.right, BOTTOM) - 390) < 8, `${lineX(r.right, BOTTOM)}`);
  assert.ok(r.left.a < 0 && r.right.a > 0);
});

test('望遠で垂直に近く写る白線も検出する', () => {
  const r = runFrames(() => road({ vpX: 290, vpY: -800, lines: [300] }));
  assert.equal(r.status, 'right');
  assert.ok(Math.abs(lineX(r.right, BOTTOM) - 300) < 6, `${lineX(r.right, BOTTOM)}`);
});

test('画面の反対側にある縦の模様を白線にしない', () => {
  const pole = (x, lean) => (gray) => {
    for (let y = 0; y < H; y++) {
      const px = Math.round(x + lean * y);
      for (let k = px - 2; k <= px + 2; k++) gray[y * W + k] = 220;
    }
  };
  assert.equal(runFrames(() => road({ lines: [], extra: pole(350, -0.15) })).status, 'none');
  assert.equal(runFrames(() => road({ lines: [], extra: pole(120, 0.15) })).status, 'none');
});

test('白線のない路面では検出しない', () => {
  assert.equal(runFrames(() => road({ lines: [] })).status, 'none');
});

test('片側だけの白線はその側だけ検出する', () => {
  assert.equal(runFrames(() => road({ lines: [90] })).status, 'left');
  assert.equal(runFrames(() => road({ lines: [390] })).status, 'right');
});

test('破線でも複数フレームをまとめて検出する', () => {
  const r = runFrames((i) => road({ dashed: true, phase: i * 5 }));
  assert.equal(r.status, 'both');
});

test('隣の車線の線があっても自車に近い線を選ぶ', () => {
  const r = runFrames(() => road({ lines: [-250, 90, 390, 730] }));
  assert.equal(r.status, 'both');
  assert.ok(Math.abs(lineX(r.left, BOTTOM) - 90) < 10, `${lineX(r.left, BOTTOM)}`);
  assert.ok(Math.abs(lineX(r.right, BOTTOM) - 390) < 10, `${lineX(r.right, BOTTOM)}`);
});

test('広い明るい面や暗い線を白線と誤認しない', () => {
  const bright = (gray) => {
    for (let y = 0; y < H; y++) for (let x = 300; x < W; x++) gray[y * W + x] = 210;
  };
  assert.equal(runFrames(() => road({ lines: [], extra: bright })).status, 'none');
  assert.equal(runFrames(() => road({ markLevel: 30 })).status, 'none');
});

test('水平に近い模様は白線にしない', () => {
  const stripe = (gray) => {
    for (const y of [20, 50, 70]) for (let x = 0; x < W; x++) gray[y * W + x] = 220;
  };
  assert.equal(runFrames(() => road({ lines: [], extra: stripe })).status, 'none');
});

test('前の車の範囲にある模様は無視する', () => {
  const fake = (gray) => {
    for (let y = 0; y < H; y++) {
      const x = 240 - y * 0.8;
      for (let px = Math.round(x) - 2; px <= Math.round(x) + 2; px++) gray[y * W + px] = 220;
    }
  };
  assert.equal(runFrames(() => road({ lines: [], extra: fake })).status, 'left');
  const masks = [{ x: 150, y: 0, w: 110, h: H }];
  assert.equal(runFrames(() => road({ lines: [], extra: fake }), { masks }).status, 'none');
});

test('見失っても1秒は線を保ち、それを過ぎると消す', () => {
  const tracker = new LaneTracker();
  runFrames(() => road(), { tracker });
  assert.equal(tracker.update(1.5, road({ lines: [] }), W, H).status, 'both');
  assert.equal(tracker.update(3, road({ lines: [] }), W, H).status, 'none');
});

test('消失点が右へ動くと右カーブ、左へ動くと左カーブと判定する', () => {
  for (const [shift, expected] of [[80, 'right'], [-80, 'left']]) {
    const tracker = new LaneTracker();
    assert.equal(runFrames(() => road(), { tracker, seconds: 3 }).curve, 'straight');
    const r = runFrames(() => road({ vpX: 240 + shift }), { tracker, seconds: 3, start: 3 });
    assert.equal(r.curve, expected);
  }
});

test('スマホの向きがずれていても直線をカーブと判定しない', () => {
  assert.equal(runFrames(() => road({ vpX: 300, lines: [150, 450] }), { seconds: 3 }).curve, 'straight');
});

test('片側しか見えないときはカーブを判定しない', () => {
  assert.equal(runFrames(() => road({ lines: [90] })).curve, 'unknown');
});

test('線の座標を映像全体の座標へ変換する', () => {
  const line = { a: 0.5, b: 100 };
  const roi = { x: 0, y: 400, scale: 1.5 };
  const source = lineToSource(line, roi);
  assert.ok(Math.abs(lineX(source, 400 + 1.5 * 20) - 1.5 * lineX(line, 20)) < 1e-9);
});

test('車が自分の車線の中にいるかを判定する', () => {
  const left = { a: -1, b: 300 };
  const right = { a: 1, b: 300 };
  assert.equal(inLane(left, right, 300, 100), true);
  assert.equal(inLane(left, right, 100, 100), false);
  assert.equal(inLane(left, right, 500, 100), false);
  assert.equal(inLane(right, left, 300, 100), false);
});

test('点が足りない場合は線にしない', () => {
  const points = detectLaneMarks(road({ lines: [] }), W, H);
  assert.equal(fitLaneLine(points, -1, W, H, rngFixed()), null);
  assert.equal(fitLaneLine([], 1, W, H, rngFixed()), null);
});
