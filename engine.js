// なぎ: 揺れ判定エンジン（DOM非依存）
//
// 入力: 重力込み加速度（端末座標系）と GPS 速度
// 出力: 前後・横の加速度、躍度、低周波の揺れ量、イベント、スコア
//
// 端末の向きは問わない。iOS と Android で加速度の符号が逆でも動くよう、
// 前方向は「GPS の速度変化と相関する水平方向」として走行中に学習する。

// しきい値は実車調整前の初期値。単位は m/s²（jerk, stop は m/s³）
export const THRESHOLDS = {
  brake: 2.5,
  accel: 2.0,
  turn: 2.5,
  rough: 2.8, // 前方向を学習する前に使う、水平加速度の大きさ
  jerk: 2.5,
  stop: 1.8,
  sway: 0.9,
};

export const SENSITIVITY = { normal: 1, gentle: 0.8 };

const WEIGHTS = { brake: 3, accel: 2, turn: 3, rough: 3, jerk: 2, stop: 2, sway: 2 };
const COOLDOWN = { brake: 5, accel: 5, turn: 5, rough: 5, jerk: 5, stop: 0, sway: 60 };

// 判定に必要な継続時間。段差の衝撃は短く、運転操作はもっと長く続く
const HOLD_SEC = { brake: 0.3, accel: 0.3, turn: 0.4, rough: 0.3, jerk: 0.2 };

const STEP = 0.05; // 内部処理は 20Hz
const RING = 200; // 10 秒分

const alpha = (dt, tau) => 1 - Math.exp(-dt / tau);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a) => {
  const l = len(a);
  return l > 1e-9 ? scale(a, 1 / l) : [0, 0, 1];
};
const lerp3 = (a, b, k) => add(a, scale(sub(b, a), k));
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export class RideEngine {
  constructor({ sensitivity = 1, onEvent = () => {} } = {}) {
    this.sens = sensitivity;
    this.onEvent = onEvent;

    this.t0 = null;
    this.lastSampleT = null;
    this.lastStepT = null;
    this.acc = [0, 0, 0];
    this.accN = 0;

    this.g = null;
    this.smooth = null;
    this.slow = null; // 運転操作を見るための、よりなだらかな信号
    this.roadEma = 0; // 路面由来の細かい揺れの大きさ
    this.held = {};
    this.tiltSince = null;
    this.suppressUntil = 0;
    this.pausedSec = 0;
    this.phoneMoves = 0;

    this.ring = [];
    this.h = [0, 0, 0];
    this.resetForward();

    this.bpSlow = [0, 0, 0];
    this.bpFast = [0, 0, 0];
    this.swayEma = 0;
    this.doseSum = 0; // ∫a²dt
    this.swaySum = 0;

    this.speed = null;
    this.speedT = -Infinity;
    this.lastGps = null;
    this.lastFastT = -Infinity;
    this.stopHandled = true;
    this.stops = 0;
    this.distance = 0;
    this.gpsSeen = false;

    this.movingSec = 0;
    this.events = [];
    this.lastEventT = {};
    this.buckets = [];
    this.bucket = { sum: 0, n: 0 };

    this.live = { long: null, lat: null, mag: 0, jerk: 0, level: 0, sway: 0 };
  }

  resetForward() {
    this.fwdS = [0, 0, 0];
    this.fwdN = 0;
    this.fwdE = 0;
    this.fwdCount = 0;
    this.fwdDv = 0;
    this.gpsAcc = [0, 0, 0];
    this.gpsAccN = 0;
  }

  get forwardReady() {
    if (this.fwdCount < 6 || this.fwdDv < 6) return false;
    return len(this.fwdS) / Math.sqrt(this.fwdN * this.fwdE + 1e-9) >= 0.5;
  }

  get moving() {
    const speedFresh = this.speedT > (this.lastStepT ?? 0) - 5;
    if (!speedFresh || this.speed === null) return true; // GPS なしでも揺れは測る
    // GPS は 1 秒以上遅れるので、発進の瞬間は加速度でも走り出しを判断する
    return this.speed >= 1.0 || len(this.h) > 0.8;
  }

  addMotion(t, x, y, z) {
    if (![x, y, z].every(Number.isFinite)) return;
    if (this.t0 === null) {
      this.t0 = t;
      this.lastStepT = t;
    }
    if (this.lastSampleT !== null && t - this.lastSampleT > 1) {
      // 画面オフなどでセンサーが止まった区間は走行時間に含めない
      this.pausedSec += t - this.lastSampleT;
      this.lastStepT = t;
      this.acc = [0, 0, 0];
      this.accN = 0;
      this.ring = [];
      this.smooth = null;
      this.slow = null;
      this.suppressUntil = t + 2;
    }
    this.lastSampleT = t;
    this.acc = add(this.acc, [x, y, z]);
    this.accN++;
    if (t - this.lastStepT >= STEP) {
      this.step(t, t - this.lastStepT, scale(this.acc, 1 / this.accN));
      this.lastStepT = t;
      this.acc = [0, 0, 0];
      this.accN = 0;
    }
  }

  step(t, dt, raw) {
    const elapsed = t - this.t0 - this.pausedSec;
    if (!this.g) this.g = raw;
    if (!this.smooth) this.smooth = raw;
    if (!this.slow) this.slow = raw;

    this.smooth = lerp3(this.smooth, raw, alpha(dt, 0.15));
    this.slow = lerp3(this.slow, raw, alpha(dt, 0.35));

    // なだらかな信号から外れた成分は、運転操作ではなく路面やホルダーの揺れ
    const shake = sub(raw, this.slow);
    this.roadEma += (dot(shake, shake) - this.roadEma) * alpha(dt, 1.5);

    // 停車中は重力を素早く補正する。ただし発進の加速を重力と誤認しないよう、
    // 加速度が小さいときに限る
    const stopped = this.speed !== null && this.speed < 0.5 && this.speedT > t - 5;
    const quiet = len(sub(this.smooth, this.g)) < 0.5;
    const tauG = elapsed < 2 ? 0.5 : stopped && quiet ? 1.5 : 12;
    this.g = lerp3(this.g, raw, alpha(dt, tauG));

    // 端末を動かすと重力方向が大きくずれる。カーブの横Gでは 30° に届かない
    const cos = dot(norm(this.smooth), norm(this.g));
    if (cos < Math.cos((30 * Math.PI) / 180)) {
      this.tiltSince ??= t;
      if (t - this.tiltSince > 1) {
        this.g = this.smooth;
        this.slow = this.smooth;
        this.roadEma = 0;
        this.resetForward();
        this.ring = [];
        this.bpSlow = [0, 0, 0];
        this.bpFast = [0, 0, 0];
        this.suppressUntil = t + 3;
        this.tiltSince = null;
        this.phoneMoves++;
        // 傾き始めに出た判定は持ち替えによるものなので取り消す
        this.events = this.events.filter((e) => e.t < this.movingSec - 3);
      }
    } else {
      this.tiltSince = null;
    }

    const gHat = norm(this.g);
    const a = sub(this.slow, this.g);
    const h = sub(a, scale(gHat, dot(a, gHat)));
    this.h = h;
    const mag = len(h);

    this.ring.push({ t, h, mag });
    if (this.ring.length > RING) this.ring.shift();

    this.gpsAcc = add(this.gpsAcc, h);
    this.gpsAccN++;

    // 0.5 秒前との差で躍度を求める。路面の細かい振動を拾いにくい
    let jerk = 0;
    const back = this.ring.length - 11;
    if (back >= 0) {
      const prev = this.ring[back];
      const span = t - prev.t;
      if (span > 0.2) jerk = len(sub(h, prev.h)) / span;
    }

    // 酔いに効きやすい 0.08〜0.5Hz を取り出す
    this.bpSlow = lerp3(this.bpSlow, h, alpha(dt, 2.0));
    this.bpFast = lerp3(this.bpFast, sub(h, this.bpSlow), alpha(dt, 0.32));
    const sway2 = dot(this.bpFast, this.bpFast);

    let long = null;
    let lat = null;
    if (this.forwardReady) {
      const f = norm(sub(this.fwdS, scale(gHat, dot(this.fwdS, gHat))));
      long = dot(h, f);
      lat = dot(h, cross(gHat, f));
    }

    const active =
      this.moving && t >= this.suppressUntil && elapsed > 3 && this.tiltSince === null;
    if (active) {
      this.movingSec += dt;
      this.doseSum += sway2 * dt;
      this.swaySum += sway2 * dt;
      this.swayEma += (sway2 - this.swayEma) * alpha(dt, 30);
      this.bucket.sum += sway2;
      this.bucket.n++;
      if (this.bucket.n >= 200) this.flushBucket();
      this.detect(t, dt, { long, lat, mag, jerk });
    }

    const th = THRESHOLDS;
    const s = this.sens * this.roadMargin;
    this.live = {
      long,
      lat,
      mag,
      jerk,
      sway: Math.sqrt(this.swayEma),
      level: clamp(Math.max(mag / (th.rough * s), jerk / (th.jerk * s)), 0, 1),
    };
  }

  flushBucket() {
    if (!this.bucket.n) return;
    this.buckets.push({
      t: this.movingSec,
      rms: Math.sqrt(this.bucket.sum / this.bucket.n),
    });
    this.bucket = { sum: 0, n: 0 };
  }

  // 路面が荒いほど基準を上げる。滑らかな路面では 1 倍、荒れた路面で最大 2.5 倍
  get roadMargin() {
    return 1 + clamp((Math.sqrt(this.roadEma) - 0.4) / 1.0, 0, 1.5);
  }

  sustained(t, dt, type, active, value) {
    this.held[type] = active ? (this.held[type] ?? 0) + dt : 0;
    if (this.held[type] >= HOLD_SEC[type]) this.emit(t, type, value);
  }

  detect(t, dt, { long, lat, mag, jerk }) {
    const th = THRESHOLDS;
    // 加速度が続く判定は路面の影響を受けにくいので、上げ幅を抑えて見逃しを防ぐ
    const s = this.sens * Math.min(this.roadMargin, 1.3);
    if (long !== null) {
      this.sustained(t, dt, 'brake', long < -th.brake * s, -long);
      this.sustained(t, dt, 'accel', long > th.accel * s, long);
      this.sustained(t, dt, 'turn', Math.abs(lat) > th.turn * s, Math.abs(lat));
    } else {
      this.sustained(t, dt, 'rough', mag > th.rough * s, mag);
    }
    this.sustained(t, dt, 'jerk', jerk > th.jerk * this.sens * this.roadMargin, jerk);
    if (this.movingSec > 60 && Math.sqrt(this.swayEma) > th.sway * this.sens) {
      this.emit(t, 'sway', Math.sqrt(this.swayEma));
    }
  }

  emit(t, type, value) {
    const last = this.lastEventT[type] ?? -Infinity;
    if (t - last < COOLDOWN[type]) return;
    this.lastEventT[type] = t;
    const event = { type, value, t: this.movingSec };
    this.events.push(event);
    this.onEvent(event);
  }

  addGps(t, speed) {
    if (speed === null || !Number.isFinite(speed)) return;
    this.gpsSeen = true;
    const s = Math.max(0, speed);

    if (this.lastGps) {
      const dt = t - this.lastGps.t;
      if (dt > 0 && dt < 10) this.distance += ((s + this.lastGps.s) / 2) * dt;
      if (dt >= 0.5 && dt <= 3 && this.gpsAccN > 0) {
        const dvdt = (s - this.lastGps.s) / dt;
        if (Math.abs(dvdt) > 0.3) {
          const meanH = scale(this.gpsAcc, 1 / this.gpsAccN);
          this.fwdS = add(this.fwdS, scale(meanH, dvdt));
          this.fwdN += dvdt * dvdt;
          this.fwdE += dot(meanH, meanH);
          this.fwdCount++;
          this.fwdDv += Math.abs(s - this.lastGps.s);
        }
      }
    }
    this.gpsAcc = [0, 0, 0];
    this.gpsAccN = 0;
    this.lastGps = { t, s };

    this.speed = s;
    this.speedT = t;

    if (s > 2) {
      this.lastFastT = t;
      this.stopHandled = false;
    } else if (s < 0.6 && !this.stopHandled && t - this.lastFastT < 8) {
      this.stopHandled = true;
      this.stops++;
      this.checkStop(t);
    }
  }

  // 停止の瞬間にブレーキの減速が急に抜けると、体が揺り戻される
  checkStop(t) {
    let maxDrop = 0;
    for (let i = 10; i < this.ring.length; i++) {
      const prev = this.ring[i - 10];
      const cur = this.ring[i];
      if (t - cur.t > 5 || prev.mag < 1) continue;
      const span = cur.t - prev.t;
      if (span > 0.2) maxDrop = Math.max(maxDrop, (prev.mag - cur.mag) / span);
    }
    if (maxDrop <= THRESHOLDS.stop * this.sens * this.roadMargin) return;

    // 同じ停止で出た躍度イベントは二重に数えない
    const lastJerk = this.lastEventT.jerk ?? -Infinity;
    if (t - lastJerk < 6) {
      const i = this.events.findLastIndex((e) => e.type === 'jerk');
      if (i >= 0) this.events.splice(i, 1);
    }
    this.emit(t, 'stop', maxDrop);
  }

  summary() {
    this.flushBucket();
    const counts = {};
    for (const e of this.events) counts[e.type] = (counts[e.type] ?? 0) + 1;

    const swayRms = this.movingSec > 0 ? Math.sqrt(this.swaySum / this.movingSec) : 0;
    const minutes = Math.max(this.movingSec / 60, 3);
    const weighted = this.events.reduce((sum, e) => sum + WEIGHTS[e.type], 0);
    const eventPenalty = Math.min((weighted / minutes) * 8, 60);
    const swayPenalty = clamp((swayRms - 0.25) / 0.75, 0, 1) * 40;

    return {
      score: Math.round(clamp(100 - eventPenalty - swayPenalty, 0, 100)),
      movingSec: this.movingSec,
      distance: this.distance,
      stops: this.stops,
      swayRms,
      dose: Math.sqrt(this.doseSum), // m/s^1.5（MSDV と同じ形の値）
      counts,
      events: this.events.slice(),
      buckets: this.buckets.slice(),
      pausedSec: this.pausedSec,
      phoneMoves: this.phoneMoves,
      gpsSeen: this.gpsSeen,
      forwardReady: this.forwardReady,
    };
  }
}
