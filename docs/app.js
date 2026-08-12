"use strict";

const STATUS_ORDER = ["N", "M", "E", "C"];
const SEG_CLASS = { N: "segN", M: "segM", E: "segE", C: "segC" };

const state = { data: null, guild: "ALL" };

function fmtKst(iso) {
  try {
    return new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false });
  } catch (_) { return iso; }
}

function scopeOf(subject) {
  const a = subject.aggregates || {};
  return a[state.guild] || a.ALL || null;
}

function aggregateFor(subjNo) {
  const zero = { N: 0, M: 0, E: 0, C: 0, pass: 0, fail: 0, total: 0, ratio: { N: 0, M: 0, E: 0, C: 0 } };
  const agg = state.data.aggregates[subjNo] || {};
  const a = agg[state.guild] || agg.ALL;
  if (!a) return zero;
  // 구 포맷 데이터(P 상태, N 없음) 과도기 호환 — 다음 수집에서 신 포맷으로 갱신됨
  return { ...zero, ...a, ratio: { ...zero.ratio, ...(a.ratio || {}) } };
}

function memberCountOfGuild(guildName) {
  if (!state.data) return 0;
  const set = new Set();
  for (const m of state.data.members) {
    if (guildName === "ALL" || m.guild === guildName) set.add(m.mbrId);
  }
  return set.size;
}

function renderGuildChips() {
  const wrap = document.getElementById("guildChips");
  wrap.innerHTML = "";
  const guilds = (state.data.meta.guilds || []).map((g) => g.guildName).filter(Boolean);
  for (const name of ["ALL", ...guilds]) {
    const chip = document.createElement("button");
    chip.className = "chip" + (state.guild === name ? " active" : "");
    chip.innerHTML = `${name === "ALL" ? "전체" : name} <span class="cnt">${memberCountOfGuild(name)}</span>`;
    chip.onclick = () => { state.guild = name; renderGuildChips(); renderCards(); };
    wrap.appendChild(chip);
  }
}

function barHtml(a) {
  const parts = [];
  for (const st of STATUS_ORDER) {
    const v = a[st];
    if (!v || !a.total) continue;
    const w = (v / a.total) * 100;
    parts.push(`<div class="${SEG_CLASS[st]}" style="width:${w}%" title="${state.data.meta.statusLabel[st]} ${v}명">${v >= 2 ? v : ""}</div>`);
  }
  return `<div class="bar">${parts.join("") || '<div style="width:100%;background:#0a0e14"></div>'}</div>`;
}

function countsHtml(a) {
  const L = state.data.meta.statusLabel;
  const fail = a.fail ? ` · <span class="failNote">FAIL ${a.fail}</span>` : "";
  return `<div class="counts">
    <span>${L.N} <b>${a.N}</b></span><span>${L.M} <b>${a.M}</b></span>
    <span>${L.E} <b>${a.E}</b></span><span>${L.C} <b>${a.C}</b>${fail}</div>
  <div class="ratio">비율 — ${STATUS_ORDER.map((st) => `${L[st]} ${a.ratio[st]}%`).join(" · ")} (총 ${a.total}명 기준)</div>`;
}

// "2026-07-21" → "07.21"
function md(iso) { return iso ? String(iso).slice(5).replace("-", ".") : ""; }
function periodOf(s) {
  if (s.lrnBgngYmd && s.lrnEndYmd) return `${md(s.lrnBgngYmd)} ~ ${md(s.lrnEndYmd)}`;
  if (s.lrnBgngYmd) return `${md(s.lrnBgngYmd)} ~`;
  return "";
}
// 학습시간 단위는 소스 미확인 — 분으로 추정해 표기 (확정 아님)
function tmOf(s) {
  if (s.learningTm == null) return "";
  return s.learningTm < 600 ? `${s.learningTm}분(추정)` : `${(s.learningTm / 60).toFixed(1)}시간(추정)`;
}
function questMetaHtml(s) {
  if (!s.fromMaster) return "";
  const parts = [s.requiredYn === "N" ? "선택" : (s.requiredYn === "Y" ? "필수" : "필수정보 없음")];
  const p = periodOf(s);
  if (p) parts.push(p);
  const t = tmOf(s);
  if (t) parts.push(t);
  return `<p class="qmeta">${parts.map(escapeHtml).join(" · ")}</p>`;
}

function renderCards() {
  const main = document.getElementById("cards");
  main.innerHTML = "";
  const list = state.data.assignments || [];
  if (!list.length) { main.innerHTML = '<p class="empty">데이터가 아직 없습니다.</p>'; return; }
  for (const subj of list) {
    const a = aggregateFor(subj.uqstnNo);
    // total 은 스코프 전체 멤버 수 — 착수(M+E+C)가 0명이면 미시작 100% 카드로 표기
    const empty = !a.total || (a.M + a.E + a.C) === 0;
    const card = document.createElement("article");
    card.className = "card" + (empty ? " empty" : "");
    card.innerHTML = `<h3>${escapeHtml(subj.uqstnNm)}</h3>
      <p class="track">${escapeHtml(subj.lcorsNm || "")}</p>
      ${questMetaHtml(subj)}
      ${empty ? '<div class="noassign">아직 착수한 멤버 없음 (미시작 100%)</div>' : barHtml(a) + countsHtml(a)}`;
    card.onclick = () => openModal(subj);
    main.appendChild(card);
  }
}

function openModal(subj) {
  const L = state.data.meta.statusLabel;
  const inGuild = (m) => state.guild === "ALL" || m.guild === state.guild;
  const rows = state.data.members.filter(inGuild)
    .map((m) => ({ m, p: m.progress[subj.uqstnNo] || null, st: m.progress[subj.uqstnNo] ? m.progress[subj.uqstnNo].st : "N" }));
  const body = document.getElementById("modalBody");
  document.getElementById("modalTitle").textContent = `${subj.uqstnNm} — 멤버 목록 (${state.guild === "ALL" ? "전체" : state.guild})`;
  body.innerHTML = "";
  for (const st of STATUS_ORDER) {
    const group = rows.filter((x) => x.st === st);
    if (!group.length) continue;
    const h = document.createElement("div");
    h.className = "stGroup";
    group.sort((a, b) => String(a.m.name).localeCompare(String(b.m.name), "ko"));
    h.innerHTML = `<h4>${L[st]} (${group.length})</h4><ul>${group.map(({ m, p }) => {
      const extra = st === "C" && p
        ? `<span class="sc ${p.resultNm === "FAIL" ? "fail" : ""}">${p.resultNm || ""}${p.score != null ? ` · ${p.score}점` : ""}</span>`
        : "";
      return `<li><span>${escapeHtml(m.name)}</span><span class="g">${escapeHtml(m.guild)}${m.level != null ? ` · Lv.${m.level}` : ""}</span>${extra}</li>`;
    }).join("")}</ul>`;
    body.appendChild(h);
  }
  if (!body.children.length) body.innerHTML = rows.length
    ? '<p class="empty">해당 멤버가 없습니다.</p>'
    : '<p class="empty">아직 이 과제가 배정된 멤버가 없습니다.</p>';
  document.getElementById("modal").classList.remove("hidden");
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------- 랭커 보드 (레벨↓ → 경험치↓) ---------- */

function setView(v) {
  state.view = v;
  for (const btn of document.querySelectorAll("#viewTabs .vtab")) btn.classList.toggle("active", btn.dataset.view === v);
  document.getElementById("cards").classList.toggle("hidden", v !== "cards");
  document.getElementById("ranker").classList.toggle("hidden", v !== "ranker");
  document.getElementById("guildChips").classList.toggle("hidden", v !== "cards");
  document.getElementById("legend").classList.toggle("hidden", v !== "cards");
  if (v === "ranker") renderRanker();
}

function renderRanker() {
  if (!state.data) return;
  const note = document.getElementById("rankNote");
  const body = document.getElementById("rankBody");
  let ranks = state.data.ranks;
  if (!ranks || !ranks.length) {
    // 구 포맷 데이터 폴 백 — 레벨만으로 최소 정렬 (경험치는 "-" 표기)
    ranks = (state.data.members || []).map((m) => ({ ...m, exp: null, done: 0 }))
      .sort((a, b) => (b.level || 0) - (a.level || 0) || String(a.name).localeCompare(String(b.name), "ko"))
      .map((m, i) => ({ ...m, rank: i + 1 }));
  }
  const miss = state.data.meta.expMiss || 0;
  note.textContent = `레벨 → 경험치 순 (${ranks.length}명)` + (miss ? ` · 경험치 매칭 실패 ${miss}명은 "-" 표기` : "");
  const maxExp = Math.max(0, ...ranks.map((r) => r.exp || 0));
  body.innerHTML = ranks.map((r) => {
    const medal = r.rank === 1 ? "🥇" : r.rank === 2 ? "🥈" : r.rank === 3 ? "🥉" : `${r.rank}`;
    const expTxt = r.exp != null ? r.exp.toLocaleString("ko-KR") : "-";
    const w = r.exp != null && maxExp ? ((r.exp / maxExp) * 100).toFixed(1) : 0;
    return `<tr class="${r.rank <= 3 ? "top3" : ""}">
      <td class="rk">${medal}</td>
      <td class="nm">${escapeHtml(r.name)}</td>
      <td>${escapeHtml(r.guild)}</td>
      <td>Lv.${r.level != null ? r.level : "-"}</td>
      <td class="expCell"><div class="expBar" style="width:${w}%"></div><span>${expTxt}</span></td>
      <td>${r.done}개</td>
    </tr>`;
  }).join("");
}

async function boot() {
  try {
    const res = await fetch("data/current.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
  } catch (err) {
    document.getElementById("metaLine").textContent = `데이터 로드 실패: ${err.message} — 첫 수집 전일 수 있습니다.`;
    document.getElementById("cards").innerHTML = '<p class="empty">데이터 파일이 아직 없습니다. 수집 워크플로 첫 실행 후 표시됩니다.</p>';
    return;
  }
  const meta = state.data.meta;
  const emptyCount = (state.data.assignments || []).filter((s) => {
    const a = (state.data.aggregates[s.uqstnNo] || {}).ALL;
    return !a || (a.M + a.E + a.C) === 0;
  }).length;
  document.getElementById("metaLine").textContent =
    `마지막 수집: ${fmtKst(meta.generatedAt)} · 멤버 ${meta.members}명` +
    (meta.failed ? ` (조회 실패 ${meta.failed}명 제외)` : "") +
    ` · 시즌 ${meta.season ?? "-"} / 주차 ${meta.week ?? "-"}` +
    (meta.questMaster === "getUqstnlist"
      ? ` · 마스터 축 ${((state.data.assignments || []).length)}종${emptyCount ? ` (미착수 ${emptyCount}개 포함)` : ""}`
      : "");
  document.getElementById("modalClose").onclick = () => document.getElementById("modal").classList.add("hidden");
  document.getElementById("modal").onclick = (e) => { if (e.target.id === "modal") e.target.classList.add("hidden"); };
  for (const btn of document.querySelectorAll("#viewTabs .vtab")) btn.onclick = () => setView(btn.dataset.view);
  renderGuildChips();
  renderCards();
}

boot();
