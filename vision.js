// なぎ: カメラ映像から車を検出し、ブレーキ灯の手がかりを読む（検証画面と走行画面で共通）
import { VEHICLE_LABELS, brakeLightScore } from './camera-core.js';

export const TASKS_VERSION = '0.10.21';
const TASKS_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VERSION}`;
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite';
export const MODEL_LABEL = `EfficientDet-Lite0 float16 / tasks-vision ${TASKS_VERSION}`;

export const CROP_SIZE = 640;
export const POSITION_KEY = 'nagi.camera.position';
export const LENS_KEY = 'nagi.camera.lens';
export const DEFAULT_POSITION = 0; // 縦向きの車載では、下側にダッシュボードが写り道路は上側に来る

export async function createDetector(preference = 'auto') {
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

export function sourceSize(source) {
  return source.tagName === 'VIDEO'
    ? { width: source.videoWidth, height: source.videoHeight }
    : { width: source.naturalWidth, height: source.naturalHeight };
}

export function loadPosition() {
  try {
    const raw = localStorage.getItem(POSITION_KEY);
    const value = Number(raw);
    return raw !== null && Number.isFinite(value) ? value : DEFAULT_POSITION;
  } catch {
    return DEFAULT_POSITION;
  }
}

// 検出範囲を切り出して検出し、枠を検出範囲の座標で返す
export function detectVehicles(detector, source, region, crop, timestamp) {
  let input = source;
  let ratio = 1;
  if (crop) {
    crop.getContext('2d').drawImage(source, region.x, region.y, region.w, region.h, 0, 0, CROP_SIZE, CROP_SIZE);
    input = crop;
    ratio = region.w / CROP_SIZE;
  }
  const { detections } = detector.detectForVideo(input, timestamp);
  return detections.map((d) => ({
    x: d.boundingBox.originX * ratio,
    y: d.boundingBox.originY * ratio,
    w: d.boundingBox.width * ratio,
    h: d.boundingBox.height * ratio,
    label: d.categories[0]?.categoryName ?? '',
    score: d.categories[0]?.score ?? 0,
  }));
}

export function createSampler() {
  const sampler = document.createElement('canvas');
  sampler.width = 48;
  sampler.height = 32;
  return sampler;
}

export function createCrop() {
  const crop = document.createElement('canvas');
  crop.width = CROP_SIZE;
  crop.height = CROP_SIZE;
  return crop;
}

// 前の車の枠を小さく縮めて、ブレーキ灯の手がかりを読む
export function readBrakeScore(sampler, box, source, size, region) {
  const x = Math.max(0, region.x + box.x);
  const y = Math.max(0, region.y + box.y);
  const w = Math.min(size.width - x, box.w);
  const h = Math.min(size.height - y, box.h);
  if (w < 8 || h < 8) return { highMount: 0, red: 0 };
  const ctx = sampler.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, x, y, w, h, 0, 0, sampler.width, sampler.height);
  return brakeLightScore(ctx.getImageData(0, 0, sampler.width, sampler.height).data, sampler.width, sampler.height);
}
