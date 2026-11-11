// なぎ: 走行画面のカメラ先読み。前の車を追い、ブレーキ灯と接近を毎フレーム知らせる
import { BrakeLightDetector, LeadTracker, cropRegion } from './camera-core.js';
import {
  LENS_KEY,
  createCrop,
  createDetector,
  createSampler,
  detectVehicles,
  loadPosition,
  readBrakeScore,
  sourceSize,
} from './vision.js';

const MIN_INTERVAL_MS = 100; // 発熱を抑えるため、毎秒10回までにする

function savedLens() {
  try {
    return localStorage.getItem(LENS_KEY) || '';
  } catch {
    return '';
  }
}

function requestStream(deviceId = null) {
  const size = { width: { ideal: 1280 }, height: { ideal: 720 } };
  const lens = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } };
  return navigator.mediaDevices.getUserMedia({ audio: false, video: { ...lens, ...size } });
}

export class CameraLookahead {
  // onFrame(t, { lead, brakeLit }) は検出のたびに呼ばれる
  constructor(video, onFrame) {
    this.video = video;
    this.onFrame = onFrame;
    this.stream = null;
    this.detector = null;
    this.running = false;
    this.frames = 0;
    this.startedAt = 0;
    this.timer = null;
  }

  // カメラの許可は、走行開始のボタン操作の中で求める
  async openCamera() {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('カメラはHTTPSで開いたページでのみ使えます。');
    }
    try {
      this.stream = await requestStream();
    } catch (error) {
      throw new Error(
        error.name === 'NotAllowedError'
          ? 'カメラの使用が許可されませんでした。揺れの計測だけ続けます。'
          : 'カメラを開けませんでした。揺れの計測だけ続けます。',
      );
    }
    await this.useSavedLens();
    this.video.srcObject = this.stream;
    await this.video.play();
  }

  // 検証画面で選んだレンズがあれば、それに切り替える
  async useSavedLens() {
    const label = savedLens();
    const current = this.stream.getVideoTracks()[0];
    if (!label || current?.label === label) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const match = devices.find((d) => d.kind === 'videoinput' && d.label === label);
      if (!match) return;
      const next = await requestStream(match.deviceId);
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = next;
    } catch {
      // 切り替えられなくても、最初に開いたレンズで続ける
    }
  }

  async start() {
    const { detector } = await createDetector('auto');
    if (!this.stream) {
      detector.close();
      return;
    }
    this.detector = detector;
    this.crop = createCrop();
    this.sampler = createSampler();
    this.tracker = new LeadTracker();
    this.brake = new BrakeLightDetector();
    this.position = loadPosition();
    this.running = true;
    this.startedAt = performance.now();
    this.schedule();
  }

  // 映像の描画の合図に頼ると、表示が止まったときに先読みも止まるので、時間で回す
  schedule() {
    const tick = () => {
      if (!this.running) return;
      const started = performance.now();
      try {
        this.process(started);
      } catch {
        // 一時的な失敗では止めず、次の回でやり直す
      }
      const spent = performance.now() - started;
      this.timer = setTimeout(tick, Math.max(0, MIN_INTERVAL_MS - spent));
    };
    tick();
  }

  process(now) {
    const size = sourceSize(this.video);
    if (!size.width || this.video.readyState < 2) return;
    const region = cropRegion(size.width, size.height, 'center', this.position);
    const boxes = detectVehicles(this.detector, this.video, region, this.crop, now);
    const t = now / 1000;
    const lead = this.tracker.update(t, boxes, region.w, region.h);
    const tracked = lead.status !== 'none' && lead.status !== 'lost';
    const brakeLit = tracked
      ? this.brake.update(t, readBrakeScore(this.sampler, lead.box, this.video, size, region))
      : false;
    // 夜はブレーキ灯のにじみで一瞬見失いやすい。その間も同じ車の普段の赤さを保つ
    if (lead.status === 'none') this.brake.reset();
    this.frames++;
    this.onFrame(t, { lead, brakeLit });
  }

  get fps() {
    const sec = (performance.now() - this.startedAt) / 1000;
    return this.running && sec > 0 ? this.frames / sec : 0;
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.detector?.close();
    this.detector = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }
}
