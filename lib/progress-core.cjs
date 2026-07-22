"use strict";

// 과제 진행도 코어 (순수 함수 — 테스트 대상)
//
// 상태 (디스커버리 실측, 2026-07-20 · 149명/397행):
//   searchList evlStusCd — 00001 대기중 / 00002 진행중 / 00003 완료
// 매핑 (사용자 확정):
//   M 미진행 ← 00001
//   P 진행중 ← 00002 + 잡힌 평가 슬롯 없음
//   E 평가중 ← 00002 + 해당 과제에 활성 평가 슬롯 있음
//   C 완료   ← 00003 (PASS/FAIL/점수는 부가 표기)

const STATUS_ORDER = ["M", "P", "E", "C"];
const STATUS_LABEL = { M: "미진행", P: "진행중", E: "평가중", C: "완료" };

// searchList 행의 기반 상태 (슬롯 미반영)
function baseStatus(row) {
  const cd = String(row && row.evlStusCd || "");
  if (cd === "00003") return "C";
  if (cd === "00002") return "P";
  return "M"; // 00001 및 알 수 없는 코드는 미진행으로 보수 처리
}

// 과제 식별자 — uqstnNo가 과제 고유 번호. 없으면 evlNo로 대체.
function subjectKey(row) {
  return String((row && (row.uqstnNo || row.evlNo)) || "");
}

// scheduleAllList reqList에서 활성 평가(EV) 슬롯의 과제명 집합을 만든다.
// 종결 코드(완료 00006, 취소 00005, 거절 00004)는 제외한다.
function activeSlotTitles(reqList) {
  const titles = new Set();
  for (const row of reqList || []) {
    if (!row || row.scdlGubunCd !== "EV") continue;
    const fixed = String(row.fixedCd || "");
    if (fixed === "00006" || fixed === "00005" || fixed === "00004") continue;
    const title = String(row.title || "").trim();
    if (title) titles.add(title);
  }
  return titles;
}

// 슬롯 반영 최종 상태: 기반이 P이고 과제명이 활성 슬롯에 있으면 E.
function finalStatus(row, slotTitles) {
  const st = baseStatus(row);
  if (st === "P" && slotTitles && slotTitles.has(String(row.uqstnNm || "").trim())) return "E";
  return st;
}

// 멤버 1명의 searchList 행들을 상태 맵으로: { uqstnKey: { st, resultNm, score, uqstnNm, lcorsNm, evlNo, evlDegr } }
function memberProgress(rows, slotTitles) {
  const map = new Map();
  for (const row of rows || []) {
    const key = subjectKey(row);
    if (!key) continue;
    const st = finalStatus(row, slotTitles);
    map.set(key, {
      st,
      resultNm: row.evlResltNm || null,
      score: row.evlScr != null && row.evlScr !== "" ? Number(row.evlScr) : null,
      uqstnNm: row.uqstnNm || "",
      lcorsNm: row.lcorsNm || "",
      evlNo: String(row.evlNo || ""),
      evlDegr: String(row.evlDegr != null ? row.evlDegr : ""),
    });
  }
  return map;
}

// 집계: 과제 × (전체/길드) 상태 카운트. 멤버는 소속 첫 길드에 귀속 (이중 집계 방지).
function aggregate(memberEntries, assignments) {
  const zero = () => ({ M: 0, P: 0, E: 0, C: 0, pass: 0, fail: 0 });
  const agg = new Map(); // key: `${uqstnNo}|${scope}`
  const bump = (uqstnNo, scope, st, resultNm) => {
    const k = `${uqstnNo}|${scope}`;
    if (!agg.has(k)) agg.set(k, zero());
    const a = agg.get(k);
    a[st] += 1;
    if (st === "C") {
      if (resultNm === "FAIL") a.fail += 1;
      else a.pass += 1;
    }
  };

  for (const entry of memberEntries) {
    const guild = entry.guild || "미배정";
    for (const subject of assignments) {
      const prog = entry.progress.get(subject.uqstnNo);
      // 그 멤버의 목록에 아예 없는 과제는 그 멤버의 대상 과제가 아닌 것으로 간주 (집계 제외)
      if (!prog) continue;
      bump(subject.uqstnNo, "ALL", prog.st, prog.resultNm);
      bump(subject.uqstnNo, guild, prog.st, prog.resultNm);
    }
  }

  const withRatio = (k) => {
    const a = agg.get(k) || zero();
    const total = a.M + a.P + a.E + a.C;
    const ratio = {};
    for (const st of STATUS_ORDER) ratio[st] = total ? Math.round((a[st] / total) * 1000) / 10 : 0;
    return { ...a, total, ratio };
  };

  const scopes = ["ALL", ...new Set(memberEntries.map((e) => e.guild || "미배정"))];
  const out = {};
  for (const subject of assignments) {
    out[subject.uqstnNo] = {};
    for (const scope of scopes) out[subject.uqstnNo][scope] = withRatio(`${subject.uqstnNo}|${scope}`);
  }
  return out;
}

// 날짜 정규화: "2026.07.21" / "20260721" / "2026-07-21" → "2026-07-21"
function fmtYmd(v) {
  if (v == null || v === "") return null;
  const d = String(v).replace(/[^0-9]/g, "");
  if (d.length !== 8) return String(v);
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

// 마스터 축: 과정별 마스터 과제 목록(getUqstnlist)과 census 과제를 병합한다.
// - 정렬: 과정은 masterCourses 배열 순 (수집기에서 census 첫 목격 순으로 넘김), 과정 내는 uqstnSqnt 오름차순
// - census에 아직 배정 0명인 마스터 과제도 축에 포함 (대시보드에 미배정 카드로 표시)
// - 마스터에 없는 census 과제는 뒤에 보존 (fromMaster: false)
function buildQuestAxis(censusAssignments, masterCourses) {
  const used = new Set();
  const axis = [];
  for (const course of masterCourses || []) {
    const quests = [...(course.quests || [])]
      .filter((q) => q && q.uqstnNo != null && String(q.useYn || "Y") === "Y")
      .sort((a, b) => (Number(a.uqstnSqnt) || 0) - (Number(b.uqstnSqnt) || 0));
    for (const q of quests) {
      const no = String(q.uqstnNo);
      if (used.has(no)) continue;
      used.add(no);
      axis.push({
        uqstnNo: no,
        uqstnNm: String(q.uqstnNm || "?"),
        lcorsNm: String(course.lcorsNm || q.lcorsNm || ""),
        courseNm: String(course.projectNm || ""),
        uqstnSqnt: q.uqstnSqnt != null && q.uqstnSqnt !== "" ? Number(q.uqstnSqnt) : null,
        requiredYn: q.requiredYn === "N" ? "N" : "Y",
        lrnBgngYmd: fmtYmd(q.lrnBgngYmd),
        lrnEndYmd: fmtYmd(q.lrnEndYmd),
        learningTm: q.uqstnLearningTm != null && q.uqstnLearningTm !== "" ? Number(q.uqstnLearningTm) : null,
        fromMaster: true,
      });
    }
  }
  for (const a of censusAssignments || []) {
    const no = String(a.uqstnNo);
    if (used.has(no)) continue;
    used.add(no);
    axis.push({ uqstnNo: no, uqstnNm: a.uqstnNm, lcorsNm: a.lcorsNm || "", fromMaster: false });
  }
  return axis;
}

// 과제 마스터 목록 (첫 목격 순서 유지)
function collectAssignments(evalRowsByMember) {
  const seen = new Map();
  for (const rows of evalRowsByMember.values()) {
    for (const row of rows || []) {
      const key = subjectKey(row);
      if (key && !seen.has(key)) {
        seen.set(key, { uqstnNo: key, uqstnNm: row.uqstnNm || "?", lcorsNm: row.lcorsNm || "" });
      }
    }
  }
  return [...seen.values()];
}

module.exports = {
  STATUS_ORDER,
  STATUS_LABEL,
  baseStatus,
  subjectKey,
  activeSlotTitles,
  finalStatus,
  memberProgress,
  aggregate,
  collectAssignments,
  fmtYmd,
  buildQuestAxis,
};
