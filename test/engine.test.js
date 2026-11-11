import test from 'node:test';
import assert from 'node:assert/strict';
import { RideEngine } from '../engine.js';
import { SCENARIOS, simulate, feed } from '../sim.js';

const run = (opts) => feed(new RideEngine(), simulate(opts)).summary();

test('なめらかな運転は荒い運転より大幅に高得点になる', () => {
  const smooth = run({ scenario: 'smooth' });
  const rough = run({ scenario: 'rough' });
  assert.ok(smooth.score >= 85, `smooth=${smooth.score}`);
  assert.ok(rough.score <= 50, `rough=${rough.score}`);
});

test('なめらかな運転ではイベントが出ない', () => {
  assert.deepEqual(run({ scenario: 'smooth' }).counts, {});
});

test('荒い運転の揺れ量はなめらかな運転より大きい', () => {
  const smooth = run({ scenario: 'smooth' });
  const rough = run({ scenario: 'rough' });
  assert.ok(rough.swayRms > smooth.swayRms * 1.5, `${rough.swayRms} vs ${smooth.swayRms}`);
  assert.ok(rough.dose > smooth.dose);
});

test('端末の向きが変わっても前方向を学習し、急ブレーキを判定する', () => {
  const mounts = [
    [0, 0, 0],
    [Math.PI / 2, 0, 0],
    [1.1, 0.3, 0.8],
    [-0.5, 1.2, 2.6],
  ];
  for (const mount of mounts) {
    const s = run({ scenario: 'rough', mount });
    assert.ok(s.forwardReady, `forward not ready: ${mount}`);
    const longTotal = (s.counts.brake ?? 0) + (s.counts.stop ?? 0);
    assert.ok(longTotal >= 1, `no brake at ${mount}: ${JSON.stringify(s.counts)}`);
    assert.ok(s.counts.turn >= 1, `no turn at ${mount}: ${JSON.stringify(s.counts)}`);
  }
});

test('iOS の符号反転でも、加速とブレーキを取り違えない', () => {
  const normal = run({ scenario: 'rough' });
  const flipped = run({ scenario: 'rough', flipSign: true });
  assert.deepEqual(flipped.counts, normal.counts);
  assert.equal(flipped.score, normal.score);
});

test('学習後の前後加速度は、車の加速と同じ符号になる', () => {
  for (const flipSign of [false, true]) {
    const engine = new RideEngine();
    let seenBrake = false;
    let seenAccel = false;
    engine.onEvent = (e) => {
      if (e.type === 'brake') seenBrake = true;
      if (e.type === 'accel') seenAccel = true;
    };
    feed(engine, simulate({ scenario: 'rough', flipSign }));
    assert.ok(seenBrake, `brake flip=${flipSign}`);
    assert.ok(seenAccel, `accel flip=${flipSign}`);
  }
});

test('丁寧な運転なら、凹凸のある路面でもアラートを出さない', () => {
  for (const [noise, bumpAmp] of [[1.2, 0], [0.6, 3], [1.2, 5]]) {
    const s = run({ scenario: 'smooth', noise, bumpAmp });
    assert.deepEqual(s.counts, {}, `noise=${noise} bump=${bumpAmp}`);
  }
});

test('荒れた路面でも、荒い運転の急ブレーキは判定する', () => {
  const s = run({ scenario: 'rough', noise: 1.2, bumpAmp: 3 });
  assert.ok(s.counts.brake >= 1, JSON.stringify(s.counts));
});

test('カックン停止を検出し、丁寧な停止では出さない', () => {
  assert.ok(run({ scenario: 'rough' }).counts.stop >= 1);
  assert.equal(run({ scenario: 'smooth' }).counts.stop, undefined);
});

test('停止回数と走行距離を数える', () => {
  const s = run({ scenario: 'smooth' });
  assert.equal(s.stops, 2);
  assert.ok(s.distance > 100, `distance=${s.distance}`);
});

test('GPS がなくても揺れを判定する', () => {
  const samples = simulate({ scenario: 'rough' }).filter((s) => s.kind === 'motion');
  const s = feed(new RideEngine(), samples).summary();
  assert.equal(s.gpsSeen, false);
  assert.ok(s.counts.rough >= 1 || s.counts.jerk >= 1, JSON.stringify(s.counts));
});

test('端末を持ち替えると学習をやり直し、誤判定を増やさない', () => {
  const engine = new RideEngine();
  const samples = simulate({ scenario: 'smooth', mount: [0, 0, 0] });
  const half = samples.findIndex((s) => s.t > 30);
  feed(engine, samples.slice(0, half));
  const offset = samples[half].t;
  const moved = simulate({ scenario: 'smooth', mount: [Math.PI / 2, 0, 0] })
    .map((s) => ({ ...s, t: s.t + offset }));
  feed(engine, moved);
  const s = engine.summary();
  assert.equal(s.phoneMoves, 1);
  assert.ok(s.score >= 80, `score=${s.score} ${JSON.stringify(s.counts)}`);
});

test('センサーが止まった区間は走行時間に含めない', () => {
  const engine = new RideEngine();
  const samples = simulate({ scenario: 'smooth' });
  const half = samples.findIndex((s) => s.t > 20);
  feed(engine, samples.slice(0, half));
  feed(engine, samples.slice(half).map((s) => ({ ...s, t: s.t + 120 })));
  const s = engine.summary();
  assert.ok(s.pausedSec >= 119 && s.pausedSec <= 121, `paused=${s.pausedSec}`);
  assert.ok(s.movingSec < 90, `moving=${s.movingSec}`);
});

test('停車中の小さな揺れは走行時間にもスコアにも入らない', () => {
  const engine = new RideEngine();
  engine.addGps(0, 0);
  for (let i = 0; i < 60 * 30; i++) {
    const t = i / 60;
    engine.addMotion(t, 0.4 * Math.sin(t * 20), 0, 9.81);
    if (i % 60 === 0) engine.addGps(t, 0);
  }
  const s = engine.summary();
  assert.equal(s.movingSec, 0);
  assert.equal(s.score, 100);
});

test('不正なセンサー値を無視する', () => {
  const engine = new RideEngine();
  engine.addMotion(0, NaN, 0, 9.8);
  engine.addMotion(0.1, null, 0, 9.8);
  engine.addGps(0.2, null);
  assert.equal(engine.summary().score, 100);
});

// 前進で大きく横に振られている瞬間に、右向きの値の符号が合っているかを数える
function rightAgreement(samples) {
  const engine = new RideEngine();
  let agree = 0;
  let disagree = 0;
  for (const s of samples) {
    if (s.kind !== 'motion') {
      engine.addGps(s.t, s.speed, s.heading);
      continue;
    }
    engine.addMotion(s.t, s.x, s.y, s.z);
    const right = engine.live.right;
    if (right === null || Math.abs(s.truth.lateral) < 1.5 || Math.abs(right) < 0.5) continue;
    // truth.lateral は左が正
    if (Math.sign(right) === -Math.sign(s.truth.lateral)) agree++;
    else disagree++;
  }
  return { agree, disagree, engine };
}

test('右向きの横加速度を、iPhone と Android のどちらの符号でも正しく学ぶ', () => {
  for (const flipSign of [false, true]) {
    for (const mount of [[1.1, 0.3, 0.8], [0, 0, 0], [-0.5, 1.2, 2.6]]) {
      const { agree, disagree, engine } = rightAgreement(simulate({ scenario: 'turns', flipSign, mount }));
      assert.notEqual(engine.rightSign, 0, `not learned flip=${flipSign} mount=${mount}`);
      assert.ok(agree > 50 && disagree < agree * 0.05, `flip=${flipSign} mount=${mount} ${agree}/${disagree}`);
    }
  }
});

test('GPS の進行方向がなければ、左右の向きは決めない', () => {
  const samples = simulate({ scenario: 'turns' }).map((s) => (s.kind === 'gps' ? { ...s, heading: null } : s));
  const engine = new RideEngine();
  feed(engine, samples);
  assert.equal(engine.rightSign, 0);
  assert.equal(engine.live.right, null);
});

test('バックで止まる減速を、前進中のブレーキとして学習しない', () => {
  for (const flipSign of [false, true]) {
    const parking = [...SCENARIOS.parking, ...SCENARIOS.parking];
    const engine = new RideEngine();
    feed(engine, simulate({ scenario: parking, flipSign }));
    assert.equal(engine.fwdCount, 0, `flip=${flipSign}`);
    // バックのあとに前進しても、加速とブレーキを取り違えない
    const after = run({ scenario: [...parking, ...SCENARIOS.rough], flipSign });
    const plain = run({ scenario: 'rough', flipSign });
    assert.equal(after.counts.brake ?? 0, plain.counts.brake ?? 0, `flip=${flipSign} ${JSON.stringify(after.counts)}`);
    assert.equal(after.counts.accel ?? 0, plain.counts.accel ?? 0, `flip=${flipSign} ${JSON.stringify(after.counts)}`);
  }
});
