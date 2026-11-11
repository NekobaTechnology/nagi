// なぎ カメラ検証版: 前の車の判定と処理速度の集計（DOM非依存）

export const VEHICLE_LABELS = ['car', 'truck', 'bus', 'motorcycle'];

// 検証用の初期値。実走行の映像で調整する
const CLOSING_GROWTH = 0.12; // 幅が毎秒12%増える＝今の速度差のままなら約8秒で追いつく
const CLOSING_HOLD = 0.4;
const HISTORY_SEC = 1.5;
const MIN_SPAN_SEC = 0.7;
const MIN_SAMPLES = 4;
const LOST_GRACE_SEC = 0.5;

// 検出する範囲を決める。モデルは正方形に縮めて処理するので、
// 中央を正方形に切り出すと車が潰れず、遠くの車も大きく写る
export function cropRegion(width, height, mode = 'center', position = 0.5) {
  if (mode === 'full') return { x: 0, y: 0, w: width, h: height };
  const side = Math.min(width, height);
  return {
    x: Math.round((width - side) / 2),
    y: Math.round((height - side) * Math.min(1, Math.max(0, position))),
    w: side,
    h: side,
  };
}

// 端末が対応しているピントの設定だけを組み立てる。座標は映像全体を 0〜1 で表す
export function focusConstraints(capabilities = {}, supported = {}, point = { x: 0.5, y: 0.5 }) {
  const constraints = {};
  if (capabilities.focusMode?.includes('continuous')) constraints.focusMode = 'continuous';
  if (supported.pointsOfInterest) {
    constraints.pointsOfInterest = [
      { x: Math.min(1, Math.max(0, point.x)), y: Math.min(1, Math.max(0, point.y)) },
    ];
  }
  return constraints;
}

export function iou(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

// 前の車は、画面の中央付近で足元が見えている、いちばん大きな車とする
// corridor を渡すと、画面の中央ではなく自分の車線の中にいる車から選ぶ
export function pickLead(allBoxes, width, height, previous = null, corridor = null) {
  // 突然現れる範囲いっぱいの枠は、ダッシュボードやボンネットを車と誤認したもの。
  // 追跡中の車が近づいて大きくなった枠は残す
  const boxes = allBoxes.filter(
    (box) =>
      (box.w <= width * 0.8 || (previous && iou(box, previous) > 0.3)) &&
      (!corridor || corridor(box.x + box.w / 2, box.y + box.h)),
  );
  if (previous) {
    let best = null;
    let bestOverlap = 0.3;
    for (const box of boxes) {
      const overlap = iou(box, previous);
      if (overlap > bestOverlap) {
        best = box;
        bestOverlap = overlap;
      }
    }
    if (best) return best;
  }
  let lead = null;
  for (const box of boxes) {
    const center = box.x + box.w / 2;
    const bottom = box.y + box.h;
    if (!corridor && (center < width * 0.25 || center > width * 0.75)) continue;
    if (bottom < height * 0.35) continue;
    if (!lead || box.w * box.h > lead.w * lead.h) lead = box;
  }
  return lead;
}

// 見かけの幅の増え方から、距離が縮まる速さを求める。距離や車速は使わない
function growthRate(history) {
  const n = history.length;
  const meanT = history.reduce((sum, p) => sum + p.t, 0) / n;
  const meanY = history.reduce((sum, p) => sum + Math.log(p.w), 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (const p of history) {
    numerator += (p.t - meanT) * (Math.log(p.w) - meanY);
    denominator += (p.t - meanT) ** 2;
  }
  return denominator > 0 ? numerator / denominator : 0;
}

export class LeadTracker {
  constructor() {
    this.reset();
  }

  reset() {
    this.box = null;
    this.history = [];
    this.lastSeen = -Infinity;
    this.closingSince = null;
  }

  update(t, boxes, width, height, corridor = null) {
    if (this.history.length && t - this.lastSeen > LOST_GRACE_SEC) this.reset();

    // 白線の誤検出で前の車を見失わないよう、車線内にいなければ通常の判定に戻す
    const lead =
      pickLead(boxes, width, height, this.box, corridor) ??
      (corridor ? pickLead(boxes, width, height, this.box) : null);
    if (!lead) {
      if (!this.box) return { box: null, status: 'none', growth: 0, secondsToReach: null };
      return { box: this.box, status: 'lost', growth: 0, secondsToReach: null };
    }

    this.box = lead;
    this.lastSeen = t;
    this.history.push({ t, w: lead.w });
    while (this.history.length && t - this.history[0].t > HISTORY_SEC) this.history.shift();

    const span = t - this.history[0].t;
    if (this.history.length < MIN_SAMPLES || span < MIN_SPAN_SEC) {
      return { box: lead, status: 'measuring', growth: 0, secondsToReach: null };
    }

    const growth = growthRate(this.history);
    let status = 'steady';
    if (growth > CLOSING_GROWTH) {
      this.closingSince ??= t;
      if (t - this.closingSince >= CLOSING_HOLD) status = 'closing';
    } else {
      this.closingSince = null;
      if (growth < -CLOSING_GROWTH) status = 'opening';
    }
    return {
      box: lead,
      status,
      growth,
      secondsToReach: status === 'closing' ? 1 / growth : null,
    };
  }
}

// ブレーキ灯の手がかりを2つ返す。
// highMount: 枠の上部中央で補助ブレーキ灯（ハイマウントストップランプ）が光っている割合。昼に効く。
//   左右の尾灯は昼でも点いている車が多く、明るさの差では区別できなかった
// red: 枠全体で赤く光っている割合。夜はブレーキ灯の光が車全体ににじむので、急に増える
const HIGH_MOUNT = { top: 0.25, left: 0.25, right: 0.75 };
const RED_BODY_SHARE = 0.25; // 上部中央がこれより広く赤いのは、灯ではなく赤い車体かにじみ
const EDGE = 2; // 枠の縁は背景が混ざるので数えない（補助ブレーキ灯は上端近くにあるので上の1行だけ外す）

function isLampRed(r, g, b) {
  return r > 130 && r - b > 60 && r - g > 30;
}

export function brakeLightScore(rgba, width, height) {
  const top = Math.round(height * HIGH_MOUNT.top);
  const x0 = Math.floor(width * HIGH_MOUNT.left);
  const x1 = Math.ceil(width * HIGH_MOUNT.right);
  let mountTotal = 0;
  let mountLit = 0;
  let total = 0;
  let lit = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const red = isLampRed(rgba[i], rgba[i + 1], rgba[i + 2]);
      if (y >= 1 && y < top && x >= x0 && x < x1) {
        mountTotal++;
        if (red) mountLit++;
      }
      if (y >= EDGE && y < height - EDGE && x >= EDGE && x < width - EDGE) {
        total++;
        if (red) lit++;
      }
    }
  }
  const mount = mountTotal ? mountLit / mountTotal : 0;
  return {
    highMount: mount > RED_BODY_SHARE ? 0 : mount,
    red: total ? lit / total : 0,
  };
}

const HIGH_MOUNT_THRESHOLD = 0.01;
const RED_JUMP = 0.25; // 普段より枠の4分の1以上が赤く光ったら、夜のブレーキとみなす
// 普段の赤さは、下がるときは速く、上がるときはゆっくり追う。赤い車に替わったときなどに合わせる
const RED_BASELINE_DOWN_SEC = 0.3;
const RED_BASELINE_UP_SEC = 3;
// 点灯中もごくゆっくり追い、赤いネオンなどで点灯したまま戻らなくなるのを防ぐ
const RED_BASELINE_LIT_SEC = 30;
const BRAKE_HOLD_SEC = 0.25; // 一瞬の反射で切り替わらないよう、続いたときだけ切り替える

export class BrakeLightDetector {
  constructor() {
    this.reset();
  }

  // 前の車が替わったら呼ぶ。赤い車は普段から赤いので、車ごとに普段の値を測り直す
  reset() {
    this.lit = false;
    this.changeSince = null;
    this.redBaseline = null;
    this.lastT = null;
  }

  update(t, score) {
    const { highMount, red } = score;
    if (this.redBaseline === null) this.redBaseline = red;
    const now = highMount >= HIGH_MOUNT_THRESHOLD || red >= this.redBaseline + RED_JUMP;

    if (now === this.lit) {
      this.changeSince = null;
    } else {
      this.changeSince ??= t;
      if (t - this.changeSince >= BRAKE_HOLD_SEC) {
        this.lit = now;
        this.changeSince = null;
      }
    }
    if (this.lastT !== null) {
      const dt = Math.max(0, t - this.lastT);
      let tau = red < this.redBaseline ? RED_BASELINE_DOWN_SEC : RED_BASELINE_UP_SEC;
      if (now) tau = RED_BASELINE_LIT_SEC;
      this.redBaseline += (red - this.redBaseline) * (1 - Math.exp(-dt / tau));
    }
    this.lastT = t;
    return this.lit;
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

// 1分ごとに集計し、時間とともに遅くならないかを見る
export class PerfStats {
  constructor() {
    this.start = null;
    this.frames = 0;
    this.withVehicle = 0;
    this.withLead = 0;
    this.all = [];
    this.recent = [];
    this.minutes = [];
  }

  add(t, latencyMs, { vehicle = false, lead = false } = {}) {
    this.start ??= t;
    this.frames++;
    if (vehicle) this.withVehicle++;
    if (lead) this.withLead++;
    this.all.push(latencyMs);
    this.recent.push({ t, latencyMs });
    while (this.recent.length && t - this.recent[0].t > 5) this.recent.shift();

    const minute = Math.floor((t - this.start) / 60);
    const bucket = (this.minutes[minute] ??= { minute, frames: 0, latencies: [], first: t, last: t });
    bucket.frames++;
    bucket.last = t;
    bucket.latencies.push(latencyMs);
    this.lastT = t;
  }

  get current() {
    if (this.recent.length < 2) return { fps: 0, latency: 0 };
    const span = this.recent.at(-1).t - this.recent[0].t;
    const sorted = this.recent.map((r) => r.latencyMs).sort((a, b) => a - b);
    return {
      fps: span > 0 ? (this.recent.length - 1) / span : 0,
      latency: percentile(sorted, 0.5),
    };
  }

  summary() {
    const elapsed = this.frames > 1 ? this.lastT - this.start : 0;
    const sorted = [...this.all].sort((a, b) => a - b);
    const minutes = this.minutes.filter(Boolean).map((b) => {
      const s = [...b.latencies].sort((x, y) => x - y);
      const span = b.last - b.first;
      return { minute: b.minute, fps: span > 0 ? (b.frames - 1) / span : 0, p50: percentile(s, 0.5) };
    });
    return {
      elapsed,
      frames: this.frames,
      fps: elapsed > 0 ? (this.frames - 1) / elapsed : 0,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      vehicleRate: this.frames ? this.withVehicle / this.frames : 0,
      leadRate: this.frames ? this.withLead / this.frames : 0,
      minutes,
    };
  }
}

// 判定の目安。接近の計算には毎秒5回以上の更新がほしい
export function judgeSpeed(fps) {
  if (fps >= 10) return { level: 'good', text: '余裕あり' };
  if (fps >= 5) return { level: 'ok', text: '使えそう' };
  return { level: 'bad', text: '不足' };
}

// 先頭の1分と最後の完了した1分を比べる。ブラウザからは温度を読めないための代用
export function judgeThrottle(minutes) {
  const complete = minutes.slice(0, -1);
  if (complete.length < 3) return { level: 'unknown', text: '判定には4分以上の計測が必要', drop: null };
  const first = complete[0].fps;
  const last = complete.at(-1).fps;
  const drop = first > 0 ? 1 - last / first : 0;
  if (drop > 0.3) return { level: 'bad', text: '処理速度が落ちています（発熱の可能性）', drop };
  if (drop > 0.15) return { level: 'ok', text: 'やや落ちています', drop };
  return { level: 'good', text: '大きな低下なし', drop };
}

// 走行中だけ、前の車への接近を声で先に伝える。同じ知らせを繰り返さない
// ブレーキ灯の判定は誤検知が多かったため、走行画面では使わない（検証画面でのみ表示）
export const ADVISE_MIN_SPEED = 15 / 3.6; // 渋滞や信号待ちの発進では鳴らさない
const ADVISE_CLOSING_SECONDS = 5; // 追いつくまでの見込みがこれより短いときだけ伝える
const ADVISE_COOLDOWN = 12;

export class LookaheadAdvisor {
  constructor() {
    this.reset();
  }

  reset() {
    this.wasClosing = false;
    this.lastAt = -Infinity;
  }

  // moving: 走行中か。lead は前の車の判定結果。知らせる種類か null を返す
  update(t, { moving, lead }) {
    const tracked = lead && lead.status !== 'none' && lead.status !== 'lost';
    const closing = Boolean(
      tracked && lead.status === 'closing' && lead.secondsToReach !== null && lead.secondsToReach <= ADVISE_CLOSING_SECONDS,
    );
    const started = closing && !this.wasClosing;
    this.wasClosing = closing;
    if (!moving || !started || t - this.lastAt < ADVISE_COOLDOWN) return null;
    this.lastAt = t;
    return 'closing';
  }
}
