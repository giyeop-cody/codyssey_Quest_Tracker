"use strict";

// 과제 진행도 코어 단위 테스트 (순수 함수 — 네트워크 없음)

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  baseStatus,
  subjectKey,
  memberProgress,
  aggregate,
  collectAssignments,
  fmtYmd,
  buildQuestAxis,
  rankEntries,
} = require("../lib/progress-core.cjs");

function row(cd, over = {}) {
  return { evlStusCd: cd, uqstnNo: "185012", uqstnNm: "SQL로 만드는 나만의 데이터베이스", lcorsNm: "데이터베이스와 백엔드", evlNo: "615026", evlDegr: "1", ...over };
}

test("baseStatus: 00003=C / 00002=E(평가중, 07-25 확정) / 그 외=M", () => {
  assert.equal(baseStatus(row("00003")), "C");
  assert.equal(baseStatus(row("00002")), "E");
  assert.equal(baseStatus(row("00001")), "M");
  assert.equal(baseStatus(row(null)), "M");
  assert.equal(baseStatus(row("99999")), "M");
});

test("subjectKey: uqstnNo 우선, 없으면 evlNo", () => {
  assert.equal(subjectKey(row("00001")), "185012");
  assert.equal(subjectKey({ evlStusCd: "00001", evlNo: "615026" }), "615026");
  assert.equal(subjectKey({ evlStusCd: "00001" }), "");
});

test("memberProgress: 결과/점수 보존 + 키 맵 + 00002는 E", () => {
  const prog = memberProgress([
    row("00003", { evlResltNm: "PASS", evlScr: "92" }),
    row("00001", { uqstnNo: "185008", uqstnNm: "Mini Redis 구축" }),
    row("00002", { uqstnNo: "185010", uqstnNm: "포트폴리오" }),
  ]);
  assert.equal(prog.get("185012").resultNm, "PASS");
  assert.equal(prog.get("185012").score, 92);
  assert.equal(prog.get("185008").st, "M");
  assert.equal(prog.get("185010").st, "E");
});

test("collectAssignments: 첫 목격 순 유지 + 중복 제거", () => {
  const byMember = new Map([
    [1, [row("00003"), row("00001", { uqstnNo: "185008", uqstnNm: "Mini Redis 구축", lcorsNm: "자료구조" })]],
    [2, [row("00002")]], // 같은 과제 재등장
  ]);
  const list = collectAssignments(byMember);
  assert.equal(list.length, 2);
  assert.equal(list[0].uqstnNo, "185012");
  assert.equal(list[1].uqstnNm, "Mini Redis 구축");
});

test("fmtYmd: 구분자 섞인 날짜를 ISO로 정규화", () => {
  assert.equal(fmtYmd("2026.07.21"), "2026-07-21");
  assert.equal(fmtYmd("20260721"), "2026-07-21");
  assert.equal(fmtYmd("2026-07-21"), "2026-07-21");
  assert.equal(fmtYmd(""), null);
  assert.equal(fmtYmd(null), null);
  assert.equal(fmtYmd("UNKNOWN"), "UNKNOWN"); // 8자리 숫자 아니면 원형 유지
});

test("buildQuestAxis: 마스터 순서 + 미배정 과제 포함 + census 잔여 보존", () => {
  const census = [
    { uqstnNo: "185012", uqstnNm: "SQL", lcorsNm: "DB" },
    { uqstnNo: "999999", uqstnNm: "마스터에 없는 것", lcorsNm: "DB" },
  ];
  const masterCourses = [
    {
      lcorsNm: "DB", projectNm: "데이터베이스",
      quests: [
        // uqstnSqnt 뒤섞임 → 정렬돼야 함, useYn N → 제외
        { uqstnNo: 185013, uqstnNm: "FastAPI CRUD", uqstnSqnt: "3", requiredYn: "N", useYn: "Y",
          lrnBgngYmd: "2026.07.21", lrnEndYmd: "2026.07.27", uqstnLearningTm: "240" },
        { uqstnNo: 185012, uqstnNm: "SQL", uqstnSqnt: "1", requiredYn: "Y", useYn: "Y" },
        { uqstnNo: 185014, uqstnNm: "미배정 과제", uqstnSqnt: "2", requiredYn: "Y", useYn: "Y" },
        { uqstnNo: 185015, uqstnNm: "폐기된 과제", uqstnSqnt: "9", requiredYn: "Y", useYn: "N" },
      ],
    },
  ];
  const axis = buildQuestAxis(census, masterCourses);
  assert.deepEqual(axis.map((a) => a.uqstnNo), ["185012", "185014", "185013", "999999"]);
  assert.equal(axis[1].uqstnNm, "미배정 과제"); // census에 없어도 축에 포함
  assert.equal(axis[2].requiredYn, "N");
  assert.equal(axis[2].lrnBgngYmd, "2026-07-21");
  assert.equal(axis[2].lrnEndYmd, "2026-07-27");
  assert.equal(axis[2].learningTm, 240);
  assert.equal(axis[2].fromMaster, true);
  assert.equal(axis[3].fromMaster, false); // census 잔여는 뒤로
  // 빈 입력 안전
  assert.deepEqual(buildQuestAxis([], []), []);
  assert.equal(buildQuestAxis(census, [])[0].uqstnNo, "185012");
});

test("rankEntries: 레벨↓→경험치↓(null 최하)→이름, 완료 과제 수 부가", () => {
  const members = [
    { mbrId: "a", name: "가", guild: "오션", level: 3, exp: 100, progress: { x: { st: "C" }, y: { st: "C" } } },
    { mbrId: "b", name: "나", guild: "오로라", level: 5, exp: 50, progress: {} },
    { mbrId: "c", name: "다", guild: "앰버", level: 5, exp: 200, progress: { z: { st: "M" } } },
    { mbrId: "d", name: "라", guild: "시에나", level: 5, progress: {} }, // exp 없음 → 동레벨 최하
    { mbrId: "e", name: "마", guild: "오션", level: 6, exp: 10, progress: {} },
  ];
  const out = rankEntries(members);
  assert.deepEqual(out.map((r) => r.name), ["마", "다", "나", "라", "가"]); // Lv6 → Lv5(exp 200>50>없음) → Lv3
  assert.deepEqual(out.map((r) => r.rank), [1, 2, 3, 4, 5]);
  assert.equal(out[0].done, 0);
  assert.equal(out[4].done, 2); // 완료 과제 수 집계
  assert.equal(out[3].exp, null); // 미수집은 null 유지 (뷰에서 "-" 표기)
  assert.deepEqual(rankEntries([]), []);
});

test("aggregate: 미노출 멤버는 미시작(N) 카운트 — 분모는 스코프 총원 (07-25 확정)", () => {
  const assignments = [{ uqstnNo: "185012", uqstnNm: "SQL", lcorsNm: "" }];
  const mk = (guild, st, resultNm) => ({
    guild,
    progress: new Map([["185012", { st, resultNm: resultNm || null }]]),
  });
  const entries = [mk("오션", "C", "PASS"), mk("오션", "C", "FAIL"), mk("오로라", "M", null), { guild: "앰버", progress: new Map() }];
  const out = aggregate(entries, assignments);
  const all = out["185012"].ALL;
  assert.deepEqual({ N: all.N, M: all.M, E: all.E, C: all.C, pass: all.pass, fail: all.fail, total: all.total },
    { N: 1, M: 1, E: 0, C: 2, pass: 1, fail: 1, total: 4 });
  assert.equal(all.ratio.C, 50);
  assert.equal(all.ratio.N, 25);
  assert.equal(out["185012"]["오션"].C, 2);
  assert.equal(out["185012"]["오션"].total, 2);
  // 미노출 멤버는 해당 길드 스코프에 N으로 귀속
  assert.equal(out["185012"]["앰버"].N, 1);
  assert.equal(out["185012"]["앰버"].total, 1);
});

test("buildQuestAxis: requiredYn — 오버레이(status/list) 우선 / 소스 Y,N 유지 / null은 확인불가", () => {
  const masterCourses = [{
    lcorsNm: "DB", projectNm: "데이터베이스",
    quests: [
      { uqstnNo: 1, uqstnNm: "소스null", uqstnSqnt: "1", requiredYn: null },
      { uqstnNo: 2, uqstnNm: "소스Y", uqstnSqnt: "2", requiredYn: "Y" },
      { uqstnNo: 3, uqstnNm: "오버레이N", uqstnSqnt: "3", requiredYn: null },
    ],
  }];
  const axis = buildQuestAxis([], masterCourses, { requireMap: new Map([["3", "N"]]) });
  assert.equal(axis[0].requiredYn, null); // 필수정보 없음
  assert.equal(axis[1].requiredYn, "Y");
  assert.equal(axis[2].requiredYn, "N"); // 오버레이 우선
  // 오버레이 없이도 동작
  const plain = buildQuestAxis([], masterCourses);
  assert.equal(plain[0].requiredYn, null);
  assert.equal(plain[1].requiredYn, "Y");
});
