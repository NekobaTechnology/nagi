import {
  BrakeLightDetector,
  LeadTracker,
  PerfStats,
  VEHICLE_LABELS,
  brakeLightScore,
  judgeSpeed,
  judgeThrottle,
} from './camera-core.js';

const TASKS_VERSION = '0.10.21';
const TASKS_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VERSION}`;
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite';

const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

let session = null;

function showError(text) {
  $('error').textContent = text;
  $('error').hidden = false;
  $('setup').hidden = false;
  $('running').hidden = true;
  $('result').hidden = true;
}

async function createDetector(preference) {
  const { FilesetResolver, ObjectDetector } = await import(`${TASKS_BASE}/vision_bundle.mjs`);
  const fileset = await FilesetResolver.forVisionTasks(`${TASKS_BASE}/wasm`);
  const create = (delegate) =>
    ObjectDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO',
      scoreThreshold: 0.35,
      maxResults: 15,
      categoryAllowlist: VEHICLE_LABELS,
    });
  if (preference !== 'auto') return { detector: await create(preference), backend: preference };
  try {
    return { detector: await create('GPU'), backend: 'GPU' };
  } catch {
    return { detector: await create('CPU'), backend: 'CPU' };
  }
}

function sourceSize(source) {
  return source.tagName === 'VIDEO'
    ? { width: source.videoWidth, height: source.videoHeight }
    : { width: source.naturalWidth, height: source.naturalHeight };
}

async function openCamera() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('カメラはHTTPSで開いたページでのみ使えます。https:// から始まるURLで開き直してください。');
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
  } catch (error) {
    if (error.name === 'NotAllowedError') {
      throw new Error('カメラの使用が許可されませんでした。ブラウザの設定で許可してから、もう一度お試しください。');
    }
    throw new Error('カメラを開けませんでした。ほかのアプリがカメラを使っていないか確認してください。');
  }
  const video = $('video');
  video.srcObject = stream;
  video.hidden = false;
  $('image').hidden = true;
  await video.play();
  return { source: video, label: 'カメラ', cleanup: () => stream.getTracks().forEach((t) => t.stop()) };
}

async function openFile(file) {
  const url = URL.createObjectURL(file);
  const cleanup = () => URL.revokeObjectURL(url);
  if (file.type.startsWith('image/')) {
    const image = $('image');
    image.src = url;
    image.hidden = false;
    $('video').hidden = true;
    await image.decode();
    return { source: image, label: '写真', cleanup };
  }
  const video = $('video');
  video.srcObject = null;
  video.src = url;
  video.loop = true;
  video.hidden = false;
  $('image').hidden = true;
  await video.play();
  return { source: video, label: '動画', cleanup };
}

function toBoxes(detections) {
  return detections.map((d) => ({
    x: d.boundingBox.originX,
    y: d.boundingBox.originY,
    w: d.boundingBox.width,
    h: d.boundingBox.height,
    label: d.categories[0]?.categoryName ?? '',
    score: d.categories[0]?.score ?? 0,
  }));
}

function drawOverlay(canvas, size, boxes, lead) {
  if (canvas.width !== size.width || canvas.height !== size.height) {
    canvas.width = size.width;
    canvas.height = size.height;
  }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const stroke = Math.max(2, size.width / 320);
  for (const box of boxes) {
    if (box === lead.box) continue;
    ctx.lineWidth = stroke;
    ctx.strokeStyle = css('--muted');
    ctx.strokeRect(box.x, box.y, box.w, box.h);
  }
  if (lead.box) {
    ctx.lineWidth = stroke * 2;
    ctx.strokeStyle = lead.status === 'closing' ? css('--bad') : css('--water');
    ctx.strokeRect(lead.box.x, lead.box.y, lead.box.w, lead.box.h);
  }
}

function describeLead(lead, brakeLit) {
  const el = $('leadStatus');
  const text = {
    none: '前の車なし',
    measuring: '前の車を測っています',
    lost: '前の車を見失いました',
    steady: '車間はほぼ一定',
    opening: '前の車が離れています',
    closing: `前の車に接近中（今のままなら約${Math.round(lead.secondsToReach ?? 0)}秒）`,
  }[lead.status];
  if (el.textContent !== text) el.textContent = text;
  el.dataset.level = lead.status === 'closing' ? 'warn' : '';
  $('brakeStatus').textContent = brakeLit ? 'ブレーキ灯らしき赤を検出（試験機能）' : '';
}

function readBrakeScore(session, box, source, size) {
  const { sampler } = session;
  const x = Math.max(0, box.x);
  const y = Math.max(0, box.y);
  const w = Math.min(size.width - x, box.w);
  const h = Math.min(size.height - y, box.h);
  if (w < 8 || h < 8) return 0;
  const ctx = sampler.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, x, y, w, h, 0, 0, sampler.width, sampler.height);
  return brakeLightScore(ctx.getImageData(0, 0, sampler.width, sampler.height).data, sampler.width, sampler.height);
}

function processFrame(current) {
  const { source, detector, stats, tracker, brake } = current;
  const size = sourceSize(source);
  if (!size.width) return;

  const started = performance.now();
  const { detections } = detector.detectForVideo(source, started);
  const latency = performance.now() - started;

  const t = started / 1000;
  const boxes = toBoxes(detections);
  const lead = tracker.update(t, boxes, size.width, size.height);
  const tracked = lead.status !== 'none' && lead.status !== 'lost';
  const brakeLit = tracked ? brake.update(t, readBrakeScore(current, lead.box, source, size)) : false;
  if (!tracked) brake.reset();
  if (brakeLit) current.brakeFrames++;
  if (lead.status === 'closing') current.closingFrames++;

  stats.add(t, latency, { vehicle: boxes.length > 0, lead: tracked });
  drawOverlay($('overlay'), size, boxes, lead);
  describeLead(lead, brakeLit);

  const { fps, latency: p50 } = stats.current;
  $('mFps').textContent = `${fps.toFixed(1)}回/秒`;
  $('mLatency').textContent = `${Math.round(p50)} ms`;
  const sec = Math.floor(t - stats.start);
  $('mElapsed').textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function scheduleLoop(current) {
  const { source } = current;
  const useVideoFrames = source.tagName === 'VIDEO' && 'requestVideoFrameCallback' in source;
  const tick = () => {
    if (session !== current) return;
    try {
      processFrame(current);
    } catch (error) {
      current.failure = error;
      stop();
      return;
    }
    if (useVideoFrames) source.requestVideoFrameCallback(tick);
    else requestAnimationFrame(tick);
  };
  if (useVideoFrames) source.requestVideoFrameCallback(tick);
  else requestAnimationFrame(tick);
}

async function requestWakeLock(current) {
  if (!('wakeLock' in navigator) || session !== current) return;
  try {
    current.wakeLock = await navigator.wakeLock.request('screen');
  } catch {
    // 拒否されても計測は続ける
  }
}

async function readBattery() {
  try {
    const battery = await navigator.getBattery();
    return { level: battery.level, charging: battery.charging };
  } catch {
    return null;
  }
}

async function start(openSource) {
  if (session) return;
  $('error').hidden = true;
  $('result').hidden = true;
  $('setup').hidden = true;
  $('running').hidden = false;
  $('leadStatus').textContent = '検出モデルを読み込み中';
  $('leadStatus').dataset.level = '';
  $('brakeStatus').textContent = '';
  $('mFps').textContent = '―';
  $('mLatency').textContent = '―';
  $('mElapsed').textContent = '0:00';
  $('mBackend').textContent = '―';
  $('stopBtn').disabled = true;

  let opened = null;
  try {
    opened = await openSource();
    const stage = $('stage');
    const size = sourceSize(opened.source);
    stage.style.aspectRatio = `${size.width} / ${size.height}`;
    const { detector, backend } = await createDetector($('delegate').value);
    const sampler = document.createElement('canvas');
    sampler.width = 48;
    sampler.height = 32;
    session = {
      ...opened,
      detector,
      backend,
      sampler,
      size,
      stats: new PerfStats(),
      tracker: new LeadTracker(),
      brake: new BrakeLightDetector(),
      brakeFrames: 0,
      closingFrames: 0,
      hiddenCount: 0,
      batteryStart: await readBattery(),
    };
  } catch (error) {
    opened?.cleanup();
    resetSource();
    showError(
      error.message?.match(/[ぁ-ん]/)
        ? error.message
        : '検出モデルを読み込めませんでした。通信状態を確認して、もう一度お試しください。',
    );
    return;
  }
  $('mBackend').textContent = session.backend;
  $('stopBtn').disabled = false;
  $('leadStatus').textContent = '前の車を探しています';
  requestWakeLock(session);
  scheduleLoop(session);
}

function resetSource() {
  const video = $('video');
  video.pause();
  video.srcObject = null;
  video.removeAttribute('src');
  video.load();
  $('image').removeAttribute('src');
  $('fileInput').value = '';
}

async function stop() {
  if (!session) return;
  const current = session;
  session = null;
  current.wakeLock?.release().catch(() => {});
  const batteryEnd = await readBattery();
  current.cleanup();
  current.detector.close();
  resetSource();
  if (current.failure) {
    showError(`処理中に止まりました（${current.backend}）。処理方式を変えて、もう一度お試しください。`);
    return;
  }
  renderResult(current, batteryEnd);
}

function renderResult(current, batteryEnd) {
  const s = current.stats.summary();
  const speed = judgeSpeed(s.fps);
  const throttle = judgeThrottle(s.minutes);

  const items = [
    ['処理速度', `${speed.text}（${s.fps.toFixed(1)}回/秒）`, speed.level],
    ['長時間の変化', throttle.text, throttle.level],
  ];
  $('verdict').replaceChildren(
    ...items.map(([name, value, level]) => {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = name;
      const strong = document.createElement('strong');
      strong.textContent = value;
      strong.dataset.level = level;
      li.append(label, strong);
      return li;
    }),
  );

  const lines = [
    'なぎ カメラ検証の結果',
    `日時: ${new Date().toLocaleString('ja-JP')}`,
    `端末: ${navigator.userAgent}`,
    `入力: ${current.label} ${current.size.width}x${current.size.height}`,
    `処理方式: ${current.backend}`,
    `モデル: EfficientDet-Lite0 float16 / tasks-vision ${TASKS_VERSION}`,
    `計測時間: ${Math.round(s.elapsed)}秒 (${s.frames}フレーム)`,
    `更新回数: ${s.fps.toFixed(1)}回/秒`,
    `1回の処理: 中央値 ${s.p50.toFixed(0)} ms / 95%点 ${s.p95.toFixed(0)} ms`,
    `車を検出した割合: ${(s.vehicleRate * 100).toFixed(0)}%`,
    `前の車を捉えた割合: ${(s.leadRate * 100).toFixed(0)}%`,
    `接近と判定した割合: ${s.frames ? ((current.closingFrames / s.frames) * 100).toFixed(0) : 0}%`,
    `ブレーキ灯らしき判定の割合: ${s.frames ? ((current.brakeFrames / s.frames) * 100).toFixed(0) : 0}%`,
  ];
  if (current.hiddenCount > 0) {
    lines.push(`注意: 計測中に画面が${current.hiddenCount}回隠れました。隠れている間は処理が止まるため、更新回数は実力より低く出ます。`);
  }
  if (throttle.drop !== null) lines.push(`序盤から終盤への速度低下: ${(throttle.drop * 100).toFixed(0)}%`);
  if (current.batteryStart && batteryEnd) {
    lines.push(
      `電池: ${Math.round(current.batteryStart.level * 100)}% → ${Math.round(batteryEnd.level * 100)}%（${batteryEnd.charging ? '充電中' : '充電なし'}）`,
    );
  }
  if (s.minutes.length) {
    lines.push('', '分ごとの推移');
    for (const m of s.minutes) {
      lines.push(`${m.minute + 1}分目: ${m.fps.toFixed(1)}回/秒 中央値 ${m.p50.toFixed(0)} ms`);
    }
  }
  $('report').textContent = lines.join('\n');

  $('running').hidden = true;
  $('result').hidden = false;
  window.scrollTo(0, 0);
}

$('startCamera').addEventListener('click', () => start(openCamera));
$('fileInput').addEventListener('change', (event) => {
  const [file] = event.target.files;
  if (file) start(() => openFile(file));
});
$('stopBtn').addEventListener('click', stop);
$('againBtn').addEventListener('click', () => {
  $('result').hidden = true;
  $('setup').hidden = false;
  window.scrollTo(0, 0);
});
$('copyBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('report').textContent);
    $('copyBtn').textContent = 'コピーしました';
  } catch {
    getSelection().selectAllChildren($('report'));
    $('copyBtn').textContent = '選択しました。コピーしてください';
  }
});
document.addEventListener('visibilitychange', () => {
  if (!session) return;
  if (document.visibilityState === 'visible') requestWakeLock(session);
  else session.hiddenCount++;
});
