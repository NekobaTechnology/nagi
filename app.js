import { ADVISE_MIN_SPEED, LookaheadAdvisor } from './camera-core.js';
import { RideEngine, SENSITIVITY } from './engine.js';
import { simulate } from './sim.js';

const $ = (id) => document.getElementById(id);

// 操作ごとの表示名、走行中の声かけ、走行後の助言
const COPY = {
  brake: {
    name: '急なブレーキ',
    say: 'ブレーキは早めに、じわっと',
    tip: '前の車や信号を遠くまで見て、早めにブレーキを踏み始めましょう。弱い力で長くかけると揺れが減ります。',
  },
  accel: {
    name: '急な発進・加速',
    say: 'アクセルはゆっくりと',
    tip: '踏み始めの1〜2秒をゆっくりにすると、体が後ろへ押される感覚が減ります。',
  },
  turn: {
    name: 'カーブでの強い横揺れ',
    say: 'カーブは手前で減速を',
    tip: 'カーブに入る前に減速を終え、ハンドルは一定の速さで切りましょう。',
  },
  rough: {
    name: '大きな揺れ',
    say: '揺れが大きくなっています',
    tip: 'ブレーキ、アクセル、ハンドルをそれぞれ少しずつ操作しましょう。',
  },
  jerk: {
    name: '急なペダル・ハンドル操作',
    say: '操作をなめらかに',
    tip: '踏み込むときと戻すときの速さを意識すると、揺れの変わり目がやわらぎます。',
  },
  stop: {
    name: '停止時のカックン',
    say: '止まる直前はブレーキを少しゆるめて',
    tip: '止まる直前にブレーキを少しゆるめると、停止の瞬間の揺り戻しが減ります。',
  },
  sway: {
    name: '揺れの繰り返し',
    say: '速度の波が続いています。一定のペースで',
    tip: '加速と減速を繰り返す揺れは酔いにつながりやすいです。車間を広めにとり、速度を一定に保ちましょう。',
  },
};
// カメラ先読みの知らせ。運転の採点には含めない
const LOOK_COPY = {
  leadBrake: { name: '前の車のブレーキ', say: '前の車がブレーキ' },
  closing: { name: '前の車への接近', say: '前の車に近づいています' },
};
const PRAISE = 'なめらかな運転が続いています';
const VOICE_INTERVAL = 20;
const URGENT_VOICE_INTERVAL = 3; // 先読みの知らせは間隔を詰める。遅れて伝えても意味がないため
const CHIME_INTERVAL = 4;
const PRAISE_INTERVAL = 300;
const HISTORY_KEY = 'nagi.history';
const SETTINGS_KEY = 'nagi.settings';

function load(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 保存できない環境でも走行は続ける
  }
}

const settings = { sound: 'voice', sens: 'normal', camera: 'off', ...load(SETTINGS_KEY, {}) };
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/* ---------- 音 ---------- */
let audio = null;
let lastVoice = -Infinity;
let lastChime = -Infinity;

function unlockAudio() {
  // iOS は操作の中で一度鳴らしておかないと、後から音を出せない
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    audio.resume();
  } catch {
    audio = null;
  }
  if ('speechSynthesis' in window) {
    const silent = new SpeechSynthesisUtterance(' ');
    silent.volume = 0;
    speechSynthesis.speak(silent);
  }
}

function chime() {
  const now = performance.now() / 1000;
  if (!audio || settings.sound === 'off' || now - lastChime < CHIME_INTERVAL) return;
  lastChime = now;
  [659, 523].forEach((freq, i) => {
    const start = audio.currentTime + i * 0.16;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.22, start + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.4);
    osc.connect(gain).connect(audio.destination);
    osc.start(start);
    osc.stop(start + 0.42);
  });
}

function speak(text, urgent = false) {
  const now = performance.now() / 1000;
  if (settings.sound !== 'voice' || !('speechSynthesis' in window)) return;
  if (now - lastVoice < (urgent ? URGENT_VOICE_INTERVAL : VOICE_INTERVAL)) return;
  lastVoice = now;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ja-JP';
  u.rate = 1.05;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

/* ---------- コップの描画 ---------- */
function fitCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const w = Math.round(rect.width * dpr);
  const h = Math.round(rect.height * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return { w, h };
}

// 運転席から少し見下ろした立体のコップ。画面の左右が車の左右、奥が車の前
// tilt.x は左右の揺れ、tilt.z は前後の揺れによる水面の傾き（ラジアン）。
// 正の tilt.x で右側が下がり、正の tilt.z で奥側が上がる
const RIM = 0.26; // 縁の楕円のつぶれ具合。小さいほど真横から見た形になる

function drawGlass(canvas, tilt, color, phase = 0, shake = 0) {
  const { w, h } = fitCanvas(canvas);
  if (!w || !h) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);

  const gh = Math.min(h * 0.9, w * 1.12);
  const r1 = gh * 0.37;
  const r0 = r1 * 0.74;
  const ry1 = r1 * RIM;
  const ry0 = r0 * RIM;
  const cx = w / 2;
  const yTop = (h - gh) / 2 + ry1;
  const yBot = (h + gh) / 2 - ry0;
  const body = yBot - yTop;
  const line = Math.max(1.5, gh * 0.011);
  const muted = css('--muted');
  const { x: tiltX = 0, z: tiltZ = 0 } = typeof tilt === 'number' ? { x: tilt } : tilt;

  const silhouette = new Path2D();
  silhouette.moveTo(cx - r1, yTop);
  silhouette.lineTo(cx - r0, yBot);
  silhouette.ellipse(cx, yBot, r0, ry0, 0, Math.PI, 0, true);
  silhouette.lineTo(cx + r1, yTop);
  silhouette.ellipse(cx, yTop, r1, ry1, 0, 0, Math.PI, true);
  silhouette.closePath();

  // ガラスの奥側
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.fill(silhouette);
  ctx.lineWidth = line * 0.7;
  ctx.strokeStyle = muted;
  ctx.globalAlpha = 0.45;
  ctx.beginPath();
  ctx.ellipse(cx, yTop, r1, ry1, 0, Math.PI, 0);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // 水面は重心を保ったまま、前後と左右の揺れで傾く
  const level = yTop + body * 0.36;
  const radius = r0 + (r1 - r0) * ((yBot - level) / body);
  // 向きを学習する前でも揺れの大きさが分かるよう、波の高さに表す
  const ripple = gh * 0.005 * (1 + shake * 2);
  const surface = [];
  const STEPS = 48;
  for (let i = 0; i < STEPS; i++) {
    const a = (i / STEPS) * Math.PI * 2;
    const x = Math.cos(a) * radius;
    const z = Math.sin(a) * radius; // 正が手前
    const y = level + Math.tan(tiltX) * x + Math.tan(tiltZ) * z * 0.8 + z * RIM + Math.sin(a * 3 + phase) * ripple;
    surface.push([cx + x, y]);
  }

  ctx.save();
  ctx.clip(silhouette);
  // 水の側面: 水面の手前半分から底まで
  const side = new Path2D();
  side.moveTo(...surface[0]);
  for (let i = 1; i <= STEPS / 2; i++) side.lineTo(...surface[i]);
  side.lineTo(cx - r1, yBot);
  side.ellipse(cx, yBot, r0, ry0, 0, Math.PI, 0, true);
  side.lineTo(cx + r1, surface[0][1]);
  side.closePath();
  ctx.fillStyle = color;
  ctx.fill(side);
  const shade = ctx.createLinearGradient(cx - r1, 0, cx + r1, 0);
  shade.addColorStop(0, 'rgba(0,0,0,0.28)');
  shade.addColorStop(0.45, 'rgba(0,0,0,0)');
  shade.addColorStop(1, 'rgba(0,0,0,0.22)');
  ctx.fillStyle = shade;
  ctx.fill(side);

  // 水面: 少し明るくして、上から見えている面とわかるようにする
  const top = new Path2D();
  top.moveTo(...surface[0]);
  for (const point of surface.slice(1)) top.lineTo(...point);
  top.closePath();
  ctx.fillStyle = color;
  ctx.fill(top);
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.fill(top);
  ctx.lineWidth = line * 0.6;
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.stroke(top);
  ctx.restore();

  // ガラスの手前側
  ctx.lineWidth = line;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = muted;
  ctx.beginPath();
  ctx.moveTo(cx - r1, yTop);
  ctx.lineTo(cx - r0, yBot);
  ctx.ellipse(cx, yBot, r0, ry0, 0, Math.PI, 0, true);
  ctx.lineTo(cx + r1, yTop);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(cx, yTop, r1, ry1, 0, 0, Math.PI);
  ctx.stroke();

  // 映り込みの光
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = line * 1.6;
  ctx.beginPath();
  ctx.moveTo(cx - r1 * 0.66, yTop + body * 0.12);
  ctx.lineTo(cx - r0 * 0.7, yBot - body * 0.14);
  ctx.stroke();
}

/* ---------- 走行 ---------- */
let ride = null;

function show(screen) {
  for (const id of ['start', 'drive', 'result']) $(id).hidden = id !== screen;
  window.scrollTo(0, 0);
}

function showStartError(text) {
  const el = $('startError');
  el.textContent = text;
  el.hidden = false;
  show('start');
}

function newRide(isDemo) {
  const engine = new RideEngine({
    sensitivity: SENSITIVITY[settings.sens] ?? 1,
    onEvent: (event) => handleEvent(event),
  });
  return {
    engine,
    isDemo,
    startedAt: performance.now(),
    cleanups: [],
    tilt: { x: 0, z: 0 },
    tiltSpeed: { x: 0, z: 0 },
    level: 0,
    frame: 0,
    lastFrame: performance.now(),
    lastCalmMoving: 0,
    messageUntil: 0,
    motionCount: 0,
    gpsState: 'waiting',
    wakeLock: null,
    look: null,
  };
}

/* ---------- カメラ先読み ---------- */
// GPSの速度があれば時速15km以上を走行中とする。なければ揺れの計測の判定に従う
function isMoving(engine, t) {
  const fresh = engine.speed !== null && engine.speedT > t - 5;
  return fresh ? engine.speed >= ADVISE_MIN_SPEED : engine.moving;
}

function setLookState(text, warn = false) {
  const el = $('lookState');
  if (el.textContent !== text) el.textContent = text;
  el.dataset.level = warn ? 'warn' : '';
}

async function startLookahead(current) {
  const look = {
    camera: null,
    advisor: new LookaheadAdvisor(),
    counts: { leadBrake: 0, closing: 0 },
    frames: 0,
    leadFrames: 0,
    state: 'starting',
    error: '',
  };
  current.look = look;
  setLookState('カメラを準備しています');
  try {
    // カメラ関係は使うときだけ読み込む
    const { CameraLookahead } = await import('./lookahead.js');
    if (ride !== current) return;
    const camera = new CameraLookahead($('camVideo'), (t, result) => onLookFrame(current, t, result));
    look.camera = camera;
    current.cleanups.push(() => camera.stop());
    // 準備の途中で走行を終えたら、開いたカメラをすぐ閉じる
    await camera.openCamera();
    if (ride !== current) return camera.stop();
    $('camVideo').hidden = false;
    setLookState('検出モデルを読み込んでいます');
    await camera.start();
    if (ride !== current) return camera.stop();
    look.state = 'running';
    setLookState('前の車を探しています');
  } catch (error) {
    look.camera?.stop();
    look.state = 'failed';
    look.error = error.message?.match(/[ぁ-ん]/) ? error.message : '検出モデルを読み込めませんでした。揺れの計測だけ続けます。';
    $('camVideo').hidden = true;
    setLookState('カメラ先読みは止まっています');
  }
}

function onLookFrame(current, t, { lead, brakeLit }) {
  if (ride !== current) return;
  const look = current.look;
  const tracked = lead.status !== 'none' && lead.status !== 'lost';
  look.frames++;
  if (tracked) look.leadFrames++;
  setLookState(
    brakeLit ? '前の車: ブレーキ灯' : tracked ? '前の車を追跡中' : '前の車なし',
    brakeLit || lead.status === 'closing',
  );
  const type = look.advisor.update(t, { moving: isMoving(current.engine, t), lead, brakeLit });
  if (!type) return;
  look.counts[type]++;
  $('message').textContent = LOOK_COPY[type].name;
  current.messageUntil = performance.now() + 3000;
  chime();
  speak(LOOK_COPY[type].say, true);
}

function handleEvent(event) {
  if (!ride) return;
  ride.lastCalmMoving = ride.engine.movingSec;
  const copy = COPY[event.type];
  $('message').textContent = copy.name;
  ride.messageUntil = performance.now() + 4000;
  chime();
  speak(copy.say);
}

function frame(now) {
  if (!ride) return;
  const dt = Math.min(0.05, (now - ride.lastFrame) / 1000);
  ride.lastFrame = now;
  const { engine } = ride;
  const live = engine.live;

  // 水面は左右と前後それぞれをばねで動かし、揺れた後しばらく波打たせる。
  // 水は慣性で加速と反対へ寄る。右へ曲がれば左側が、ブレーキなら奥（前）側が上がる
  const targets = { x: live.right ?? 0, z: -(live.long ?? 0) };
  for (const axis of ['x', 'z']) {
    const target = Math.max(-0.5, Math.min(0.5, (targets[axis] / 9.81) * 2.2));
    ride.tiltSpeed[axis] += (-30 * (ride.tilt[axis] - target) - 3.5 * ride.tiltSpeed[axis]) * dt;
    ride.tilt[axis] += ride.tiltSpeed[axis] * dt;
  }

  // 上がるときは即座に、下がるときはゆっくり。一瞬の点滅で視線を奪わないため
  ride.level = live.level > ride.level ? live.level : ride.level + (live.level - ride.level) * dt * 0.7;
  const stage = ride.level < 0.4 ? 0 : ride.level < 0.75 ? 1 : 2;
  const word = $('statusWord');
  if (word.dataset.level !== String(stage)) {
    word.dataset.level = String(stage);
    word.textContent = ['なめらか', '少し揺れています', '揺れが大きい'][stage];
  }
  ride.frame += dt;
  drawGlass($('glass'), ride.tilt, css(['--water', '--warn', '--bad'][stage]), ride.frame * 1.5, ride.level);

  if (ride.messageUntil && now > ride.messageUntil) {
    $('message').textContent = '';
    ride.messageUntil = 0;
  }
  if (engine.movingSec - ride.lastCalmMoving >= PRAISE_INTERVAL) {
    ride.lastCalmMoving = engine.movingSec;
    speak(PRAISE);
  }

  const sec = Math.floor(engine.movingSec);
  $('elapsed').textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  const states = {
    waiting: 'GPSを待っています',
    ok: engine.forwardReady && engine.rightSign !== 0 ? '計測中' : '計測中（向きを学習中）',
    none: 'GPSなしで計測中',
    demo: 'デモ走行',
  };
  $('sensorState').textContent = states[ride.gpsState];
  requestAnimationFrame(frame);
}

async function requestWakeLock() {
  if (!ride || !('wakeLock' in navigator)) return;
  try {
    ride.wakeLock = await navigator.wakeLock.request('screen');
  } catch {
    // 拒否されても計測は続ける
  }
}

function beginDriveScreen() {
  $('message').textContent = '';
  $('statusWord').textContent = 'なめらか';
  $('statusWord').dataset.level = '0';
  $('endBtn').hidden = false;
  $('confirmEnd').hidden = true;
  $('cancelEnd').hidden = true;
  show('drive');
  requestAnimationFrame((now) => {
    if (!ride) return;
    ride.lastFrame = now;
    frame(now);
  });
}

function distanceMeters(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad * Math.cos(a.latitude * rad);
  return 6371000 * Math.hypot(dLat, dLon);
}

async function startReal() {
  $('startError').hidden = true;
  unlockAudio();

  if (!window.isSecureContext) {
    showStartError('センサーはHTTPSで開いたページでのみ使えます。https:// から始まるURLで開き直してください。');
    return;
  }
  if (!('DeviceMotionEvent' in window)) {
    showStartError('この端末やブラウザは加速度センサーに対応していません。iPhoneはSafari、AndroidはChromeで開いてください。');
    return;
  }
  if (typeof DeviceMotionEvent.requestPermission === 'function') {
    let state = 'denied';
    try {
      state = await DeviceMotionEvent.requestPermission();
    } catch {
      state = 'denied';
    }
    if (state !== 'granted') {
      showStartError('モーションセンサーの使用が許可されませんでした。ページを再読み込みして、もう一度「許可」を選んでください。');
      return;
    }
  }

  ride = newRide(false);
  const current = ride;

  const onMotion = (e) => {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x === null) return;
    current.motionCount++;
    current.engine.addMotion(performance.now() / 1000, a.x, a.y, a.z);
  };
  window.addEventListener('devicemotion', onMotion);
  current.cleanups.push(() => window.removeEventListener('devicemotion', onMotion));

  if ('geolocation' in navigator) {
    let previous = null;
    const watch = navigator.geolocation.watchPosition(
      ({ coords }) => {
        const t = performance.now() / 1000;
        let speed = coords.speed;
        // 速度を返さない端末では、位置の変化から求める。位置そのものは保存しない
        if ((speed === null || Number.isNaN(speed)) && previous && coords.accuracy < 50) {
          const dt = t - previous.t;
          if (dt > 0.5) speed = distanceMeters(previous, coords) / dt;
        }
        previous = { t, latitude: coords.latitude, longitude: coords.longitude };
        if (speed !== null && !Number.isNaN(speed)) {
          current.gpsState = 'ok';
          // 進行方向は、どちらが右かを学ぶためだけに使う
          const heading = Number.isFinite(coords.heading) ? coords.heading : null;
          current.engine.addGps(t, speed, heading);
        }
      },
      () => {
        current.gpsState = 'none';
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
    );
    current.cleanups.push(() => navigator.geolocation.clearWatch(watch));
  } else {
    current.gpsState = 'none';
  }

  if (settings.camera === 'on') startLookahead(current);

  requestWakeLock();
  const onVisible = () => {
    if (document.visibilityState === 'visible') requestWakeLock();
  };
  document.addEventListener('visibilitychange', onVisible);
  current.cleanups.push(() => document.removeEventListener('visibilitychange', onVisible));
  current.cleanups.push(() => current.wakeLock?.release().catch(() => {}));

  beginDriveScreen();

  // パソコンなど、センサーのない端末を早めに案内する
  const check = setTimeout(() => {
    if (ride === current && current.motionCount === 0) {
      teardown();
      ride = null;
      showStartError('加速度センサーの値が届きません。スマホで開いているか確認してください。Androidは、サイトの設定でモーションセンサーが許可されているかも確認してください。');
    }
  }, 3000);
  current.cleanups.push(() => clearTimeout(check));
}

function startDemo(scenario) {
  $('startError').hidden = true;
  unlockAudio();
  ride = newRide(true);
  ride.gpsState = 'demo';
  const current = ride;
  const samples = simulate({ scenario });
  const rate = Number(new URLSearchParams(location.search).get('demoRate')) || 1;
  const startedAt = performance.now();
  let cursor = 0;
  const timer = setInterval(() => {
    const t = ((performance.now() - startedAt) / 1000) * rate;
    while (cursor < samples.length && samples[cursor].t <= t) {
      const s = samples[cursor++];
      if (s.kind === 'motion') current.engine.addMotion(s.t, s.x, s.y, s.z);
      else current.engine.addGps(s.t, s.speed, s.heading);
    }
    if (cursor >= samples.length) finish();
  }, 16);
  current.cleanups.push(() => clearInterval(timer));
  beginDriveScreen();
}

function teardown() {
  if (!ride) return;
  for (const fn of ride.cleanups) fn();
  ride.cleanups = [];
  $('camVideo').hidden = true;
  setLookState('');
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

function finish() {
  if (!ride) return;
  teardown();
  const summary = ride.engine.summary();
  const isDemo = ride.isDemo;
  const look = ride.look;
  ride = null;
  if (!isDemo && summary.movingSec >= 30) {
    const history = load(HISTORY_KEY, []);
    history.unshift({
      at: Date.now(),
      score: summary.score,
      sec: Math.round(summary.movingSec),
      m: Math.round(summary.distance),
    });
    save(HISTORY_KEY, history.slice(0, 20));
  }
  renderResult(summary, isDemo);
  renderLook(look);
  show('result');
  renderChart(summary);
}

/* ---------- 結果 ---------- */
function formatDuration(sec) {
  const min = Math.round(sec / 60);
  if (sec < 60) return `${Math.round(sec)}秒`;
  return min < 60 ? `${min}分` : `${Math.floor(min / 60)}時間${min % 60}分`;
}
function formatDistance(m) {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}
function scoreWord(score) {
  if (score >= 85) return '水面は静かでした';
  if (score >= 65) return 'おおむね穏やかでした';
  if (score >= 40) return '揺れが目立ちました';
  return '揺れの多い走行でした';
}

function renderResult(s, isDemo) {
  $('scoreValue').textContent = s.score;
  $('scoreWord').textContent = scoreWord(s.score);
  $('demoTag').hidden = !isDemo;
  $('mTime').textContent = formatDuration(s.movingSec);
  $('mDist').textContent = s.gpsSeen ? formatDistance(s.distance) : '―';
  $('mStops').textContent = s.gpsSeen ? `${s.stops}回` : '―';

  const ranked = Object.entries(s.counts).sort((a, b) => b[1] - a[1]);
  $('eventsSection').hidden = ranked.length === 0;
  $('eventRows').replaceChildren(
    ...ranked.map(([type, count]) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = COPY[type].name;
      const value = document.createElement('span');
      value.textContent = `${count}回`;
      li.append(name, value);
      return li;
    }),
  );

  const advice = $('advice');
  advice.replaceChildren();
  const tips = ranked.length
    ? ranked.slice(0, 2).map(([type]) => [COPY[type].name, COPY[type].tip])
    : [['この調子で', '今回は気になる操作がありませんでした。同じペースを続けましょう。']];
  for (const [title, body] of tips) {
    const p = document.createElement('p');
    const strong = document.createElement('strong');
    strong.textContent = title;
    p.append(strong, body);
    advice.append(p);
  }

  const notes = [];
  if (s.pausedSec > 5) notes.push(`画面が閉じていた約${Math.round(s.pausedSec)}秒間は計測していません。`);
  if (s.phoneMoves > 0) notes.push('途中でスマホの向きが変わったため、前後の判定を学習し直しました。');
  if (!s.gpsSeen) notes.push('GPSを使えなかったため、距離と停止回数は計測していません。');
  else if (!s.forwardReady) notes.push('加速と減速が少なく前後の向きを学習できなかったため、操作の種類を一部しか区別していません。');
  $('caveat').textContent = notes.join(' ');
  $('caveat').hidden = notes.length === 0;
}

function renderLook(look) {
  $('lookSection').hidden = !look;
  if (!look) return;
  const rows = look.state === 'failed'
    ? [[look.error, '']]
    : [
        [LOOK_COPY.leadBrake.name, `${look.counts.leadBrake}回`],
        [LOOK_COPY.closing.name, `${look.counts.closing}回`],
        ['前の車を捉えていた割合', look.frames ? `${Math.round((look.leadFrames / look.frames) * 100)}%` : '―'],
      ];
  $('lookRows').replaceChildren(
    ...rows.map(([name, value]) => {
      const li = document.createElement('li');
      const a = document.createElement('span');
      a.textContent = name;
      const b = document.createElement('span');
      b.textContent = value;
      li.append(a, b);
      return li;
    }),
  );
}

function renderChart(s) {
  const box = $('chart');
  box.replaceChildren();
  if (s.buckets.length < 2) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'グラフを描くには30秒以上の走行が必要です。';
    box.append(p);
    return;
  }

  const NS = 'http://www.w3.org/2000/svg';
  const W = Math.max(280, box.clientWidth);
  const H = 190;
  const pad = { l: 30, r: 10, t: 22, b: 22 };
  const maxT = s.buckets.at(-1).t;
  const maxY = Math.ceil(Math.max(1, ...s.buckets.map((b) => b.rms)) * 2) / 2;
  const x = (t) => pad.l + (t / maxT) * (W - pad.l - pad.r);
  const y = (v) => H - pad.b - (v / maxY) * (H - pad.t - pad.b);

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `揺れの推移。最大 ${Math.max(...s.buckets.map((b) => b.rms)).toFixed(2)} m/s²`);
  const el = (name, attrs, parent = svg) => {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    parent.append(node);
    return node;
  };

  const line = css('--line');
  for (let v = 0; v <= maxY + 1e-6; v += 0.5) {
    el('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), stroke: line, 'stroke-width': 1 });
    el('text', { x: pad.l - 6, y: y(v) + 4, 'text-anchor': 'end' }).textContent = v.toFixed(1);
  }
  const minutes = maxT / 60;
  const stepMin = [0.5, 1, 2, 5, 10, 15, 30, 60].find((m) => minutes / m <= 5) ?? 120;
  for (let m = 0; m * 60 <= maxT; m += stepMin) {
    el('text', { x: x(m * 60), y: H - 6, 'text-anchor': m === 0 ? 'start' : 'middle' }).textContent =
      m === 0 ? '0分' : `${m}分`;
  }

  const water = css('--water');
  const points = [{ t: 0, rms: s.buckets[0].rms }, ...s.buckets];
  const d = points.map((b, i) => `${i ? 'L' : 'M'}${x(b.t).toFixed(1)} ${y(b.rms).toFixed(1)}`).join(' ');
  el('path', { d: `${d} L${x(maxT)} ${y(0)} L${x(0)} ${y(0)} Z`, fill: water, 'fill-opacity': 0.16 });
  el('path', { d, fill: 'none', stroke: water, 'stroke-width': 2, 'stroke-linejoin': 'round' });

  const warn = css('--warn');
  for (const e of s.events) {
    el('circle', { cx: Math.min(x(e.t), W - pad.r - 4), cy: 10, r: 4, fill: warn });
  }

  const cross = el('line', { y1: pad.t, y2: y(0), stroke: css('--muted'), 'stroke-width': 1, visibility: 'hidden' });
  const dot = el('circle', { r: 4, fill: water, stroke: css('--bg'), 'stroke-width': 2, visibility: 'hidden' });
  const tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.hidden = true;

  const move = (clientX) => {
    const rect = svg.getBoundingClientRect();
    const t = ((clientX - rect.left) * (W / rect.width) - pad.l) / (W - pad.l - pad.r) * maxT;
    const b = points.reduce((best, p) => (Math.abs(p.t - t) < Math.abs(best.t - t) ? p : best));
    const sx = x(b.t);
    cross.setAttribute('x1', sx);
    cross.setAttribute('x2', sx);
    cross.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', sx);
    dot.setAttribute('cy', y(b.rms));
    dot.setAttribute('visibility', 'visible');
    const near = s.events.filter((e) => Math.abs(e.t - b.t) <= 7).map((e) => COPY[e.type].name);
    const sec = Math.round(b.t);
    tip.textContent = `${Math.floor(sec / 60)}分${sec % 60}秒 ${b.rms.toFixed(2)} m/s²${near.length ? ` ・ ${near[0]}` : ''}`;
    tip.hidden = false;
    const left = (sx / W) * rect.width;
    tip.style.left = `${Math.min(left, Math.max(0, rect.width - tip.offsetWidth))}px`;
  };
  const leave = () => {
    tip.hidden = true;
    cross.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
  };
  svg.addEventListener('pointermove', (e) => move(e.clientX));
  svg.addEventListener('pointerdown', (e) => move(e.clientX));
  svg.addEventListener('pointerleave', leave);
  box.append(svg, tip);
}

function renderHistory() {
  const history = load(HISTORY_KEY, []);
  $('historySection').hidden = history.length === 0;
  $('history').replaceChildren(
    ...history.map((h) => {
      const li = document.createElement('li');
      const left = document.createElement('span');
      const date = new Date(h.at);
      left.textContent = `${date.getMonth() + 1}/${date.getDate()} ${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
      const sub = document.createElement('span');
      sub.className = 'sub';
      sub.textContent = `${formatDuration(h.sec)}・${formatDistance(h.m)}`;
      const score = document.createElement('strong');
      score.textContent = h.score;
      li.append(left, sub, score);
      return li;
    }),
  );
}

/* ---------- 画面の配線 ---------- */
$('startBtn').addEventListener('click', startReal);
$('demoSmooth').addEventListener('click', () => startDemo('smooth'));
$('demoRough').addEventListener('click', () => startDemo('rough'));
$('endBtn').addEventListener('click', () => {
  $('endBtn').hidden = true;
  $('confirmEnd').hidden = false;
  $('cancelEnd').hidden = false;
});
$('cancelEnd').addEventListener('click', () => {
  $('endBtn').hidden = false;
  $('confirmEnd').hidden = true;
  $('cancelEnd').hidden = true;
});
$('confirmEnd').addEventListener('click', finish);
$('backBtn').addEventListener('click', () => {
  renderHistory();
  show('start');
  drawLogo();
});

const soundMode = $('soundMode');
const sensMode = $('sensMode');
const cameraMode = $('cameraMode');
soundMode.value = settings.sound;
sensMode.value = settings.sens;
cameraMode.value = settings.camera;
cameraMode.addEventListener('change', () => {
  settings.camera = cameraMode.value;
  save(SETTINGS_KEY, settings);
});
soundMode.addEventListener('change', () => {
  settings.sound = soundMode.value;
  save(SETTINGS_KEY, settings);
});
sensMode.addEventListener('change', () => {
  settings.sens = sensMode.value;
  save(SETTINGS_KEY, settings);
});

function drawLogo() {
  drawGlass($('logo'), { x: -0.12, z: 0.06 }, css('--water'));
}
renderHistory();
drawLogo();
window.addEventListener('resize', drawLogo);

if ('serviceWorker' in navigator && !['localhost', '127.0.0.1'].includes(location.hostname)) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
