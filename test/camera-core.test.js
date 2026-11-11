import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LeadTracker,
  LookaheadAdvisor,
  PerfStats,
  BrakeLightDetector,
  brakeLightScore,
  cropRegion,
  focusConstraints,
  iou,
  judgeSpeed,
  judgeThrottle,
  pickLead,
} from '../camera-core.js';

const W = 1280;
const H = 720;
const centered = (w, extra = {}) => ({
  x: W / 2 - w / 2,
  y: H * 0.5,
  w,
  h: w * 0.8,
  label: 'car',
  ...extra,
});

// 再現できる揺らぎを作る
function jitter(seed = 1) {
  let x = seed;
  return (amp) => {
    x = (x * 16807) % 2147483647;
    return (x / 2147483647 - 0.5) * 2 * amp;
  };
}

function run(widthAt, { seconds = 4, fps = 10, noise = 0 } = {}) {
  const tracker = new LeadTracker();
  const random = jitter();
  let result;
  const statuses = [];
  for (let i = 0; i <= seconds * fps; i++) {
    const t = i / fps;
    result = tracker.update(t, [centered(widthAt(t) * (1 + random(noise)))], W, H);
    statuses.push(result.status);
  }
  return { result, statuses };
}

test('縦長の映像は横幅いっぱいの正方形を、指定した高さで切り出す', () => {
  assert.deepEqual(cropRegion(720, 1280), { x: 0, y: 280, w: 720, h: 720 });
  assert.deepEqual(cropRegion(720, 1280, 'center', 0), { x: 0, y: 0, w: 720, h: 720 });
  assert.deepEqual(cropRegion(720, 1280, 'center', 1), { x: 0, y: 560, w: 720, h: 720 });
});

test('横長の映像は中央の正方形を切り出し、全体指定では切り出さない', () => {
  assert.deepEqual(cropRegion(1280, 720), { x: 280, y: 0, w: 720, h: 720 });
  assert.deepEqual(cropRegion(1280, 720, 'full'), { x: 0, y: 0, w: 1280, h: 720 });
});

test('ピントの設定は端末が対応しているものだけを使う', () => {
  assert.deepEqual(focusConstraints({}, {}), {});
  assert.deepEqual(focusConstraints({ focusMode: ['manual'] }, {}), {});
  assert.deepEqual(focusConstraints({ focusMode: ['continuous'] }, {}), { focusMode: 'continuous' });
  assert.deepEqual(
    focusConstraints({ focusMode: ['continuous'] }, { pointsOfInterest: true }, { x: 0.5, y: 1.4 }),
    { focusMode: 'continuous', pointsOfInterest: [{ x: 0.5, y: 1 }] },
  );
});

test('iou は重なりの割合を返す', () => {
  const box = { x: 0, y: 0, w: 10, h: 10 };
  assert.equal(iou(box, box), 1);
  assert.equal(iou(box, { x: 20, y: 20, w: 10, h: 10 }), 0);
});

test('前の車には中央の車を選び、隣の車線や遠くの大きな車は選ばない', () => {
  const side = { x: 20, y: 400, w: 400, h: 300 };
  const center = { x: 560, y: 400, w: 160, h: 120 };
  const sky = { x: 560, y: 0, w: 300, h: 100 };
  assert.equal(pickLead([side, center, sky], W, H), center);
  assert.equal(pickLead([side], W, H), null);
});

test('白線が分かるときは画面の端でも自分の車線の車を選び、隣の車線の車は選ばない', () => {
  const corridor = (x) => x >= 100 && x <= 400;
  const ownLane = { x: 110, y: 400, w: 120, h: 100 };
  const nextLane = { x: 600, y: 300, w: 300, h: 250 };
  assert.equal(pickLead([ownLane, nextLane], W, H, null, corridor), ownLane);
  assert.equal(pickLead([nextLane], W, H, null, corridor), null);
});

test('追跡中の車が車線を変えると前の車から外す', () => {
  const corridor = (x) => x <= 400;
  const moved = { x: 600, y: 400, w: 120, h: 100 };
  const before = { x: 595, y: 400, w: 120, h: 100 };
  assert.equal(pickLead([moved], W, H, before), moved);
  assert.equal(pickLead([moved], W, H, before, corridor), null);
});

test('白線を誤検出して車が車線外に見えても、前の車を見失わない', () => {
  const tracker = new LeadTracker();
  const never = () => false;
  assert.notEqual(tracker.update(0, [centered(200)], W, H, never).box, null);
  assert.notEqual(tracker.update(0.1, [centered(200)], W, H, never).status, 'none');
});

test('ダッシュボードを誤認した範囲いっぱいの枠は前の車に選ばない', () => {
  const dashboard = { x: 0, y: 320, w: 720, h: 400 };
  const van = { x: 280, y: 180, w: 160, h: 200 };
  assert.equal(pickLead([dashboard, van], 720, 720), van);
  assert.equal(pickLead([dashboard], 720, 720), null);
  // 離れた場所の車を追跡中に現れても乗り移らない
  assert.equal(pickLead([dashboard], 720, 720, { x: 280, y: 100, w: 160, h: 200 }), null);
});

test('追跡中の車が近づいて範囲いっぱいになっても見失わない', () => {
  const tracker = new LeadTracker();
  const car = (w) => ({ x: (720 - w) / 2, y: 80, w, h: w * 0.9 });
  let result;
  for (let i = 0; i <= 20; i++) result = tracker.update(i * 0.1, [car(Math.min(700, 400 + i * 30))], 720, 720);
  assert.equal(result.box.w, 700);
  assert.notEqual(result.status, 'none');
  for (let i = 21; i <= 60; i++) result = tracker.update(i * 0.1, [car(700)], 720, 720);
  assert.equal(result.status, 'steady');
});

test('追跡中はより大きな車が現れても同じ車を追う', () => {
  const current = { x: 560, y: 400, w: 160, h: 120 };
  const next = { x: 565, y: 402, w: 162, h: 121 };
  const bigger = { x: 500, y: 300, w: 60, h: 40 };
  const large = { x: 700, y: 350, w: 300, h: 300 };
  assert.equal(pickLead([bigger, large, next], W, H, current), next);
});

test('幅が一定なら接近と判定しない（検出枠の揺れ3%あり）', () => {
  const { result, statuses } = run(() => 200, { noise: 0.03 });
  assert.equal(result.status, 'steady');
  assert.ok(!statuses.includes('closing'), statuses.join());
});

test('幅が毎秒25%で増えると接近と判定し、到達までの秒数を見積もる', () => {
  const { result } = run((t) => 200 * Math.exp(0.25 * t), { noise: 0.02 });
  assert.equal(result.status, 'closing');
  assert.ok(Math.abs(result.secondsToReach - 4) < 1, `${result.secondsToReach}`);
});

test('毎秒5回の更新でも接近を判定できる', () => {
  const { result } = run((t) => 200 * Math.exp(0.25 * t), { fps: 5, noise: 0.02 });
  assert.equal(result.status, 'closing');
});

test('遠ざかる車は離れていると判定する', () => {
  const { result } = run((t) => 400 * Math.exp(-0.25 * t), { noise: 0.02 });
  assert.equal(result.status, 'opening');
});

test('測り始めは判定を保留し、見失って時間が経つと計り直す', () => {
  const tracker = new LeadTracker();
  assert.equal(tracker.update(0, [centered(200)], W, H).status, 'measuring');
  assert.equal(tracker.update(0.2, [], W, H).status, 'lost');
  assert.equal(tracker.update(2, [], W, H).status, 'none');
  assert.equal(tracker.update(2.1, [centered(200)], W, H).status, 'measuring');
});

// 48x32 の車の枠。尾灯は昼でも点いている前提で、常に光らせておく
function carPixels({ highMount = null, redBody = false }) {
  const [w, h] = [48, 32];
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const tail = y >= 20 && y < 26 && (x < 8 || x >= 40);
      const lamp = y === 2 && x >= 18 && x < 30;
      let color = redBody ? [190, 40, 40] : [150, 150, 150];
      if (tail) color = [240, 40, 40];
      if (lamp && highMount) color = highMount === 'orange' ? [250, 150, 60] : [240, 40, 40];
      data.set([...color, 255], i);
    }
  }
  return [data, w, h];
}

test('補助ブレーキ灯が光ると点灯のスコアが上がる', () => {
  assert.ok(brakeLightScore(...carPixels({ highMount: 'red' })).highMount > 0.03);
  // 映像では橙に写ることがある
  assert.ok(brakeLightScore(...carPixels({ highMount: 'orange' })).highMount > 0.03);
});

test('尾灯だけが光っている車は点灯と判定しない', () => {
  assert.equal(brakeLightScore(...carPixels({})).highMount, 0);
});

test('赤い車体を補助ブレーキ灯と誤認しない', () => {
  assert.equal(brakeLightScore(...carPixels({ redBody: true })).highMount, 0);
  assert.equal(brakeLightScore(...carPixels({ redBody: true, highMount: 'red' })).highMount, 0);
  // 赤い車は枠全体が赤い
  assert.ok(brakeLightScore(...carPixels({ redBody: true })).red > 0.5);
});

const lamp = (highMount) => ({ highMount, red: 0.1 });
const glow = (red) => ({ highMount: 0, red });

test('点灯も消灯も、0.25秒続いたときだけ切り替える', () => {
  const detector = new BrakeLightDetector();
  assert.equal(detector.update(0, lamp(0.05)), false);
  assert.equal(detector.update(0.1, lamp(0)), false);
  assert.equal(detector.update(0.2, lamp(0.05)), false);
  assert.equal(detector.update(0.5, lamp(0.05)), true);
  assert.equal(detector.update(0.6, lamp(0)), true);
  assert.equal(detector.update(0.9, lamp(0)), false);
});

test('夜は枠全体の赤いにじみが急に増えたら点灯と判定する', () => {
  const detector = new BrakeLightDetector();
  for (let i = 0; i <= 20; i++) detector.update(i * 0.1, glow(0.1));
  assert.equal(detector.update(2.1, glow(0.7)), false);
  assert.equal(detector.update(2.4, glow(0.55)), true);
  assert.equal(detector.update(5, glow(0.5)), true);
  detector.update(5.1, glow(0.1));
  assert.equal(detector.update(5.4, glow(0.1)), false);
});

test('もともと赤い車は、その赤さを普段の値として扱う', () => {
  const detector = new BrakeLightDetector();
  for (let i = 0; i <= 50; i++) assert.equal(detector.update(i * 0.1, glow(0.6)), false);
});

test('ブレーキ中に追い始めても、一度離したあとの点灯は検出する', () => {
  const detector = new BrakeLightDetector();
  detector.update(0, glow(0.7));
  for (let i = 1; i <= 10; i++) assert.equal(detector.update(i * 0.1, glow(0.6)), false);
  for (let i = 11; i <= 20; i++) detector.update(i * 0.1, glow(0.1));
  detector.update(2.1, glow(0.6));
  assert.equal(detector.update(2.4, glow(0.6)), true);
});

test('処理速度を集計する', () => {
  const stats = new PerfStats();
  for (let i = 0; i <= 200; i++) stats.add(i / 10, 40, { vehicle: i % 2 === 0, lead: i % 4 === 0 });
  const s = stats.summary();
  assert.ok(Math.abs(s.fps - 10) < 0.01);
  assert.equal(s.p50, 40);
  assert.ok(Math.abs(stats.current.fps - 10) < 0.01);
  assert.ok(Math.abs(s.vehicleRate - 0.5) < 0.01);
  assert.ok(Math.abs(s.leadRate - 0.25) < 0.01);
});

test('60秒に満たない最後の区間も実際の時間で更新回数を求める', () => {
  const stats = new PerfStats();
  for (let i = 0; i <= 100; i++) stats.add(i / 10, 40);
  assert.ok(Math.abs(stats.summary().minutes[0].fps - 10) < 0.01);
});

test('速度の判定', () => {
  assert.equal(judgeSpeed(12).level, 'good');
  assert.equal(judgeSpeed(6).level, 'ok');
  assert.equal(judgeSpeed(3).level, 'bad');
});

test('計測の後半で遅くなると発熱の疑いありと判定し、短い計測では判定しない', () => {
  const minute = (fps) => ({ fps });
  assert.equal(judgeThrottle([minute(20), minute(20)]).level, 'unknown');
  assert.equal(judgeThrottle([minute(20), minute(19), minute(19), minute(19), minute(5)]).level, 'good');
  assert.equal(judgeThrottle([minute(20), minute(16), minute(12), minute(12), minute(5)]).level, 'bad');
});

test('赤い光が続いても、いつまでも点灯のままにはならない', () => {
  const detector = new BrakeLightDetector();
  for (let i = 0; i <= 20; i++) detector.update(i * 0.1, glow(0.1));
  let t = 2;
  for (; t < 5; t += 0.1) detector.update(t, glow(0.5));
  assert.equal(detector.update(t, glow(0.5)), true);
  for (; t < 120; t += 0.1) detector.update(t, glow(0.5));
  assert.equal(detector.update(t, glow(0.5)), false);
});

const lead = (status, secondsToReach = null) => ({ status, secondsToReach, box: {} });

test('走行中に前の車へ急に近づいたら一度だけ知らせる', () => {
  const advisor = new LookaheadAdvisor();
  assert.equal(advisor.update(0, { moving: true, lead: lead('steady') }), null);
  assert.equal(advisor.update(0.1, { moving: true, lead: lead('closing', 3) }), 'closing');
  assert.equal(advisor.update(0.2, { moving: true, lead: lead('closing', 2) }), null);
});

test('止まっているときは知らせず、同じ知らせは間を空ける', () => {
  const advisor = new LookaheadAdvisor();
  assert.equal(advisor.update(0, { moving: false, lead: lead('closing', 3) }), null);
  advisor.update(1, { moving: true, lead: lead('steady') });
  assert.equal(advisor.update(2, { moving: true, lead: lead('closing', 3) }), 'closing');
  advisor.update(3, { moving: true, lead: lead('steady') });
  assert.equal(advisor.update(5, { moving: true, lead: lead('closing', 3) }), null);
  advisor.update(14, { moving: true, lead: lead('steady') });
  assert.equal(advisor.update(15, { moving: true, lead: lead('closing', 3) }), 'closing');
});

test('追いつくまでの見込みが長い接近や、見失った車では知らせない', () => {
  const advisor = new LookaheadAdvisor();
  assert.equal(advisor.update(0, { moving: true, lead: lead('closing', 8) }), null);
  assert.equal(advisor.update(1, { moving: true, lead: lead('lost') }), null);
  assert.equal(advisor.update(2, { moving: true, lead: lead('closing', 4) }), 'closing');
});
