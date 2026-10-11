/* ARUNA Catch — game pameran berbasis gerakan.
   Pemain menggeser badan di depan kamera untuk memindahkan biodigester ARUNA:
   tangkap sisa makanan organik, hindari sampah anorganik.
   Sekaligus buku tamu (nama, HP, instansi) dan Hall of Fame (RTDB).

   Kontrol (otomatis memilih yang tersedia):
     1. pose  — MediaPipe Pose Landmarker (posisi bahu, angkat tangan untuk mulai)
     2. motion — deteksi gerakan sederhana bila model gagal dimuat
     3. pointer — mouse / sentuh / panah keyboard bila kamera tidak ada */

import { auth, rtdb, signInAnonymously } from "/assets/js/firebase-init.js";
import {
  ref, push, update, get, query, orderByChild, limitToLast, startAfter, onValue, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js";

const MP_VER = "0.10.14";
const MP_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}`;
const POSE_MODEL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

const ROUND_SEC = 60;
const LIVES = 3;
const KG_PER_ITEM = 0.15;          // perkiraan berat satu sisa makanan
const BIOGAS_L_PER_KG = 60;        // perkiraan kasar biogas dari sisa makanan
const STOVE_L_PER_MIN = 6.5;       // konsumsi kompor biogas rumah tangga
const IDLE_RESULT_SEC = 30;
const PENDING_KEY = "aruna-game-pending";

const GOOD = [
  ["🍚", "Nasi sisa"], ["🥬", "Sayur layu"], ["🍌", "Kulit pisang"], ["🍎", "Apel"],
  ["🥕", "Wortel"], ["🍞", "Roti basi"], ["🐟", "Sisa ikan"], ["🍉", "Kulit semangka"], ["🥚", "Cangkang telur"]
];
const BAD = [
  ["🥤", "Gelas plastik"], ["🧴", "Botol plastik"], ["🔋", "Baterai"], ["🥫", "Kaleng"], ["🛍️", "Kantong plastik"]
];
const FACTS = [
  "Sisa makanan yang menumpuk di TPA menghasilkan metana, gas rumah kaca ±28× lebih kuat dari CO₂. ARUNA menangkapnya jadi biogas.",
  "Biodigester ARUNA mengolah sisa makanan MBG menjadi biogas, pupuk cair, dan kompos padat.",
  "Plastik dan logam tidak bisa diurai bakteri anaerob, jadi harus dipilah sebelum masuk biodigester.",
  "Pupuk cair hasil fermentasi anaerob kaya nitrogen dan bisa langsung dipakai untuk kebun sekolah.",
  "Sensor ARUNA memantau berat sampah, suhu, gas metana, dan level digester secara real-time."
];
const TIERS = [
  { min: 400, icon: "🥇", title: "Pahlawan Biogas" },
  { min: 200, icon: "🥈", title: "Penjaga Ekonomi Sirkular" },
  { min: 0,   icon: "🌱", title: "Sahabat Bumi" }
];

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];

/* ---------------- Firebase: masuk anonim + Hall of Fame ---------------- */

const authReady = signInAnonymously(auth).catch((e) => { console.warn("Login anonim gagal", e); });

function renderHof(list, el, highlightId) {
  el.replaceChildren();
  if (!list.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Belum ada skor. Jadilah yang pertama!";
    el.append(li);
    return;
  }
  for (const r of list) {
    const li = document.createElement("li");
    if (r.id === highlightId) li.classList.add("me");
    const who = document.createElement("div"); who.className = "who";
    const b = document.createElement("b"); b.textContent = r.nama;
    const s = document.createElement("small"); s.textContent = r.instansi;
    who.append(b, s);
    const pts = document.createElement("span"); pts.className = "pts"; pts.textContent = r.skor;
    li.append(who, pts);
    el.append(li);
  }
}

let hofTop = [];
let myEntryId = null;
// Ambil 60 skor tertinggi, lalu tampilkan 10 orang teratas (satu baris per nama+instansi).
onValue(query(ref(rtdb, "halloffame"), orderByChild("skor"), limitToLast(60)), (snap) => {
  const rows = [];
  snap.forEach((c) => { rows.push({ id: c.key, ...c.val() }); });
  rows.sort((a, b) => b.skor - a.skor);
  const seen = new Set();
  hofTop = rows.filter((r) => {
    const k = `${r.nama}|${r.instansi}`.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 10);
  renderHof(hofTop, $("hofHome"));
  renderHof(hofTop, $("hofResult"), myEntryId);
}, (err) => {
  console.warn("Hall of Fame tidak bisa dimuat", err);
  $("hofHome").innerHTML = '<li class="empty">Hall of Fame offline</li>';
});

function newCode() {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 5; i++) s += abc[(Math.random() * abc.length) | 0];
  return s;
}

async function saveEntry(e) {
  await authReady;
  if (!auth.currentUser) throw new Error("belum login");
  const ts = serverTimestamp();
  if (e.type === "foto") {
    await update(ref(rtdb), {
      [`logbookPrivat/${e.id}`]: { nama: e.nama, hp: e.hp, instansi: e.instansi, ts },
      [`logbook/${e.id}`]: { nama: e.nama, instansi: e.instansi, foto: e.foto, ts }
    });
  } else {
    await update(ref(rtdb), {
      [`bukutamu/${e.id}`]: { nama: e.nama, hp: e.hp, instansi: e.instansi, skor: e.skor, kode: e.kode, ts },
      [`halloffame/${e.id}`]: { nama: e.nama, instansi: e.instansi, skor: e.skor, ts }
    });
  }
  return e.id;
}

// Koneksi pameran bisa lambat: setelah 12 detik anggap gagal dan masukkan ke antrean
// (kalau ternyata tersimpan, antrean membuangnya saat dikirim ulang).
function saveWithTimeout(e, ms = 12000) {
  return Promise.race([
    saveEntry(e),
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))
  ]);
}

function loadPending() {
  try { return JSON.parse(localStorage.getItem(PENDING_KEY)) || []; } catch { return []; }
}
function storePending(list) {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(list)); } catch { /* abaikan */ }
}
// Skor yang gagal terkirim (mis. Wi-Fi pameran putus) disimpan lalu dikirim ulang.
async function flushPending() {
  const list = loadPending();
  if (!list.length) return;
  const left = [];
  for (const e of list) {
    try { await saveEntry(e); } catch {
      // Ditolak karena sudah pernah tersimpan (balasan sebelumnya hilang) → buang dari antrean
      const pub = e.type === "foto" ? "logbook" : "halloffame";
      const done = await get(ref(rtdb, `${pub}/${e.id}`)).then((s) => s.exists()).catch(() => false);
      if (!done) left.push(e);
    }
  }
  storePending(left);
}
flushPending();
setInterval(flushPending, 60_000);

/* ---------------- Kontroler gerakan ---------------- */

const video = $("video");
const dots = $("camDots");
const dctx = dots.getContext("2d");

const ctl = {
  mode: "pointer",
  x: 0.5,          // posisi target 0..1 (sudah dicerminkan)
  present: false,  // badan / gerakan terdeteksi
  handsUp: false,
  pose: null,
  lastVideoTime: -1,
  prevFrame: null,
  motionCanvas: null,
  starting: null
};

function setCamTag(t) { $("camTag").textContent = t; }

async function startCamera() {
  if (ctl.starting) return ctl.starting;
  ctl.starting = (async () => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Kamera tidak didukung");
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false
    });
    video.srcObject = stream;
    await video.play();
    ctl.mode = "motion";
    setCamTag("Gerakan");
    try {
      const { FilesetResolver, PoseLandmarker } = await import(`${MP_URL}/vision_bundle.mjs`);
      const files = await FilesetResolver.forVisionTasks(`${MP_URL}/wasm`);
      const opts = (delegate) => ({
        baseOptions: { modelAssetPath: POSE_MODEL, delegate },
        runningMode: "VIDEO", numPoses: 1,
        minPoseDetectionConfidence: 0.5, minTrackingConfidence: 0.5
      });
      ctl.pose = await PoseLandmarker.createFromOptions(files, opts("GPU"))
        .catch(() => PoseLandmarker.createFromOptions(files, opts("CPU")));
      ctl.mode = "pose";
      setCamTag("Pose AI");
    } catch (e) {
      console.warn("Model pose gagal dimuat, pakai deteksi gerakan", e);
    }
  })().catch((e) => {
    ctl.starting = null;
    ctl.mode = "pointer";
    throw e;
  });
  return ctl.starting;
}

function sizeDots() {
  const w = video.videoWidth || 640, h = video.videoHeight || 480;
  if (dots.width !== w) { dots.width = w; dots.height = h; }
}

function readPose(now) {
  if (video.currentTime === ctl.lastVideoTime) return;
  ctl.lastVideoTime = video.currentTime;
  const res = ctl.pose.detectForVideo(video, now);
  const lm = res.landmarks?.[0];
  sizeDots();
  dctx.clearRect(0, 0, dots.width, dots.height);
  if (!lm) { ctl.present = false; ctl.handsUp = false; return; }
  const ls = lm[11], rs = lm[12], nose = lm[0], lw = lm[15], rw = lm[16];
  const ok = (p) => p && (p.visibility ?? 1) > 0.5;
  let cx = null;
  if (ok(ls) && ok(rs)) cx = (ls.x + rs.x) / 2;
  else if (ok(nose)) cx = nose.x;
  ctl.present = cx !== null;
  if (cx !== null) {
    // Cermin + area tengah 20%–80% dipetakan ke seluruh lebar layar
    ctl.x = clamp(((1 - cx) - 0.2) / 0.6, 0, 1);
  }
  const shoulderY = ok(ls) && ok(rs) ? Math.min(ls.y, rs.y) : (ok(nose) ? nose.y : 0);
  ctl.handsUp = ok(lw) && ok(rw) && lw.y < shoulderY - 0.05 && rw.y < shoulderY - 0.05;

  dctx.fillStyle = "#4ADE80";
  for (const i of [0, 11, 12, 13, 14, 15, 16]) {
    const p = lm[i];
    if (!ok(p)) continue;
    dctx.beginPath();
    dctx.arc(p.x * dots.width, p.y * dots.height, 7, 0, Math.PI * 2);
    dctx.fill();
  }
}

// Cadangan tanpa model: titik berat piksel yang berubah antar frame
function readMotion() {
  const W = 80, H = 60;
  if (!ctl.motionCanvas) {
    ctl.motionCanvas = document.createElement("canvas");
    ctl.motionCanvas.width = W; ctl.motionCanvas.height = H;
  }
  const mc = ctl.motionCanvas.getContext("2d", { willReadFrequently: true });
  mc.drawImage(video, 0, 0, W, H);
  const px = mc.getImageData(0, 0, W, H).data;
  const gray = new Uint8ClampedArray(W * H);
  for (let i = 0; i < W * H; i++) gray[i] = (px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2]) / 3;
  const prev = ctl.prevFrame;
  ctl.prevFrame = gray;
  if (!prev) return;
  let sum = 0, sx = 0, top = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (Math.abs(gray[i] - prev[i]) > 28) { sum++; sx += x; if (y < H * 0.3) top++; }
    }
  }
  ctl.present = sum > 40;
  if (ctl.present) {
    const cx = sx / sum / W;
    ctl.x += (clamp(((1 - cx) - 0.15) / 0.7, 0, 1) - ctl.x) * 0.35;
  }
  // "Lambaikan tangan" di bagian atas gambar = sinyal mulai
  ctl.handsUp = top > 60;
}

function updateController(now) {
  if (ctl.mode === "pose" && video.readyState >= 2) readPose(now);
  else if (ctl.mode === "motion" && video.readyState >= 2) readMotion();
}

// Pointer / keyboard selalu aktif sebagai cadangan
let keyDir = 0;
window.addEventListener("pointermove", (e) => {
  if (ctl.mode !== "pointer" && ctl.present) return;
  const r = cv.getBoundingClientRect();
  ctl.x = clamp((e.clientX - r.left) / r.width, 0, 1);
});
window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  if (e.key === "ArrowLeft") keyDir = -1;
  if (e.key === "ArrowRight") keyDir = 1;
  if (e.key === "f" || e.key === "F") toggleFullscreen();
  if (e.key === "Enter" && state === "home") openForm("game");
  if ((e.key === "p" || e.key === "P") && state === "home") openForm("foto");
  if ((e.key === "Enter" || e.key === " ") && state === "photo" && photo.phase === "live") { e.preventDefault(); startCountdown(); }
  if ((e.key === "Enter" || e.key === " ") && state === "calib") { e.preventDefault(); startGame(); }
});
window.addEventListener("keyup", (e) => {
  if ((e.key === "ArrowLeft" && keyDir < 0) || (e.key === "ArrowRight" && keyDir > 0)) keyDir = 0;
});

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

/* ---------------- Suara ---------------- */

let actx = null;
function beep(freq, dur = 0.12, type = "sine", vol = 0.15) {
  try {
    actx ||= new AudioContext();
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + dur);
    o.connect(g).connect(actx.destination);
    o.start(); o.stop(actx.currentTime + dur);
  } catch { /* tanpa suara */ }
}

/* ---------------- Panggung (canvas) ---------------- */

const cv = $("stage");
const ctx = cv.getContext("2d");
let W = 0, H = 0, DPR = 1;
function resize() {
  DPR = Math.min(devicePixelRatio || 1, 2);
  const r = cv.getBoundingClientRect();
  W = r.width; H = r.height;
  cv.width = W * DPR; cv.height = H * DPR;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
addEventListener("resize", resize);
resize();

// Sprite mesin: potong area transparan agar kotak tabrakan pas
const machine = { img: new Image(), sx: 0, sy: 0, sw: 1, sh: 1, ready: false };
machine.img.onload = () => {
  const c = document.createElement("canvas");
  c.width = machine.img.width; c.height = machine.img.height;
  const g = c.getContext("2d");
  g.drawImage(machine.img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let x0 = c.width, y0 = c.height, x1 = 0, y1 = 0;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    if (d[(y * c.width + x) * 4 + 3] > 20) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  }
  Object.assign(machine, { sx: x0, sy: y0, sw: x1 - x0 + 1, sh: y1 - y0 + 1, ready: true });
};
machine.img.src = "/app/img/mesin.png";

const player = { x: 0.5, px: 0, bounce: 0, shake: 0 };

function machineBox() {
  const h = Math.min(H * 0.3, W * 0.5);
  const w = machine.ready ? h * machine.sw / machine.sh : h * 0.45;
  const cx = player.px;
  const top = H - h - 8 + player.bounce;
  // Mulut corong ±26% dari atas sprite (di bawah tutup yang terbuka)
  const mouthY = top + h * 0.26;
  const bodyW = w * 0.82;
  return { x: cx - w / 2, y: top, w, h, mouthY, mouthL: cx - bodyW / 2, mouthR: cx + bodyW / 2 - w * 0.08 };
}

function drawBackground(t) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#0F6B40");
  g.addColorStop(1, "#0B3B26");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // Gelembung biogas pelan di latar
  ctx.fillStyle = "rgba(255,255,255,.05)";
  for (let i = 0; i < 18; i++) {
    const x = (i * 137.5 % 100) / 100 * W;
    const y = H - ((t * 0.02 * (1 + i % 3) + i * 97) % (H + 80)) + 40;
    ctx.beginPath(); ctx.arc(x, y, 10 + (i % 5) * 6, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = "rgba(0,0,0,.18)";
  ctx.fillRect(0, H - 14, W, 14);
}

function drawMachine() {
  const m = machineBox();
  ctx.save();
  if (player.shake > 0) ctx.translate(rand(-1, 1) * player.shake * 10, 0);
  ctx.fillStyle = "rgba(0,0,0,.25)";
  ctx.beginPath(); ctx.ellipse(player.px, H - 10, m.w * 0.45, 10, 0, 0, Math.PI * 2); ctx.fill();
  if (machine.ready) {
    ctx.drawImage(machine.img, machine.sx, machine.sy, machine.sw, machine.sh, m.x, m.y, m.w, m.h);
  } else {
    ctx.fillStyle = "#158A52";
    ctx.fillRect(m.x, m.y, m.w, m.h);
  }
  if (mult > 1) {
    ctx.strokeStyle = "rgba(167,139,250,.9)"; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.ellipse(player.px, m.mouthY, m.w * 0.55, 18, 0, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
}

/* ---------------- Logika permainan ---------------- */

let state = "home";
let items = [], floats = [], parts = [];
let score = 0, lives = LIVES, caught = 0, combo = 0, mult = 1, multUntil = 0;
let tStart = 0, spawnAt = 0, lastT = 0;
let player0 = null;   // data buku tamu pemain aktif

function itemSize() { return W * 0.12; }

function spawn(elapsed, demo) {
  const p = elapsed / ROUND_SEC;
  const r = Math.random();
  let kind, e;
  if (!demo && r < 0.04) { kind = "mic"; e = ["🦠", "Mikroba starter"]; }
  else if (r < 0.25 + p * 0.15) { kind = "bad"; e = pick(BAD); }
  else { kind = "good"; e = pick(GOOD); }
  const s = itemSize();
  items.push({
    kind, emoji: e[0], label: e[1],
    x: rand(s, W - s), y: -s, vx: rand(-20, 20),
    vy: H * (demo ? 0.18 : 0.26 + p * 0.34) * rand(0.9, 1.15),
    rot: rand(-0.5, 0.5), vr: rand(-1.5, 1.5), s
  });
}

function addFloat(x, y, text, color) { floats.push({ x, y, text, color, life: 1 }); }
function burst(x, y, color) {
  for (let i = 0; i < 14; i++) parts.push({ x, y, vx: rand(-220, 220), vy: rand(-320, -60), life: 1, color });
}

function step(dt, now) {
  const elapsed = (now - tStart) / 1000;
  const playing = state === "play";
  const demo = state !== "play";

  if (now >= spawnAt) {
    spawn(playing ? elapsed : 0, demo);
    const gap = playing ? 0.95 - clamp(elapsed / ROUND_SEC, 0, 1) * 0.55 : 1.4;
    spawnAt = now + gap * 1000 * rand(0.8, 1.2);
  }

  // Gerak mesin mengikuti kontroler (dihaluskan)
  if (keyDir) ctl.x = clamp(ctl.x + keyDir * dt * 1.2, 0, 1);
  const target = demo ? 0.5 + Math.sin(now / 1400) * 0.3 : ctl.x;
  player.x += (target - player.x) * Math.min(1, dt * 12);
  const m0 = machineBox();
  player.px = m0.w / 2 + player.x * (W - m0.w);
  player.bounce *= Math.pow(0.001, dt);
  player.shake = Math.max(0, player.shake - dt * 2);
  if (mult > 1 && now > multUntil) { mult = 1; $("hMult").hidden = true; }

  const m = machineBox();
  for (const it of items) {
    const prevY = it.y;
    it.y += it.vy * dt;
    it.x = clamp(it.x + it.vx * dt, it.s / 2, W - it.s / 2);
    it.rot += it.vr * dt;
    if (playing && !it.done && prevY < m.mouthY && it.y >= m.mouthY && it.x > m.mouthL && it.x < m.mouthR) {
      it.done = true;
      onCatch(it);
    }
    if (it.y > H + it.s) {
      it.done = true;
      if (playing && it.kind === "good") combo = 0;
    }
  }
  items = items.filter((it) => !it.done);

  for (const f of floats) { f.y -= 70 * dt; f.life -= dt * 0.9; }
  floats = floats.filter((f) => f.life > 0);
  for (const p of parts) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 900 * dt; p.life -= dt * 1.4; }
  parts = parts.filter((p) => p.life > 0);

  if (playing) {
    const left = Math.max(0, ROUND_SEC - elapsed);
    $("hTime").textContent = Math.ceil(left);
    if (left <= 0 || lives <= 0) endGame();
  }
}

function onCatch(it) {
  const m = machineBox();
  player.bounce = 10;
  if (it.kind === "bad") {
    lives--;
    combo = 0;
    player.shake = 1;
    addFloat(it.x, m.mouthY - 20, `${it.label}! Bakteri terganggu`, "#FCA5A5");
    burst(it.x, m.mouthY, "#EF4444");
    beep(140, 0.35, "sawtooth", 0.12);
    $("hLives").textContent = "🌱".repeat(Math.max(0, lives)) + "🥀".repeat(LIVES - Math.max(0, lives));
    return;
  }
  if (it.kind === "mic") {
    mult = 2;
    multUntil = performance.now() + 6000;
    $("hMult").hidden = false;
    addFloat(it.x, m.mouthY - 20, "Mikroba starter! Poin ×2", "#C4B5FD");
    burst(it.x, m.mouthY, "#A78BFA");
    beep(880, 0.25, "triangle");
    return;
  }
  caught++;
  combo++;
  const bonus = Math.min(10, Math.floor(combo / 5) * 2);
  const pts = (10 + bonus) * mult;
  score += pts;
  addFloat(it.x, m.mouthY - 20, `+${pts}${combo >= 5 ? ` combo ${combo}` : ""}`, "#FDE68A");
  burst(it.x, m.mouthY, "#4ADE80");
  beep(520 + Math.min(combo, 12) * 40, 0.09);
  $("hScore").textContent = score;
  $("hGas").style.width = `${Math.min(100, caught * KG_PER_ITEM * BIOGAS_L_PER_KG / 3)}%`;
}

function draw(now) {
  drawBackground(now);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const it of items) {
    ctx.save();
    ctx.translate(it.x, it.y);
    ctx.rotate(it.rot);
    if (it.kind === "bad") {
      ctx.fillStyle = "rgba(239,68,68,.22)";
      ctx.beginPath(); ctx.arc(0, 0, it.s * 0.62, 0, Math.PI * 2); ctx.fill();
    } else if (it.kind === "mic") {
      ctx.fillStyle = "rgba(167,139,250,.35)";
      ctx.beginPath(); ctx.arc(0, 0, it.s * 0.7 + Math.sin(now / 120) * 4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.font = `${it.s}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
    ctx.fillStyle = "#000";   // alfa fillStyle ikut memudarkan emoji berwarna
    ctx.fillText(it.emoji, 0, 4);
    ctx.restore();
  }
  if (state === "play" || state === "calib") drawMachine();
  for (const p of parts) {
    ctx.globalAlpha = Math.max(0, p.life);
    ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.font = `800 ${W * 0.05}px "Plus Jakarta Sans",sans-serif`;
  for (const f of floats) {
    ctx.globalAlpha = Math.max(0, f.life);
    ctx.lineWidth = 5; ctx.strokeStyle = "rgba(0,0,0,.45)";
    ctx.strokeText(f.text, f.x, f.y);
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, f.x, f.y);
  }
  ctx.globalAlpha = 1;
}

/* ---------------- Alur layar ---------------- */

const screens = ["scrHome", "scrForm", "scrCalib", "scrResult", "scrPhoto"];
function show(id) {
  for (const s of screens) $(s).hidden = s !== id;
}
let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}

let idleTimer;
function goHome() {
  clearInterval(idleTimer);
  state = "home";
  player0 = null;
  myEntryId = null;
  stopPhoto();
  $("cam").hidden = true;
  $("hud").hidden = true;
  $("form").reset();
  $("formErr").textContent = "";
  show("scrHome");
}

let formMode = "game";
function openForm(mode) {
  formMode = mode;
  state = "form";
  const foto = mode === "foto";
  $("formEyebrow").textContent = foto ? "Logbook Pengunjung" : "Buku Tamu";
  $("formTitle").textContent = foto ? "Isi data untuk foto bareng" : "Kenalan dulu, yuk!";
  $("formConsent").textContent = foto
    ? "Saya setuju foto, nama, dan instansi saya tampil di logbook publik ARUNA. Nomor HP tidak ditampilkan dan hanya bisa dilihat panitia."
    : "Saya setuju data ini disimpan panitia ARUNA untuk buku tamu dan pemberian hadiah. Nomor HP tidak ditampilkan di Hall of Fame.";
  show("scrForm");
  setTimeout(() => $("form").elements.nama.focus(), 50);
  // Pengunjung pergi tanpa mengisi → kembali ke layar awal
  clearInterval(idleTimer);
  let idle = 0;
  idleTimer = setInterval(() => { if (++idle > 90 && state === "form") goHome(); }, 1000);
  $("form").oninput = () => { idle = 0; };
}

function normPhone(v) {
  let p = v.replace(/[\s\-().]/g, "");
  if (p.startsWith("+62")) p = "0" + p.slice(3);
  else if (p.startsWith("62")) p = "0" + p.slice(2);
  return p;
}

$("form").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const nama = f.nama.value.trim().replace(/\s+/g, " ");
  const instansi = f.instansi.value.trim().replace(/\s+/g, " ");
  const hp = normPhone(f.hp.value);
  const err = $("formErr");
  if (nama.length < 2) return void (err.textContent = "Nama minimal 2 huruf.", f.nama.focus());
  if (!/^08[0-9]{8,12}$/.test(hp)) return void (err.textContent = "Nomor HP belum valid (contoh: 081234567890).", f.hp.focus());
  if (instansi.length < 2) return void (err.textContent = "Asal instansi wajib diisi.", f.instansi.focus());
  if (!f.setuju.checked) return void (err.textContent = "Centang persetujuan dulu, ya.");
  err.textContent = "";
  player0 = { nama, hp, instansi };
  if (formMode === "foto") openPhoto();
  else openCalib();
});

async function openCalib() {
  clearInterval(idleTimer);
  state = "calib";
  show("scrCalib");
  $("calName").textContent = player0.nama.split(" ")[0];
  $("calTitle").textContent = "Menyalakan kamera…";
  $("calHold").style.width = "0";
  try {
    await startCamera();
  } catch (e) {
    console.warn(e);
    $("calTitle").textContent = "Kamera tidak tersedia";
    $("calText").textContent = "Main pakai mouse, layar sentuh, atau tombol panah ← →. Tekan Mulai.";
    return;
  }
  if (state !== "calib") return;
  $("cam").hidden = false;
  if (ctl.mode === "pose") {
    $("calTitle").textContent = "Angkat kedua tangan untuk mulai";
    $("calText").textContent = "Berdiri ±1,5 m dari layar sampai bahumu terlihat. Geser badan ke kiri/kanan untuk menggerakkan mesin ARUNA.";
  } else {
    $("calTitle").textContent = "Lambaikan tangan untuk mulai";
    $("calText").textContent = "Mode deteksi gerakan aktif. Bergeraklah ke kiri/kanan untuk menggerakkan mesin ARUNA.";
  }
}

let holdMs = 0;
function calibTick(dt) {
  if (state !== "calib" || ctl.mode === "pointer") return;
  holdMs = ctl.handsUp ? holdMs + dt * 1000 : Math.max(0, holdMs - dt * 2000);
  $("calHold").style.width = `${Math.min(100, holdMs / 8)}%`;
  if (holdMs >= 800) { holdMs = 0; startGame(); }
}

function startGame() {
  if (state !== "calib") return;
  state = "play";
  show(null);
  items = []; floats = []; parts = [];
  score = 0; lives = LIVES; caught = 0; combo = 0; mult = 1;
  tStart = performance.now();
  spawnAt = tStart + 600;
  $("hud").hidden = false;
  $("hMult").hidden = true;
  $("hScore").textContent = "0";
  $("hTime").textContent = ROUND_SEC;
  $("hLives").textContent = "🌱".repeat(LIVES);
  $("hGas").style.width = "0";
  beep(660, 0.15); setTimeout(() => beep(990, 0.2), 150);
}

async function endGame() {
  state = "result";
  items = [];
  $("hud").hidden = true;
  $("hMult").hidden = true;
  beep(784, 0.15); setTimeout(() => beep(1046, 0.3), 160);

  const kg = caught * KG_PER_ITEM;
  const liters = kg * BIOGAS_L_PER_KG;
  const tier = TIERS.find((t) => score >= t.min);
  const entry = { ...player0, skor: score, kode: newCode() };

  $("rTier").textContent = tier.icon;
  $("rTitle").textContent = `${tier.title}, ${player0.nama.split(" ")[0]}!`;
  $("rScore").textContent = score;
  $("rKg").textContent = kg.toFixed(1).replace(".", ",");
  $("rGas").textContent = Math.round(liters);
  $("rMin").textContent = Math.round(liters / STOVE_L_PER_MIN);
  $("rCode").textContent = entry.kode;
  $("rFact").textContent = pick(FACTS);
  $("rRank").textContent = "Menyimpan skor…";
  show("scrResult");
  renderHof(hofTop, $("hofResult"));

  let n = IDLE_RESULT_SEC;
  $("rCount").textContent = n;
  clearInterval(idleTimer);
  idleTimer = setInterval(() => {
    $("rCount").textContent = --n;
    if (n <= 0) goHome();
  }, 1000);

  entry.id = push(ref(rtdb, "halloffame")).key;
  try {
    myEntryId = await saveWithTimeout(entry);
    const higher = await get(query(ref(rtdb, "halloffame"), orderByChild("skor"), startAfter(score)));
    if (state === "result") $("rRank").textContent = `Peringkat #${higher.size + 1} di Hall of Fame`;
    renderHof(hofTop, $("hofResult"), myEntryId);
  } catch (e) {
    console.warn("Simpan skor gagal, masuk antrean", e);
    storePending([...loadPending(), entry]);
    if (state === "result") $("rRank").textContent = "Skor tersimpan di perangkat, akan dikirim saat online.";
  }
}

$("bPlay").addEventListener("click", () => openForm("game"));
$("bPhoto").addEventListener("click", () => openForm("foto"));
$("bResPhoto").addEventListener("click", () => openPhoto());
$("bBack").addEventListener("click", goHome);
$("bCalBack").addEventListener("click", goHome);
$("bStart").addEventListener("click", startGame);
$("bDone").addEventListener("click", goHome);

/* ---------------- Foto bareng (logbook) ---------------- */

const PH_W = 800, PH_H = 600;
const PH_DONE_SEC = 15;
const phView = $("phView");
const phCtx = phView.getContext("2d");
const photo = { phase: "off", hold: 0, data: null };

function setPhase(phase) {
  photo.phase = phase;
  $("phLive").hidden = phase !== "live";
  $("phReview").hidden = phase !== "review";
  $("phDone").hidden = phase !== "done";
  $("phHoldBar").hidden = phase !== "live" || ctl.mode !== "pose";
}

// Frame kamera (dicerminkan seperti cermin) + bingkai ARUNA dengan nama & instansi
function composePhoto(g) {
  g.save();
  g.fillStyle = "#0B3B26";
  g.fillRect(0, 0, PH_W, PH_H);
  if (video.readyState >= 2) {
    const vw = video.videoWidth, vh = video.videoHeight;
    const sc = Math.max(PH_W / vw, PH_H / vh);
    const dw = vw * sc, dh = vh * sc;
    g.translate(PH_W, 0);
    g.scale(-1, 1);
    g.drawImage(video, (PH_W - dw) / 2, (PH_H - dh) / 2, dw, dh);
  }
  g.restore();

  const band = 150;
  const grad = g.createLinearGradient(0, PH_H - band - 60, 0, PH_H);
  grad.addColorStop(0, "rgba(11,59,38,0)");
  grad.addColorStop(0.35, "rgba(11,59,38,.85)");
  grad.addColorStop(1, "rgba(11,59,38,.95)");
  g.fillStyle = grad;
  g.fillRect(0, PH_H - band - 60, PH_W, band + 60);

  if (machine.ready) {
    const mh = 170, mw = mh * machine.sw / machine.sh;
    g.drawImage(machine.img, machine.sx, machine.sy, machine.sw, machine.sh, PH_W - mw - 24, PH_H - mh - 14, mw, mh);
  }
  const p = player0 || { nama: "", instansi: "" };
  g.fillStyle = "#fff";
  g.textAlign = "left";
  g.textBaseline = "alphabetic";
  g.font = '800 40px "Plus Jakarta Sans",sans-serif';
  g.fillText(p.nama, 32, PH_H - 92, PH_W - 200);
  g.font = '600 26px "Plus Jakarta Sans",sans-serif';
  g.fillStyle = "rgba(255,255,255,.85)";
  g.fillText(p.instansi, 32, PH_H - 56, PH_W - 200);
  g.font = '700 18px "Plus Jakarta Sans",sans-serif';
  g.fillStyle = "#F4B63A";
  const tgl = new Date().toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" });
  g.fillText(`ARUNA · PAMERAN INOVASI · ${tgl.toUpperCase()}`, 32, PH_H - 24, PH_W - 200);
}

async function openPhoto() {
  clearInterval(idleTimer);
  if (!player0) return goHome();
  state = "photo";
  $("hud").hidden = true;
  show("scrPhoto");
  $("phTitle").textContent = `Foto bareng ARUNA, ${player0.nama.split(" ")[0]}!`;
  $("phHint").textContent = "Menyalakan kamera…";
  $("cam").hidden = true;
  photo.data = null;
  setPhase("live");
  try {
    await startCamera();
    $("cam").hidden = true;   // pratinjau kecil tidak perlu, kamera tampil besar di sini
    $("phHint").textContent = ctl.mode === "pose"
      ? "Ajak temanmu masuk frame. Angkat kedua tangan atau tekan tombol untuk hitung mundur."
      : "Ajak temanmu masuk frame, lalu tekan tombol untuk hitung mundur.";
    setPhase("live");
  } catch (e) {
    console.warn(e);
    $("phHint").textContent = "Kamera tidak tersedia. Pastikan izin kamera diberikan, lalu coba lagi.";
  }
  resetPhotoIdle();
}

function resetPhotoIdle() {
  clearInterval(idleTimer);
  let idle = 0;
  idleTimer = setInterval(() => {
    if (state !== "photo") return clearInterval(idleTimer);
    if (photo.phase === "done") {
      $("phCountdown").textContent = Math.max(0, PH_DONE_SEC - ++idle);
      if (idle >= PH_DONE_SEC) goHome();
    } else if (photo.phase !== "saving" && ++idle > 90) goHome();
  }, 1000);
}

function stopPhoto() {
  photo.phase = "off";
  photo.data = null;
  $("phCount").hidden = true;
}

function startCountdown() {
  if (photo.phase !== "live" || video.readyState < 2) return;
  setPhase("count");
  resetPhotoIdle();
  let n = 3;
  const el = $("phCount");
  const tick = () => {
    if (photo.phase !== "count") return;
    if (n === 0) {
      el.hidden = true;
      composePhoto(phCtx);
      photo.data = phView.toDataURL("image/jpeg", 0.75);
      if (photo.data.length > 380000) photo.data = phView.toDataURL("image/jpeg", 0.55);
      const f = $("phFlash"); f.hidden = false; setTimeout(() => { f.hidden = true; }, 500);
      beep(1200, 0.08, "square", 0.1);
      $("phHint").textContent = "Suka hasilnya? Simpan ke logbook, atau ulangi.";
      setPhase("review");
      return;
    }
    el.textContent = n;
    el.hidden = false;
    el.style.animation = "none"; void el.offsetWidth; el.style.animation = "";
    beep(660, 0.1);
    n--;
    setTimeout(tick, 1000);
  };
  tick();
}

async function savePhoto() {
  if (photo.phase !== "review" || !photo.data) return;
  setPhase("saving");
  $("phHint").textContent = "Menyimpan…";
  const entry = { type: "foto", id: push(ref(rtdb, "logbook")).key, ...player0, foto: photo.data };
  try {
    await saveWithTimeout(entry);
    $("phHint").textContent = "Tersimpan! Fotomu sudah tampil di aruna-id.web.app/logbook";
  } catch (e) {
    console.warn("Simpan foto gagal, masuk antrean", e);
    storePending([...loadPending(), entry]);
    $("phHint").textContent = "Foto tersimpan di perangkat dan akan diunggah saat online.";
  }
  if (state !== "photo") return;
  $("phCountdown").textContent = PH_DONE_SEC;
  setPhase("done");
  resetPhotoIdle();
}

function photoTick(dt) {
  if (state !== "photo") return;
  if (photo.phase === "live" || photo.phase === "count") composePhoto(phCtx);
  if (photo.phase === "live" && ctl.mode === "pose") {
    photo.hold = ctl.handsUp ? photo.hold + dt * 1000 : Math.max(0, photo.hold - dt * 2000);
    $("phHold").style.width = `${Math.min(100, photo.hold / 8)}%`;
    if (photo.hold >= 800) { photo.hold = 0; startCountdown(); }
  }
}

$("bShoot").addEventListener("click", startCountdown);
$("bRetake").addEventListener("click", () => {
  photo.data = null;
  $("phHint").textContent = "Siap? Angkat kedua tangan atau tekan tombol.";
  setPhase("live");
});
$("bSave").addEventListener("click", savePhoto);
$("bPhBack").addEventListener("click", goHome);
$("bPhDone").addEventListener("click", goHome);

/* ---------------- Loop utama ---------------- */

function frame(now) {
  const dt = Math.min(0.05, (now - (lastT || now)) / 1000);
  lastT = now;
  if (ctl.mode !== "pointer") {
    try { updateController(now); } catch (e) { console.warn(e); }
  }
  calibTick(dt);
  photoTick(dt);
  step(dt, now);
  draw(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
