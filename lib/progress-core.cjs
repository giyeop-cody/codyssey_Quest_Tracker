"use strict";

// 과제 진행도 코어 (순수 함수 — 테스트 대상)
//
// 상태 (2026-07-25 사용자 확정 — 사이트 시맨틱 실측 반영):
//   searchList evlStusCd — 00001 대기중 / 00002 진행중 / 00003 완료
//   행 자체가 "과제 등록(착수)"을 뜻하고, 행이 없으면 아직 미착수다.
//   N 미시작 ← 멤버에게 해당 과제 행이 없음 (미노출 = 과제를 시작하지 않음)
//   M 미진행 ← 00001 대기중 (등록하고 작업 중)
//   E 평가중 ← 00002 진행중 (실제로 평가 받는 중 — 구 P(슬롯 미검출)는 여기 편입, 슬롯 판별 폐기)
//   C 완료   ← 00003 (PASS/FAIL/점수는 부가 표기)

const STATUS_ORDER = ["N", "M", "E", "C"];
const STATUS_LABEL = { N: "미시작", M: "미진행", E: "평가중", C: "완료" };

// searchList 행의 기반 상태 (슬롯 미반영)
function baseStatus(row) {
  const cd = String(row && row.evlStusCd || "");
  if (cd === "00003") return "C";
  if (cd === "00002") return "E"; // 진행중 = 실제로 평가 받는 중 (2026-07-25 사용자 확정)
  return "M"; // 00001 및 알 수 없는 코드는 미진행으로 보수 처리
}

// 과제 식별자 — uqstnNo가 과제 고유 번호. 없으면 evlNo로 대체.
function subjectKey(row) {
  return String((row && (row.uqstnNo || row.evlNo)) || "");
}

// 멤버 1명의 searchList 행들을 상태 맵으로: { uqstnKey: { st, resultNm, score, uqstnNm, lcorsNm, evlNo, evlDegr } }
function memberProgress(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const key = subjectKey(row);
    if (!key) continue;
    const st = baseStatus(row);
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
// 행이 없는 멤버는 미시작(N)으로 카운트한다 — 분모는 항상 스코프의 전체 멤버 수
// (2026-07-25 사용자 확정: 미노출 = 아직 과제를 시작하지 않은 멤버).
function aggregate(memberEntries, assignments) {
  const zero = () => ({ N: 0, M: 0, E: 0, C: 0, pass: 0, fail: 0 });
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
      // 행이 없으면 미시작(N) — 스코프 총원이 항상 분모가 되도록 매 과제마다 카운트
      const st = prog ? prog.st : "N";
      bump(subject.uqstnNo, "ALL", st, prog ? prog.resultNm : null);
      bump(subject.uqstnNo, guild, st, prog ? prog.resultNm : null);
    }
  }

  const withRatio = (k) => {
    const a = agg.get(k) || zero();
    const total = a.N + a.M + a.E + a.C;
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
// opts.requireMap: status/list 실측 requireYn (uqstnNo → "Y"|"N") — getUqstnlist의 requiredYn은
// 7/24 배포 이후 전건 null이 날아와 신뢰 불가라, 있으면 이 값을 우선한다 (2026-07-25 실측).
function buildQuestAxis(censusAssignments, masterCourses, opts = {}) {
  const requireMap = opts && opts.requireMap instanceof Map ? opts.requireMap : null;
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
        requiredYn: (() => {
          const ov = requireMap ? requireMap.get(no) : undefined;
          if (ov === "Y" || ov === "N") return ov;
          if (q.requiredYn === "Y" || q.requiredYn === "N") return q.requiredYn;
          return null; // 확인 불가 (필수/선택 표기 생략)
        })(),
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
  memberProgress,
  aggregate,
  collectAssignments,
  fmtYmd,
  buildQuestAxis,
};
