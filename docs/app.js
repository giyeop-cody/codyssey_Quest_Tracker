"use strict";

const STATUS_ORDER = ["M", "P", "E", "C"];
const SEG_CLASS = { M: "segM", P: "segP", E: "segE", C: "segC" };

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
  const agg = state.data.aggregates[subjNo] || {};
  return agg[state.guild] || agg.ALL || { M: 0, P: 0, E: 0, C: 0, pass: 0, fail: 0, total: 0, ratio: { M: 0, P: 0, E: 0, C: 0 } };
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
    <span>${L.M} <b>${a.M}</b></span><span>${L.P} <b>${a.P}</b></span>
    <span>${L.E} <b>${a.E}</b></span><span>${L.C} <b>${a.C}</b>${fail}</div>
  <div class="ratio">비율 — ${STATUS_ORDER.map((st) => `${L[st]} ${a.ratio[st]}%`).join(" · ")} (대상 ${a.total}명)</div>`;
}

function renderCards() {
  const main = document.getElementById("cards");
  main.innerHTML = "";
  const list = state.data.assignments || [];
  if (!list.length) { main.innerHTML = '<p class="empty">데이터가 아직 없습니다.</p>'; return; }
  for (const subj of list) {
    const a = aggregateFor(subj.uqstnNo);
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `<h3>${escapeHtml(subj.uqstnNm)}</h3>
      <p class="track">${escapeHtml(subj.lcorsNm || "")}</p>
      ${barHtml(a)}${countsHtml(a)}`;
    card.onclick = () => openModal(subj);
    main.appendChild(card);
  }
}

function openModal(subj) {
  const L = state.data.meta.statusLabel;
  const inGuild = (m) => state.guild === "ALL" || m.guild === state.guild;
  const rows = state.data.members.filter(inGuild)
    .map((m) => ({ m, p: m.progress[subj.uqstnNo] }))
    .filter((x) => x.p);
  const body = document.getElementById("modalBody");
  document.getElementById("modalTitle").textContent = `${subj.uqstnNm} — 멤버 목록 (${state.guild === "ALL" ? "전체" : state.guild})`;
  body.innerHTML = "";
  for (const st of STATUS_ORDER) {
    const group = rows.filter((x) => x.p.st === st);
    if (!group.length) continue;
    const h = document.createElement("div");
    h.className = "stGroup";
    group.sort((a, b) => String(a.m.name).localeCompare(String(b.m.name), "ko"));
    h.innerHTML = `<h4>${L[st]} (${group.length})</h4><ul>${group.map(({ m, p }) => {
      const extra = st === "C"
        ? `<span class="sc ${p.resultNm === "FAIL" ? "fail" : ""}">${p.resultNm || ""}${p.score != null ? ` · ${p.score}점` : ""}</span>`
        : "";
      return `<li><span>${escapeHtml(m.name)}</span><span class="g">${escapeHtml(m.guild)}${m.level != null ? ` · Lv.${m.level}` : ""}</span>${extra}</li>`;
    }).join("")}</ul>`;
    body.appendChild(h);
  }
  if (!body.children.length) body.innerHTML = '<p class="empty">해당 멤버가 없습니다.</p>';
  document.getElementById("modal").classList.remove("hidden");
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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
  document.getElementById("metaLine").textContent =
    `마지막 수집: ${fmtKst(meta.generatedAt)} · 멤버 ${meta.members}명` +
    (meta.failed ? ` (조회 실패 ${meta.failed}명 제외)` : "") +
    ` · 시즌 ${meta.season ?? "-"} / 주차 ${meta.week ?? "-"}`;
  document.getElementById("modalClose").onclick = () => document.getElementById("modal").classList.add("hidden");
  document.getElementById("modal").onclick = (e) => { if (e.target.id === "modal") e.target.classList.add("hidden"); };
  renderGuildChips();
  renderCards();
}

boot();
