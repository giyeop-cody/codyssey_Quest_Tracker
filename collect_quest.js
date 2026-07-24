"use strict";

// codyssey_Quest_Tracker — 과제 진행도 수집기.
// 길드 로스터(허브 캐시 우선, 없으면 길드 API 직접)의 전 멤버에 대해
//   1) ev/request/mbrSearch/searchList  (멤버×과제 상태)
//   2) schedule/scheduleAllList          (활성 평가 슬롯 — 진행중/평가중 구분용)
// 를 읽어 docs/data/current.json으로 집계한다. 읽기 전용 (쓰기 API 없음).
// 세션은 CODYSSEY_SESSION만 사용 (자동 로그인은 허브가 담당).
//
// 실행: node collect_quest.js

const fs = require("fs");
const {
  STATUS_ORDER,
  STATUS_LABEL,
  activeSlotTitles,
  memberProgress,
  aggregate,
  collectAssignments,
  buildQuestAxis,
} = require("./lib/progress-core.cjs");

const API_BASE = "https://api.usr.codyssey.kr/";
const INST_CD = process.env.INST_CD || "00021";
const GUILD_IDS = (process.env.GUILD_IDS || "3,4,5,6").split(",").map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite);
const DELAY_MS = parseInt(process.env.DELAY_MS || "120", 10);
const ROSTER_FILE = process.env.QUEST_ROSTER_FILE || ".roster-cache/roster.json";
const OUT_FILE = process.env.OUT_FILE || "docs/data/current.json";
const SLOT_BEFORE_D = parseInt(process.env.SLOT_BEFORE_D || "14", 10);
const SLOT_AFTER_D = parseInt(process.env.SLOT_AFTER_D || "14", 10);
const MAX_EVAL_PAGES = 3; // 인당 최대 100행+ (과제 수는 십여 개)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeSession(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (s.startsWith("JSESSIONID=")) return s;
  try {
    const j = JSON.parse(s);
    if (j && j.JSESSIONID) return `JSESSIONID=${j.JSESSIONID}`;
  } catch (_) { /* 값만 온 경우 */ }
  return `JSESSIONID=${s}`;
}

const SESSION = normalizeSession(process.env.CODYSSEY_SESSION);

function headers(extra = {}) {
  return {
    Cookie: SESSION,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Accept-Language": "ko-KR,ko;q=0.9",
    "X-Requested-With": "XMLHttpRequest",
    ...extra,
  };
}

function sessionError(res) {
  const err = new Error(`SESSION_EXPIRED(${res.status})`);
  err.sessionInvalid = true;
  return err;
}

async function getJson(url) {
  const res = await fetch(url, { headers: headers(), redirect: "manual" });
  if (res.status === 401 || res.status === 403) throw sessionError(res);
  if (res.status >= 300 && res.status < 400) throw sessionError(res);
  const json = await res.json().catch(() => null);
  if (!json || json.code !== 200) throw new Error(`${url} → code=${json && json.code} (HTTP ${res.status})`);
  return json.result;
}

async function postForm(endpoint, params) {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" }),
    redirect: "manual",
    body: new URLSearchParams(params),
  });
  if (res.status === 401 || res.status === 403) throw sessionError(res);
  const text = await res.text();
  if (res.status >= 300 && res.status < 400) throw sessionError(res);
  const json = JSON.parse(text);
  if (!json || json.code !== 200) throw new Error(`${endpoint} → code=${json && json.code} (HTTP ${res.status})`);
  return json.result;
}

/* ---------------- 로스터 ---------------- */
function loadCachedRoster() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ROSTER_FILE, "utf-8"));
    const ok = parsed && typeof parsed.fetchedAt === "string"
      && Array.isArray(parsed.guilds) && parsed.guilds.length
      && Array.isArray(parsed.members) && parsed.members.length;
    if (ok) return parsed;
  } catch (_) { /* 캐시 없음 */ }
  return null;
}

async function fetchRosterViaApi(season, week) {
  const guilds = [];
  const memberMap = new Map();
  for (const gid of GUILD_IDS) {
    const data = await getJson(`${API_BASE}guild/${gid}/detail?guildSeasonId=${season}&weekNo=${week}`);
    const name = data && data.guildInfo && data.guildInfo.guildNm;
    guilds.push({ guildId: gid, guildName: name, currentRanking: data.guildInfo.currentRanking, totalScore: data.guildInfo.totalScore });
    for (const m of (data && data.members) || []) {
      if (m && m.mbrId != null && !memberMap.has(m.mbrId)) {
        memberMap.set(m.mbrId, { mbrId: m.mbrId, name: m.mbrNm, level: m.level, guildNames: [name] });
      }
    }
    await sleep(DELAY_MS);
  }
  if (!memberMap.size) throw new Error("길드 멤버 0명 — 수집 실패로 간주");
  return { fetchedAt: new Date().toISOString(), season, week, guilds, members: [...memberMap.values()] };
}

async function loadRoster() {
  const cached = loadCachedRoster();
  if (cached) {
    const ageH = (Date.now() - Date.parse(cached.fetchedAt)) / 3600000;
    if (ageH < 8) {
      console.log(`로스터 캐시 사용 (${cached.members.length}명, ${ageH.toFixed(1)}시간 경과, meta ${cached.season}/${cached.week})`);
      return cached;
    }
    console.log(`로스터 캐시 만료 (${ageH.toFixed(1)}시간) → 길드 API 갱신 시도`);
    const season = Number.isFinite(cached.season) ? cached.season : parseInt(process.env.GUILD_SEASON || "5", 10);
    const week = Number.isFinite(cached.week) ? cached.week : parseInt(process.env.GUILD_WEEK || "9", 10);
    try {
      const fresh = await fetchRosterViaApi(season, week);
      saveRosterCache(fresh);
      return fresh;
    } catch (err) {
      if (err.sessionInvalid) throw err;
      // 갱신 실패/0명(사이트 멤버십 초기화 등) → 마지막 알려진 명부로 폴 백 (Jail과 동일 정책)
      console.warn(`⚠️ 길드 API 갱신 실패 (${err.message}) — ${ageH.toFixed(1)}시간 된 캐시 ${cached.members.length}명으로 폴 백`);
      return cached;
    }
  }
  console.log("로스터 캐시 없음 → 길드 API");
  const fresh = await fetchRosterViaApi(parseInt(process.env.GUILD_SEASON || "5", 10), parseInt(process.env.GUILD_WEEK || "9", 10));
  saveRosterCache(fresh);
  return fresh;
}

function saveRosterCache(roster) {
  try {
    fs.mkdirSync(require("path").dirname(ROSTER_FILE), { recursive: true });
    fs.writeFileSync(ROSTER_FILE, JSON.stringify(roster));
    console.log(`로스터 캐시 저장 (${roster.members.length}명 → ${ROSTER_FILE})`);
  } catch (err) {
    console.warn(`⚠️ 로스터 캐시 저장 실패 (${err.message}) — 다음 run은 허브/API에서 다시 시도`);
  }
}

/* ---------------- 평가 목록 / 슬롯 ---------------- */
async function fetchMemberEvals(mbrId) {
  const out = [];
  for (let page = 1; page <= MAX_EVAL_PAGES; page++) {
    const result = await postForm("ev/request/mbrSearch/searchList", {
      mbrId: String(mbrId), instCd: INST_CD, page: String(page), pagePerRows: "50", orderBy: "DESC",
    });
    const list = Array.isArray(result) ? result : (result && result.list) || [];
    out.push(...list);
    if (list.length < 50) break;
    await sleep(DELAY_MS);
  }
  return out;
}

function ymdDot(d) {
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
}

async function fetchActiveSlotTitles(mbrId) {
  const now = Date.now();
  const bgng = ymdDot(new Date(now - SLOT_BEFORE_D * 86400000));
  const end = ymdDot(new Date(now + SLOT_AFTER_D * 86400000));
  const result = await postForm(`schedule/scheduleAllList/?mbrId=${mbrId}&instCd=${INST_CD}&bgngYmd=${bgng}&endYmd=${end}&scheduleType=request`, {});
  return activeSlotTitles(result && result.reqList);
}

/* ---------------- 과제 마스터 축 (getUqstnlist) ----------------
 * census 행의 (projectNo, lcorsNo) 페어를 dedupe해 과정별 전체 과제 목록을 읽는다.
 * 잡히면 census에 배정 0명인 과제도 축에 포함된다. 실패 시 census 축으로 폴 백한다. */
async function fetchMasterCourses(evalRowsByMember) {
  const seen = new Map(); // "projectNo|lcorsNo" → {projectNo, lcorsNo, lcorsNm, projectNm}
  for (const rows of evalRowsByMember.values()) {
    for (const row of rows || []) {
      if (!row || row.projectNo == null || row.lcorsNo == null) continue;
      const key = `${row.projectNo}|${row.lcorsNo}`;
      if (!seen.has(key)) {
        seen.set(key, {
          projectNo: row.projectNo,
          lcorsNo: row.lcorsNo,
          lcorsNm: String(row.lcorsNm || ""),
          projectNm: String(row.projectNm || ""),
        });
      }
    }
  }
  if (!seen.size) throw new Error("census 행에 projectNo/lcorsNo 없음");
  const courses = [];
  for (const c of seen.values()) {
    const result = await postForm("learning/learningProgress/getUqstnlist", {
      projectNo: String(c.projectNo), lcorsNo: String(c.lcorsNo), teamSn: "0",
    });
    const list = Array.isArray(result) ? result : (result && result.uqstnList) || [];
    if (!list.length) throw new Error(`getUqstnlist 빈 목록 (과정 ${c.projectNo}/${c.lcorsNo})`);
    courses.push({ ...c, quests: list });
    await sleep(DELAY_MS);
  }
  return courses;
}

/* ---------------- 메인 ---------------- */
(async () => {
  const started = Date.now();
  if (!SESSION) {
    console.error("❌ CODYSSEY_SESSION 미등록 — 수집 불가");
    process.exit(3);
  }
  console.log(`▶ 과제 진행도 수집 (대상 길드 ${GUILD_IDS.join("/")})`);
  const roster = await loadRoster();
  const members = roster.members;
  console.log(`대상 멤버 ${members.length}명`);

  const evalRowsByMember = new Map();
  const slotTitlesByMember = new Map();
  let failed = 0;
  for (const [i, m] of members.entries()) {
    try {
      evalRowsByMember.set(m.mbrId, await fetchMemberEvals(m.mbrId));
      slotTitlesByMember.set(m.mbrId, await fetchActiveSlotTitles(m.mbrId));
    } catch (err) {
      if (err.sessionInvalid) throw err;
      failed += 1;
      console.warn(`  ⚠️ 멤버 sha1:${
        require("crypto").createHash("sha1").update(String(m.mbrId)).digest("hex").slice(0, 8)
      } 조회 실패 (${err.message}) — 제외`);
      evalRowsByMember.delete(m.mbrId);
      slotTitlesByMember.delete(m.mbrId);
    }
    if ((i + 1) % 25 === 0) console.log(`  ...진행 ${i + 1}/${members.length}`);
    await sleep(DELAY_MS);
  }
  if (failed > members.length * 0.2) throw new Error(`멤버 조회 실패 과다 (${failed}/${members.length}) — 수집 중단`);

  const censusAssignments = collectAssignments(evalRowsByMember);

  // 과제 마스터 축: 전체 과정 과제 목록을 축으로 (실패 시 census 축 폴 백)
  let assignments = censusAssignments;
  let questMaster = "census";
  try {
    const masterCourses = await fetchMasterCourses(evalRowsByMember);
    const axis = buildQuestAxis(censusAssignments, masterCourses);
    const added = axis.length - censusAssignments.length;
    assignments = axis;
    questMaster = "getUqstnlist";
    console.log(`마스터 축 적용: 과정 ${masterCourses.length}개 → 과제 ${axis.length}종 (미배정 +${added}, census ${censusAssignments.length}종)`);
  } catch (err) {
    if (err.sessionInvalid) throw err;
    console.warn(`⚠️ 마스터 축 조회 실패 (${err.message}) — census 축으로 진행`);
  }

  const memberEntries = [];
  const covered = new Set();
  for (const m of members) {
    const rows = evalRowsByMember.get(m.mbrId);
    if (!rows) continue; // 조회 실패 제외
    covered.add(m.mbrId);
    memberEntries.push({
      mbrId: String(m.mbrId),
      name: m.name,
      level: m.level ?? null,
      guild: (m.guildNames || [])[0] || "미배정",
      progress: memberProgress(rows, slotTitlesByMember.get(m.mbrId)),
    });
  }

  // 집계 대상은 "모든 과제를 본 멤버"만이 아니다 — 멤버에게 없는 과제는 집계에서 빠진다 (aggregate 내 처리).
  const aggBySubject = aggregate(memberEntries, assignments);

  const out = {
    meta: {
      generatedAt: new Date().toISOString(),
      season: roster.season ?? null,
      week: roster.week ?? null,
      members: covered.size,
      membersTotal: members.length,
      failed,
      guilds: roster.guilds || [],
      statusLabel: STATUS_LABEL,
      statusOrder: STATUS_ORDER,
      questMaster, // "getUqstnlist" | "census" (마스터 조회 실패 시 폴 백)
      slotWindow: `±${SLOT_BEFORE_D}/${SLOT_AFTER_D}d`,
      durationSec: Math.round((Date.now() - started) / 1000),
    },
    assignments,
    aggregates: aggBySubject,
    // 멤버별 상세 (대시보드 모달용) — 이름/길드는 공개 대시보드 표기용 데이터로만.
    members: memberEntries.map((e) => ({
      mbrId: e.mbrId,
      name: e.name,
      level: e.level,
      guild: e.guild,
      progress: Object.fromEntries(e.progress),
    })),
  };

  fs.mkdirSync(require("path").dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(out));
  const allScope = (no) => aggBySubject[no] && aggBySubject[no].ALL;
  console.log(`✅ 완료: 과제 ${assignments.length}종 / 멤버 ${covered.size}명 (${Math.round((Date.now() - started) / 1000)}s)`);
  for (const a of assignments) {
    const s = allScope(a.uqstnNo);
    console.log(`  - ${a.uqstnNm}: 미진행 ${s.M} / 진행중 ${s.P} / 평가중 ${s.E} / 완료 ${s.C} (PASS ${s.pass}, FAIL ${s.fail})`);
  }
})().catch((err) => {
  if (err.sessionInvalid) {
    console.error("❌ 세션 만료 — 허브 동기화 또는 대시보드 로그인으로 CODYSSEY_SESSION 갱신 필요");
    process.exit(3);
  }
  console.error("❌ 수집 실패:", err.message || err);
  process.exit(2);
});
