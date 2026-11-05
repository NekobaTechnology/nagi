// なぎ カメラ検証版: 白線の検出（DOM非依存）
//
// 路面の帯だけを小さく切り出して処理する。線は x = a * y + b で表す。
// 画像の y は下向きなので、左の白線は a < 0、右の白線は a > 0 になる。

// 実走行で調整する前の初期値
const SCALES = [2, 3, 5, 8, 12];
const MIN_CONTRAST = 14;
const MIN_ABOVE_ROAD = 8;
const SLOPE_MIN = 0.03; // 望遠では白線がほぼ垂直に写る
const SLOPE_MAX = 4;
const RANSAC_TRIES = 150;
const ACCUMULATE_SEC = 0.4; // 破線でも線がつながるよう、少しの間の点をまとめる
const HOLD_SEC = 1;
const SMOOTHING = 0.35;
const CURVE_THRESHOLD = 0.08;

export function toGray(rgba, width, height) {
  const gray = new Uint8ClampedArray(width * height);
  for (let i = 0; i < gray.length; i++) {
    const p = i * 4;
    gray[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
  }
  return gray;
}

function rowMedian(gray, offset, width) {
  const sample = [];
  for (let x = 0; x < width; x += 4) sample.push(gray[offset + x]);
  sample.sort((a, b) => a - b);
  return sample[sample.length >> 1];
}

// 各行で「両隣より明るい細い帯」を探す。広い明るい面の縁は片側が明るいので拾わない
export function detectLaneMarks(gray, width, height, masks = []) {
  const points = [];
  const prefix = new Float64Array(width + 1);
  const response = new Float32Array(width);
  const levels = new Uint8ClampedArray(width);

  for (let y = 0; y < height; y++) {
    const offset = y * width;
    for (let x = 0; x < width; x++) prefix[x + 1] = prefix[x] + gray[offset + x];
    response.fill(0);
    for (const w of SCALES) {
      for (let x = w; x + 2 * w <= width; x++) {
        const center = (prefix[x + w] - prefix[x]) / w;
        const left = (prefix[x] - prefix[x - w]) / w;
        const right = (prefix[x + 2 * w] - prefix[x + w]) / w;
        const value = center - Math.max(left, right);
        const middle = x + (w >> 1);
        if (value > response[middle]) {
          response[middle] = value;
          levels[middle] = center;
        }
      }
    }
    const median = rowMedian(gray, offset, width);
    for (let x = 3; x < width - 3; x++) {
      const value = response[x];
      if (value < MIN_CONTRAST || levels[x] < median + MIN_ABOVE_ROAD) continue;
      let peak = true;
      for (let k = 1; k <= 3 && peak; k++) {
        if (response[x - k] > value || response[x + k] >= value) peak = false;
      }
      if (!peak) continue;
      if (masks.some((m) => x >= m.x && x <= m.x + m.w && y >= m.y && y <= m.y + m.h)) continue;
      points.push({ x, y });
    }
  }
  return points;
}

function random(seed) {
  let x = seed;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

function refine(inliers) {
  const n = inliers.length;
  const my = inliers.reduce((sum, p) => sum + p.y, 0) / n;
  const mx = inliers.reduce((sum, p) => sum + p.x, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of inliers) {
    num += (p.y - my) * (p.x - mx);
    den += (p.y - my) ** 2;
  }
  const a = den > 0 ? num / den : 0;
  return { a, b: mx - a * my };
}

// sign は左の白線が -1、右の白線が 1。候補が複数あれば自車に近い線を選ぶ
export function fitLaneLine(points, sign, width, height, rng, previousBottomX = null) {
  if (points.length < 2) return null;
  const tolerance = Math.max(2, height * 0.025);
  const bottom = height - 1;
  const candidates = [];

  for (let i = 0; i < RANSAC_TRIES; i++) {
    const p = points[Math.floor(rng() * points.length)];
    const q = points[Math.floor(rng() * points.length)];
    if (Math.abs(p.y - q.y) < height * 0.15) continue;
    const a = (p.x - q.x) / (p.y - q.y);
    if (a * sign <= 0 || Math.abs(a) < SLOPE_MIN || Math.abs(a) > SLOPE_MAX) continue;
    const b = p.x - a * p.y;
    // 左の線は画面の左寄り、右の線は右寄りに来る。電柱や車の縦の輪郭を除ける
    if ((a * bottom + b - width / 2) * sign < -width * 0.1) continue;
    const inliers = points.filter((r) => Math.abs(a * r.y + b - r.x) <= tolerance);
    const rows = new Set(inliers.map((r) => r.y)).size;
    candidates.push({ a, b, inliers, rows });
  }
  if (!candidates.length) return null;

  const most = Math.max(...candidates.map((c) => c.rows));
  const target = previousBottomX ?? width / 2;
  const strong = candidates.filter((c) => c.rows >= most * 0.6);
  const chosen = strong.reduce((best, c) =>
    Math.abs(c.a * bottom + c.b - target) < Math.abs(best.a * bottom + best.b - target) ? c : best,
  );

  const ys = chosen.inliers.map((r) => r.y);
  const span = Math.max(...ys) - Math.min(...ys);
  if (chosen.rows < Math.max(6, height * 0.2) || span < height * 0.3) return null;

  const line = refine(chosen.inliers);
  if (line.a * sign <= 0) return null;
  return line;
}

export const lineX = (line, y) => line.a * y + line.b;

// 切り出した帯の座標から映像全体の座標へ変える。s は帯の1画素が映像の何画素か
export function lineToSource(line, roi) {
  return { a: line.a, b: roi.x + roi.scale * line.b - line.a * roi.y };
}

// 2本の白線の間にあるかを返す。線より少し外まで許す
export function inLane(left, right, x, y) {
  const xLeft = lineX(left, y);
  const xRight = lineX(right, y);
  if (xRight <= xLeft) return false;
  const margin = (xRight - xLeft) * 0.05;
  return x >= xLeft - margin && x <= xRight + margin;
}

export class LaneTracker {
  constructor() {
    this.reset();
  }

  reset() {
    this.frames = [];
    this.left = null;
    this.right = null;
    this.rng = random(12345);
    this.baselineVp = null;
    this.curveValue = 0;
    this.lastT = null;
  }

  smooth(state, fit, t, bottom) {
    if (!fit) return state && t - state.t <= HOLD_SEC ? state : null;
    const x0 = lineX(fit, bottom);
    if (!state || t - state.t > HOLD_SEC) return { a: fit.a, x0, b: fit.b, t };
    const a = state.a + (fit.a - state.a) * SMOOTHING;
    const x = state.x0 + (x0 - state.x0) * SMOOTHING;
    return { a, x0: x, b: x - a * bottom, t };
  }

  update(t, gray, width, height, masks = []) {
    const bottom = height - 1;
    const marks = detectLaneMarks(gray, width, height, masks);
    this.frames.push({ t, marks });
    while (this.frames.length && t - this.frames[0].t > ACCUMULATE_SEC) this.frames.shift();
    const points = this.frames.flatMap((f) => f.marks);

    const leftFit = fitLaneLine(points, -1, width, height, this.rng, this.left?.x0 ?? null);
    const rightFit = fitLaneLine(points, 1, width, height, this.rng, this.right?.x0 ?? null);
    this.left = this.smooth(this.left, leftFit, t, bottom);
    this.right = this.smooth(this.right, rightFit, t, bottom);

    // 左右が入れ替わる形は誤検出なので、確度の低い古いほうを捨てる
    if (this.left && this.right && this.left.x0 >= this.right.x0) {
      if (this.left.t >= this.right.t) this.right = null;
      else this.left = null;
    }

    const status = this.left && this.right ? 'both' : this.left ? 'left' : this.right ? 'right' : 'none';
    const curve = status === 'both' ? this.updateCurve(t, width) : 'unknown';
    if (status !== 'both') this.lastT = null;

    return {
      status,
      left: this.left && { a: this.left.a, b: this.left.b },
      right: this.right && { a: this.right.a, b: this.right.b },
      curve,
      marks: marks.length,
    };
  }

  // 2本の線が交わる点の横位置で曲がりを見る。基準は取り付け角の差を吸収するため走りながら更新する
  updateCurve(t, width) {
    const { left, right } = this;
    const y = (right.b - left.b) / (left.a - right.a);
    const vp = (lineX(left, y) - width / 2) / width;
    const dt = this.lastT === null ? 0 : Math.max(0, t - this.lastT);
    this.lastT = t;
    if (this.baselineVp === null) {
      this.baselineVp = vp;
      this.curveValue = 0;
      return 'straight';
    }
    this.baselineVp += (vp - this.baselineVp) * (1 - Math.exp(-dt / 60));
    this.curveValue += (vp - this.baselineVp - this.curveValue) * (1 - Math.exp(-dt / 0.4));
    if (this.curveValue > CURVE_THRESHOLD) return 'right';
    if (this.curveValue < -CURVE_THRESHOLD) return 'left';
    return 'straight';
  }
}
