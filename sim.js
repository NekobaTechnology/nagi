// なぎ: 走行シミュレーター（デモ表示とテストで共用）
//
// 車の前後・横加速度を合成し、任意の向きに置いた端末のセンサー値へ変換する。
// GPS は 1Hz で、実機に近づけるため 0.6 秒遅らせる。

const G = 9.81;
const smoothstep = (x) => {
  const k = Math.min(1, Math.max(0, x));
  return k * k * (3 - 2 * k);
};

// ある区間の前後加速度と横加速度。stop: true は速度 0 まで続く
const hold = (dur) => ({ dur, along: () => 0 });
const cruise = (dur, swayAmp = 0, swayHz = 0.25) => ({
  dur,
  along: (t) => swayAmp * Math.sin(2 * Math.PI * swayHz * t),
  alat: (t) => swayAmp * 0.8 * Math.sin(2 * Math.PI * swayHz * 0.7 * t),
});
const launch = (dur, peak, ramp) => ({
  dur,
  along: (t) => peak * smoothstep(t / ramp) * smoothstep((dur - t) / ramp),
});
const curve = (dur, peak, ramp) => ({
  dur,
  along: () => 0,
  alat: (t) => peak * smoothstep(t / ramp) * smoothstep((dur - t) / ramp),
});
const brake = (peak, ramp, soft) => ({
  stop: true,
  along: (t, v) => {
    const entry = peak * smoothstep(t / ramp);
    // 丁寧な停止は速度に合わせて減速を抜き、雑な停止はそのまま止まる
    return -(soft ? entry * Math.min(1, (v + 0.3) / 2.5) : entry);
  },
});

const SCENARIOS = {
  smooth: [
    hold(3),
    launch(11, 1.0, 3),
    cruise(12, 0.15),
    curve(8, 1.2, 3),
    cruise(8, 0.15),
    brake(1.2, 2.5, true),
    hold(3),
    launch(11, 1.0, 3),
    cruise(10, 0.15),
    brake(1.1, 2.5, true),
    hold(2),
  ],
  rough: [
    hold(3),
    launch(5, 2.9, 0.3),
    cruise(14, 1.1),
    curve(4, 3.4, 0.4),
    cruise(8, 1.1),
    brake(3.4, 0.3, false),
    hold(3),
    launch(5, 2.9, 0.3),
    curve(4, 3.2, 0.4),
    cruise(10, 1.1),
    brake(3.6, 0.3, false),
    hold(2),
  ],
};

// 端末の取り付け角。車の座標（前, 左, 上）から端末座標へ変換する
function rotation([rx, ry, rz]) {
  const [cx, sx, cy, sy, cz, sz] = [
    Math.cos(rx), Math.sin(rx), Math.cos(ry), Math.sin(ry), Math.cos(rz), Math.sin(rz),
  ];
  return [
    [cy * cz, -cy * sz, sy],
    [sx * sy * cz + cx * sz, -sx * sy * sz + cx * cz, -sx * cy],
    [-cx * sy * cz + sx * sz, cx * sy * sz + sx * cz, cx * cy],
  ];
}

function prng(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296 - 0.5;
  };
}

/**
 * センサー入力の時系列を返す。
 * 各要素は { t, kind: 'motion', x, y, z } または { t, kind: 'gps', speed }
 */
export function simulate({
  scenario = 'smooth',
  hz = 60,
  mount = [1.1, 0.3, 0.8],
  flipSign = false, // iOS は重力込み加速度の符号が Android と逆
  noise = 0.3,
  seed = 7,
  gpsLag = 0.6,
  bumpAmp = 0, // 路面の段差で車体とホルダーが揺れる強さ（m/s²）
  bumpEvery = 2.5,
} = {}) {
  const R = rotation(mount);
  const random = prng(seed);
  const sign = flipSign ? -1 : 1;
  const dt = 1 / hz;
  const out = [];
  const speeds = [];
  let t = 0;
  let v = 0;
  let nextGps = 1;
  let lastBump = -Infinity;

  for (const phase of SCENARIOS[scenario]) {
    let local = 0;
    while (phase.stop ? v > 0 || local === 0 : local < phase.dur) {
      let al = phase.along(local, v);
      if (v <= 0 && al < 0) al = 0;
      const lateral = phase.alat ? phase.alat(local) : 0;
      v = Math.max(0, v + al * dt);

      // 停車中は路面振動なし。走行中は速度に応じた細かい振動を足す
      const vib = v > 0.1 ? noise : 0.01;
      if (bumpAmp && v > 1 && t - lastBump > bumpEvery) lastBump = t;
      const since = Number.isFinite(lastBump) ? t - lastBump : 0;
      const decay = Number.isFinite(lastBump) ? Math.exp(-since / 0.35) : 0;
      // 2Hz は車体の上下、8Hz はホルダーの振れ
      const bump = bumpAmp * decay;
      const rock = Math.sin(2 * Math.PI * 8 * since) + 0.6 * Math.sin(2 * Math.PI * 2 * since);
      const car = [
        al + vib * random() + bump * rock,
        lateral + vib * random() + bump * 0.5 * rock,
        G + vib * 2 * random() + bump * 1.5 * Math.sin(2 * Math.PI * 2 * since),
      ];
      out.push({
        t,
        kind: 'motion',
        x: sign * (R[0][0] * car[0] + R[0][1] * car[1] + R[0][2] * car[2]),
        y: sign * (R[1][0] * car[0] + R[1][1] * car[1] + R[1][2] * car[2]),
        z: sign * (R[2][0] * car[0] + R[2][1] * car[1] + R[2][2] * car[2]),
      });

      speeds.push({ t, v });
      if (t >= nextGps) {
        const target = t - gpsLag;
        const sample = speeds.find((s) => s.t >= target) ?? speeds[0];
        out.push({ t, kind: 'gps', speed: sample.v });
        nextGps += 1;
      }
      t += dt;
      local += dt;
    }
  }

  // 最後の遅れ分も GPS を流す
  for (let extra = 0; extra < 3; extra++) {
    for (let i = 0; i < hz; i++) {
      const car = [0.01 * random(), 0.01 * random(), G];
      out.push({
        t,
        kind: 'motion',
        x: sign * (R[0][0] * car[0] + R[0][1] * car[1] + R[0][2] * car[2]),
        y: sign * (R[1][0] * car[0] + R[1][1] * car[1] + R[1][2] * car[2]),
        z: sign * (R[2][0] * car[0] + R[2][1] * car[1] + R[2][2] * car[2]),
      });
      t += dt;
    }
    out.push({ t, kind: 'gps', speed: 0 });
  }
  return out;
}

export function feed(engine, samples) {
  for (const s of samples) {
    if (s.kind === 'motion') engine.addMotion(s.t, s.x, s.y, s.z);
    else engine.addGps(s.t, s.speed);
  }
  return engine;
}
