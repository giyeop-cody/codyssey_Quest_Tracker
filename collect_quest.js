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
  memberProgress,
  aggregate,
  collectAssignments,
  buildQuestAxis,
  rankEntries,
} = require("./lib/progress-core.cjs");
const crypto = require("crypto");

/* 공개 JSON에 개인 식별자(mbrId)를 원문으로 싣지 않는다.
 * 10자리 숫자(1000 접두) 형식의 값·객체 키를 sha1 앞 8자리로 마스킹한다.
 * 해시는 결정적이라 직전 파일과의 조인 키로 계속 사용할 수 있다. */
const PUBLIC_ID_RE = /^1000\d{6}$/;
function maskPublicId(s) {
  return "sha1:" + crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 8);
}
function maskPublicIds(v) {
  if (typeof v === "string" || typeof v === "number") {
    return PUBLIC_ID_RE.test(String(v)) ? maskPublicId(v) : v;
  }
  if (Array.isArray(v)) return v.map(maskPublicIds);
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[PUBLIC_ID_RE.test(k) ? maskPublicId(k) : k] = maskPublicIds(x);
    return o;
  }
  return v;
}

const API_BASE = "https://api.usr.codyssey.kr/";
const INST_CD = process.env.INST_CD || "00021";
const GUILD_IDS = (process.env.GUILD_IDS || "27,28,29,30").split(",").map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite);
const DELAY_MS = parseInt(process.env.DELAY_MS || "120", 10);
const ROSTER_FILE = process.env.QUEST_ROSTER_FILE || ".roster-cache/roster.json";
const OUT_FILE = process.env.OUT_FILE || "docs/data/current.json";
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

/* ---------------- 정적 데이터 캐시 (.quest-cache) ----------------
 * 과제 마스터(getUqstnlist)·requireYn(status/list)은 시즌 내 사실상 정적 — run마다 재조회하지 않고
 * actions/cache로 run 간 유지하며 TTL 7일로 갱신한다 (2026-08-01 리팩토링 승인안 ②). */
const QCACHE_DIR = process.env.QUEST_CACHE_DIR || ".quest-cache";
const QCACHE_TTL_MS = 7 * 24 * 3600 * 1000;
function qcacheGet(name) {
  try {
    const f = require("path").join(QCACHE_DIR, name);
    if (Date.now() - fs.statSync(f).mtimeMs > QCACHE_TTL_MS) return null;
    return JSON.parse(fs.readFileSync(f, "utf-8"));
  } catch (_) { return null; }
}
function qcacheSet(name, val) {
  try {
    fs.mkdirSync(QCACHE_DIR, { recursive: true });
    fs.writeFileSync(require("path").join(QCACHE_DIR, name), JSON.stringify(val));
  } catch (_) { /* 캐시 실패는 무시 — 다음 run 재조회 */ }
}

/* ---------------- 평가 목록 / 슬롯 ---------------- */
/* 허브 census 통합 (2026-08-02 승인안 ③): 신선(≤120분) census.json이 있으면
 * 멤버별 mbrSearch 폴 링을 생략하고 허브 수집행을 소비한다. 없으면 자체 폴 링. */
const CENSUS_FILE = process.env.QUEST_CENSUS_FILE || ".census-cache/census.json";
function loadCensus() {
  try {
    const d = JSON.parse(fs.readFileSync(CENSUS_FILE, "utf-8"));
    if (d && d.byMember && typeof d.fetchedAt === "string") return d;
  } catch (_) { /* 없음 → 자체 폴 링 */ }
  return null;
}

async function fetchMemberEvals(mbrId, census) {
  if (census && Object.prototype.hasOwnProperty.call(census.byMember, String(mbrId))) {
    return census.byMember[String(mbrId)] || [];
  }
  const out = [];
  for (let page = 1; page <= MAX_EVAL_PAGES; page++) {
    const result = await postForm("ev/request/mbrSearch/searchList", {
      mbrId: String(mbrId), instCd: INST_CD, page: String(page), pagePerRows: "200", orderBy: "DESC",
    });
    const list = Array.isArray(result) ? result : (result && result.list) || [];
    out.push(...list);
    if (list.length < 200) break;
    await sleep(DELAY_MS);
  }
  return out;
}

function ymdDot(d) {
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
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
  let cacheHits = 0;
  for (const c of seen.values()) {
    const ckey = `master-${c.projectNo}-${c.lcorsNo}.json`;
    let list = qcacheGet(ckey);
    if (!list) {
      const result = await postForm("learning/learningProgress/getUqstnlist", {
        projectNo: String(c.projectNo), lcorsNo: String(c.lcorsNo), teamSn: "0",
      });
      list = Array.isArray(result) ? result : (result && result.uqstnList) || [];
      if (!list.length) throw new Error(`getUqstnlist 빈 목록 (과정 ${c.projectNo}/${c.lcorsNo})`);
      qcacheSet(ckey, list);
      await sleep(DELAY_MS);
    } else cacheHits++;
    courses.push({ ...c, quests: list });
  }
  if (cacheHits) console.log(`  과제 마스터 캐시 적중 ${cacheHits}/${courses.length} (호출 생략)`);
  return courses;
}

/* ---------------- status/list requireYn 오버레이 ----------------
 * getUqstnlist의 requiredYn이 7/24 배포 이후 전건 null로 날아와 신뢰 불가 (2026-07-25 실측).
 * status/list의 requireYn은 과목/과제 속성이라 오버레이 소스로 쓴다. 실패하면 null(확인불가) 유지. */
async function fetchStatusRequireMap() {
  let list = qcacheGet("status-list.json");
  if (!list) {
    const data = await getJson(`${API_BASE}learning/learningProgress/status/list`);
    list = (data && data.uqstns) || [];
    // 빈 응답은 캐시하지 않는다 — 일시적 이상(네트워크/세션)이 7일(TTL) 동안 requireYn 오버레이를 비우는 것 방지
    if (list.length) qcacheSet("status-list.json", list);
  }
  const map = new Map();
  for (const q of list) {
    if (q && q.uqstnNo != null && (q.requireYn === "Y" || q.requireYn === "N")) {
      map.set(String(q.uqstnNo), q.requireYn);
    }
  }
  return map;
}

/* ---------------- 경험치 수집 (user/getStudyUsers) ----------------
 * 이 엔드포인트는 10행 캡 + 페이지네이션 없음 (07-25 실측)이라 전수 조회는 불가.
 * 대신 로스터 이름으로 1명씩 검색하고, 반환 행 중 mbrId가 정확히 일치하는 것만 채택한다.
 * 동명이인 3쌍 존재 확인 — 이름 매칭만으로는 모호하므로 mbrId 매칭이 필수다. */
async function fetchStudyInfo(mbrId, name) {
  const result = await postForm("user/getStudyUsers/", { search: String(name) });
  const list = Array.isArray(result) ? result : (result && result.list) || [];
  const hit = list.find((row) => row && String(row.mbrId) === String(mbrId));
  if (!hit) return null;
  // 주의: profImgPath(사용자 업로드 파일명)/recntCntnDt(최근 접속 시각)는 공개 JSON에 싣지 않는다
  // (행동 감시·실명 파일명 노출 방지, 2026-07-25 프라이버시 점검). 가져오는 것도 exp/pnt뿐.
  return {
    exp: hit.exp != null ? Number(hit.exp) : null,
    pnt: hit.pnt != null ? Number(hit.pnt) : null,
  };
}

/* ---------------- 메인 ---------------- */
(async () => {
  const started = Date.now();
  if (!SESSION) {
    console.error("❌ CODYSSEY_SESSION 미등록 — 수집 불가");
    process.exit(3);
  }
  console.log(`▶ 과제 진행도 수집 (대상 길드 ${GUILD_IDS.join("/")})`);

  // ── 수집 간격 하한 게이트 (2026-08-01 리팩토링 승인안 ①)
  // 마지막 성공 수집(OUT_FILE meta.generatedAt) 후 COLLECT_MIN_INTERVAL_MIN분(기본 60) 미만이면
  // codyssey 호출 0건으로 종료. 4중 크론 실측 ~74회/일 중복 발화 대응. 우회: COLLECT_FORCE=1.
  const minGapMin = parseInt(process.env.COLLECT_MIN_INTERVAL_MIN || "60", 10);
  if (process.env.COLLECT_FORCE !== "1" && minGapMin > 0) {
    try {
      const prev = JSON.parse(fs.readFileSync(OUT_FILE, "utf-8"));
      const last = prev && prev.meta && prev.meta.generatedAt ? Date.parse(prev.meta.generatedAt) : 0;
      const ageMin = last ? (Date.now() - last) / 60000 : Infinity;
      if (ageMin < minGapMin) {
        console.log(`⏭️ 수집 간격 하한(${minGapMin}분) 미만 — 마지막 수집 ${Math.floor(ageMin)}분 전. 스킵 (codyssey 호출 0건)`);
        process.exit(0);
      }
    } catch (_) { /* 파일 없음 → 첫 수집 진행 */ }
  }

  const roster = await loadRoster();
  const members = roster.members;
  console.log(`대상 멤버 ${members.length}명`);

  const census = loadCensus();
  if (census) {
    const ageMin = Math.round((Date.now() - Date.parse(census.fetchedAt)) / 60000);
    console.log(`  허브 census 사용 (${census.members}명/${census.rows}행, ${ageMin}분 전본)`);
  }
  const evalRowsByMember = new Map();
  let failed = 0;
  let censusHits = 0, apiCalls = 0;
  for (const [i, m] of members.entries()) {
    try {
      const fromCensus = census && Object.prototype.hasOwnProperty.call(census.byMember, String(m.mbrId));
      evalRowsByMember.set(m.mbrId, await fetchMemberEvals(m.mbrId, census));
      if (fromCensus) censusHits++; else apiCalls++;
    } catch (err) {
      if (err.sessionInvalid) throw err;
      failed += 1;
      console.warn(`  ⚠️ 멤버 sha1:${
        require("crypto").createHash("sha1").update(String(m.mbrId)).digest("hex").slice(0, 8)
      } 조회 실패 (${err.message}) — 제외`);
      evalRowsByMember.delete(m.mbrId);
    }
    if ((i + 1) % 25 === 0) console.log(`  ...진행 ${i + 1}/${members.length}`);
    const covered = census && Object.prototype.hasOwnProperty.call(census.byMember, String(m.mbrId));
    if (!covered) await sleep(DELAY_MS);
  }
  if (census) console.log(`  census 커버 ${censusHits}명 / 자체 호출 ${apiCalls}명 (호출 절감 ${censusHits}회)`);
  if (failed > members.length * 0.2) throw new Error(`멤버 조회 실패 과다 (${failed}/${members.length}) — 수집 중단`);

  const censusAssignments = collectAssignments(evalRowsByMember);

  // 경험치 센서스 서브사이클 (2026-08-02 리팩토링 승인안): exp/pnt는 천천히 변하는 부가 정볘이므로
  // 30분 메인 주기와 분리해 STUDY_MIN_INTERVAL_MIN분(기본 60)마다만 getStudyUsers를 호출한다.
  // 신선하면 직전 current.json의 members[].exp/pnt를 재사용 → 호출 150회/run → 150회/h로 감소 (-50%).
  const studyGapMin = parseInt(process.env.STUDY_MIN_INTERVAL_MIN || "60", 10);
  const studyByMember = new Map();
  let expMiss = 0;
  let prevStudy = null;
  try {
    const prev = JSON.parse(fs.readFileSync(OUT_FILE, "utf-8"));
    const prevAt = prev && prev.meta && prev.meta.studyFetchedAt ? Date.parse(prev.meta.studyFetchedAt) : 0;
    if (prevAt && (Date.now() - prevAt) / 60000 < studyGapMin && Array.isArray(prev.members)) {
      prevStudy = { fetchedAt: prev.meta.studyFetchedAt, members: prev.members };
    }
  } catch (_) { /* 직전 파일 없음 → 신규 수집 */ }
  if (prevStudy) {
    for (const pm of prevStudy.members) {
      if (pm && (pm.exp != null || pm.pnt != null)) {
        studyByMember.set(String(pm.mbrId), { exp: pm.exp ?? null, pnt: pm.pnt ?? null });
      }
    }
    expMiss = (prevStudy.members || []).length - studyByMember.size;
    console.log(`  경험치 서브사이클: ${studyGapMin}분 이내 → 직전 수집분 재사용 (${studyByMember.size}명, 호출 0)`);
  } else {
    for (const m of members) {
      try {
        const info = await fetchStudyInfo(m.mbrId, m.name);
        if (info) studyByMember.set(String(m.mbrId), info); else expMiss += 1;
      } catch (err) {
        if (err.sessionInvalid) throw err;
        expMiss += 1;
      }
      await sleep(DELAY_MS);
    }
    console.log(`  경험치 수집: ${studyByMember.size}명 확보${expMiss ? ` (미발견/실패 ${expMiss}명)` : ""}`);
  }

  // 과제 마스터 축: 전체 과정 과제 목록을 축으로 (실패 시 census 축 폴 백)
  let assignments = censusAssignments;
  let questMaster = "census";
  // requireYn 오버레이 (status/list 실측) — 실패필드 null 대응. 실패 시 미적용으로 진행
  let requireMap = null;
  try {
    requireMap = await fetchStatusRequireMap();
    console.log(`  requireYn 오버레이: ${requireMap.size}건 (status/list)`);
  } catch (err) {
    if (err.sessionInvalid) throw err;
    console.warn(`  ⚠️ status/list 조회 실패 (${err.message}) — requireYn 확인불가로 진행`);
  }
  try {
    const masterCourses = await fetchMasterCourses(evalRowsByMember);
    const axis = buildQuestAxis(censusAssignments, masterCourses, { requireMap });
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
      // 직전 파일의 식별자는 마스킹(sha1:8)된 키일 수 있어 양쪽으로 조회한다
      ...(studyByMember.get(String(m.mbrId)) || studyByMember.get(maskPublicId(m.mbrId)) || {}), // exp/pnt (미발견 시 부재)
      progress: memberProgress(rows),
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
      durationSec: Math.round((Date.now() - started) / 1000),
      studyFetchedAt: prevStudy ? prevStudy.fetchedAt : new Date().toISOString(), // 서브사이클 기준 시각
    },
    assignments,
    aggregates: aggBySubject,
    // 멤버별 상세 (대시보드 모달용) — 이름/길드는 공개 대시보드 표기용 데이터로만.
    members: memberEntries.map((e) => ({
      mbrId: e.mbrId,
      name: e.name,
      level: e.level,
      guild: e.guild,
      exp: e.exp ?? null,
      pnt: e.pnt ?? null,
      // 주의: profImg/recntCntnDt는 공개 JSON에 싣지 않는다 (2026-07-25 프라이버시 점검)
      progress: Object.fromEntries(e.progress),
    })),
  };
  // 랭커 보드: 레벨↓→경험치↓ (경험치 소스 user/getStudyUsers, mbrId 매칭)
  out.ranks = rankEntries(out.members);
  out.meta.expMiss = expMiss;
  out.meta.rankSource = "user/getStudyUsers (mbrId 매칭)";

  fs.mkdirSync(require("path").dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(maskPublicIds(out)));
  const allScope = (no) => aggBySubject[no] && aggBySubject[no].ALL;
  console.log(`✅ 완료: 과제 ${assignments.length}종 / 멤버 ${covered.size}명 (${Math.round((Date.now() - started) / 1000)}s)`);
  for (const a of assignments) {
    const s = allScope(a.uqstnNo);
    console.log(`  - ${a.uqstnNm}: 미시작 ${s.N} / 미진행 ${s.M} / 평가중 ${s.E} / 완료 ${s.C} (PASS ${s.pass}, FAIL ${s.fail})`);
  }
})().catch((err) => {
  if (err.sessionInvalid) {
    console.error("❌ 세션 만료 — 허브 동기화 또는 대시보드 로그인으로 CODYSSEY_SESSION 갱신 필요");
    process.exit(3);
  }
  console.error("❌ 수집 실패:", err.message || err);
  process.exit(2);
});
