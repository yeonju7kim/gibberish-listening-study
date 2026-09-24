const state = {
  manifest: null,
  items: [],
  index: 0,
  rater: "",
  answers: {},
  itemStartedAt: 0,
  playStartedAt: null,
  listened: 0,
  plays: 0,
  sessionStartedAt: 0,
};

const $ = (id) => document.getElementById(id);

// --- Deterministic shuffle (unchanged) ---
function hashSeed(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed) {
  return function() {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function shuffled(items, seedText) {
  const out = [...items];
  const random = rng(hashSeed(seedText));
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// --- Storage ---
function storageKey() {
  return `${state.manifest.study_id}:${state.rater}`;
}

function save() {
  localStorage.setItem(storageKey(), JSON.stringify({
    answers: state.answers,
    order: state.items.map(x => x.item_id),
  }));
}

function loadSaved() {
  const raw = localStorage.getItem(storageKey());
  if (!raw) return;
  try {
    const saved = JSON.parse(raw);
    state.answers = saved.answers || {};
  } catch (_) {
    state.answers = {};
  }
}

// --- Page navigation ---
function showPage(id) {
  ["consent", "welcome", "study", "done"].forEach(p => {
    $(p).classList.toggle("hidden", p !== id);
  });
}

// --- Played time tracking ---
function closePlayInterval() {
  if (state.playStartedAt !== null) {
    state.listened += (performance.now() - state.playStartedAt) / 1000;
    state.playStartedAt = null;
  }
}

// --- Custom audio player ---
const audio = () => $("audio");

function formatTime(sec) {
  if (!isFinite(sec)) return "--:--";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function updatePlayerUI() {
  const a = audio();
  const pct = a.duration ? (a.currentTime / a.duration) * 100 : 0;
  $("player-fill").style.width = `${pct}%`;
  $("player-thumb").style.left = `${pct}%`;
  $("time-current").textContent = formatTime(a.currentTime);
  $("time-total").textContent = formatTime(a.duration);
  $("play-btn").innerHTML = a.paused ? "&#9654;" : "&#9646;&#9646;";
}

function seekBy(delta) {
  const a = audio();
  a.currentTime = Math.max(0, Math.min(a.duration || 0, a.currentTime + delta));
}

function setupPlayerBar() {
  const wrap = $("player-bar-wrap");

  function seekFromEvent(e) {
    const rect = wrap.getBoundingClientRect();
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    const pct = Math.max(0, Math.min(1, x / rect.width));
    const a = audio();
    if (a.duration) a.currentTime = pct * a.duration;
  }

  let dragging = false;
  wrap.addEventListener("mousedown", e => { dragging = true; seekFromEvent(e); });
  document.addEventListener("mousemove", e => { if (dragging) seekFromEvent(e); });
  document.addEventListener("mouseup", () => { dragging = false; });
  wrap.addEventListener("touchstart", e => { seekFromEvent(e); }, { passive: true });
  wrap.addEventListener("touchmove", e => { seekFromEvent(e); }, { passive: true });

  // Keyboard seek on the bar element
  wrap.addEventListener("keydown", e => {
    if (e.key === "ArrowLeft") { seekBy(-5); e.preventDefault(); }
    if (e.key === "ArrowRight") { seekBy(5); e.preventDefault(); }
  });
}

// --- Study item ---
function enableChoices(enable) {
  document.querySelectorAll("#choices button").forEach(b => b.disabled = !enable);
}

function showItem() {
  if (state.index >= state.items.length) {
    closePlayInterval();
    audio().pause();
    showPage("done");
    return;
  }
  const item = state.items[state.index];
  state.itemStartedAt = performance.now();
  state.playStartedAt = null;
  state.listened = 0;
  state.plays = 0;

  $("progress").textContent = `Sample ${state.index + 1} of ${state.items.length}`;
  $("item-title").textContent = `Audio sample ${state.index + 1}`;

  const a = audio();
  a.src = item.audio;
  a.load();
  updatePlayerUI();
  enableChoices(false);
}

function record(rating) {
  const a = audio();
  if (a.currentTime <= 0 && state.listened <= 0) return;
  closePlayInterval();
  const item = state.items[state.index];
  state.answers[item.item_id] = {
    rater_id: state.rater,
    item_id: item.item_id,
    rating: rating,
    technical_issue: 0,
    listen_seconds: Math.min(60, state.listened).toFixed(2),
    replay_count: state.plays,
    timestamp_utc: new Date().toISOString(),
  };
  save();
  state.index += 1;
  showItem();
}

// --- CSV helpers ---
function csvEscape(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function buildCsv() {
  const fields = ["rater_id", "item_id", "rating", "technical_issue",
                  "listen_seconds", "replay_count", "timestamp_utc"];
  const rows = state.items.map(item => state.answers[item.item_id]).filter(Boolean);
  return [fields.join(","),
    ...rows.map(row => fields.map(f => csvEscape(row[f])).join(","))
  ].join("\n") + "\n";
}

function downloadCsv() {
  const csv = buildCsv();
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `gibberish_listening_${state.rater}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function emailCsv() {
  const csv = buildCsv();
  const subject = encodeURIComponent(`Gibberish study response — ${state.rater}`);
  const body = encodeURIComponent(
    `Rater ID: ${state.rater}\nSubmitted: ${new Date().toISOString()}\n\n${csv}`
  );
  window.location.href = `mailto:yeonju7.kim@gmail.com?subject=${subject}&body=${body}`;
}

// --- Init ---
async function init() {
  state.manifest = await fetch("manifest.json").then(r => r.json());

  // Page 1: Consent
  $("consent-box").addEventListener("change", () => {
    $("consent-agree").disabled = !$("consent-box").checked;
  });
  $("consent-agree").addEventListener("click", () => showPage("welcome"));

  // Page 2: Rater ID
  $("start").addEventListener("click", () => {
    const rater = $("rater-id").value.trim().replace(/[^A-Za-z0-9_-]/g, "");
    if (!rater) { alert("Please enter your anonymous rater ID."); return; }
    state.rater = rater;
    state.items = shuffled(state.manifest.items, `${state.manifest.study_id}:${rater}`);
    loadSaved();
    state.index = state.items.findIndex(item => !state.answers[item.item_id]);
    if (state.index < 0) state.index = state.items.length;
    state.sessionStartedAt = performance.now();
    showPage("study");
    showItem();
  });

  // Audio player events
  const a = audio();
  a.addEventListener("timeupdate", updatePlayerUI);
  a.addEventListener("loadedmetadata", updatePlayerUI);
  a.addEventListener("play", () => {
    if (state.playStartedAt === null) state.playStartedAt = performance.now();
    state.plays += 1;
    enableChoices(true);
    updatePlayerUI();
  });
  a.addEventListener("pause", () => { closePlayInterval(); updatePlayerUI(); });
  a.addEventListener("ended", () => { closePlayInterval(); updatePlayerUI(); });

  $("play-btn").addEventListener("click", () => {
    if (a.paused) a.play(); else a.pause();
  });
  $("seek-back").addEventListener("click", () => seekBy(-5));
  $("seek-fwd").addEventListener("click", () => seekBy(5));

  setupPlayerBar();

  // Rating buttons
  document.querySelectorAll("#choices button").forEach(button => {
    button.addEventListener("click", () => record(Number(button.dataset.rating)));
  });

  // Download / Email
  $("download").addEventListener("click", downloadCsv);
  $("email-btn").addEventListener("click", emailCsv);

  // Keyboard shortcuts
  document.addEventListener("keydown", event => {
    if ($("study").classList.contains("hidden")) return;
    if (event.code === "Space") {
      event.preventDefault();
      if (a.paused) a.play(); else a.pause();
      return;
    }
    if (event.code === "ArrowLeft") { event.preventDefault(); seekBy(-5); return; }
    if (event.code === "ArrowRight") { event.preventDefault(); seekBy(5); return; }
    if (["1", "2", "3", "4"].includes(event.key)) record(Number(event.key));
  });

  // Elapsed timer
  setInterval(() => {
    if (!state.sessionStartedAt || $("study").classList.contains("hidden")) return;
    const minutes = Math.floor((performance.now() - state.sessionStartedAt) / 60000);
    $("elapsed").textContent = `${minutes} min elapsed`;
  }, 1000);
}

init().catch(error => {
  document.body.innerHTML = `<main><section class="card"><h1>Could not load study</h1><pre>${error}</pre><p>Serve this directory over HTTP (e.g., <code>python -m http.server 8001 --directory formal_site</code>).</p></section></main>`;
});
