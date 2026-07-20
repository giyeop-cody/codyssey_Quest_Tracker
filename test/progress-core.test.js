"use strict";

// 과제 진행도 코어 단위 테스트 (순수 함수 — 네트워크 없음)

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  baseStatus,
  subjectKey,
  activeSlotTitles,
  finalStatus,
  memberProgress,
  aggregate,
  collectAssignments,
} = require("../lib/progress-core.cjs");

function row(cd, over = {}) {
  return { evlStusCd: cd, uqstnNo: "185012", uqstnNm: "SQL로 만드는 나만의 데이터베이스", lcorsNm: "데이터베이스와 백엔드", evlNo: "615026", evlDegr: "1", ...over };
}

test("baseStatus: 00003=C / 00002=P / 그 외=M", () => {
  assert.equal(baseStatus(row("00003")), "C");
  assert.equal(baseStatus(row("00002")), "P");
  assert.equal(baseStatus(row("00001")), "M");
  assert.equal(baseStatus(row(null)), "M");
  assert.equal(baseStatus(row("99999")), "M");
});

test("subjectKey: uqstnNo 우선, 없으면 evlNo", () => {
  assert.equal(subjectKey(row("00001")), "185012");
  assert.equal(subjectKey({ evlStusCd: "00001", evlNo: "615026" }), "615026");
  assert.equal(subjectKey({ evlStusCd: "00001" }), "");
});

test("activeSlotTitles: 활성 EV 슬롯만, 종결 코드 제외", () => {
  const titles = activeSlotTitles([
    { scdlGubunCd: "EV", fixedCd: "00001", title: "Mini Redis 구축" },
    { scdlGubunCd: "EV", fixedCd: "00006", title: "완료된 평가" },
    { scdlGubunCd: "EV", fixedCd: "00005", title: "취소된 평가" },
    { scdlGubunCd: "EV", fixedCd: "00004", title: "거절된 평가" },
    { scdlGubunCd: "AM", fixedCd: "00001", title: "학사일정은 버림" },
  ]);
  assert.deepEqual([...titles], ["Mini Redis 구축"]);
});

test("finalStatus: P + 활성 슬롯 과제명 일치 → E (평가중)", () => {
  const slots = new Set(["SQL로 만드는 나만의 데이터베이스"]);
  assert.equal(finalStatus(row("00002"), slots), "E");
  assert.equal(finalStatus(row("00002", { uqstnNm: "다른 과제" }), slots), "P");
  assert.equal(finalStatus(row("00003"), slots), "C"); // 완료는 슬롯 무관
  assert.equal(finalStatus(row("00001"), slots), "M"); // 미진행도 슬롯 무관
});

test("memberProgress: 결과/점수 보존 + 키 맵", () => {
  const prog = memberProgress([
    row("00003", { evlResltNm: "PASS", evlScr: "92" }),
    row("00001", { uqstnNo: "185008", uqstnNm: "Mini Redis 구축" }),
  ], new Set());
  assert.equal(prog.get("185012").resultNm, "PASS");
  assert.equal(prog.get("185012").score, 92);
  assert.equal(prog.get("185008").st, "M");
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

test("aggregate: 길드 귀속(첫 길드) + 목록에 없는 과제는 제외 + 비율", () => {
  const assignments = [{ uqstnNo: "185012", uqstnNm: "SQL", lcorsNm: "" }];
  const mk = (guild, st, resultNm) => ({
    guild,
    progress: new Map([["185012", { st, resultNm: resultNm || null }]]),
  });
  const entries = [mk("오션", "C", "PASS"), mk("오션", "C", "FAIL"), mk("오로라", "M", null)];
  const out = aggregate(entries, assignments);
  const all = out["185012"].ALL;
  assert.deepEqual({ M: all.M, P: all.P, E: all.E, C: all.C, pass: all.pass, fail: all.fail, total: all.total },
    { M: 1, P: 0, E: 0, C: 2, pass: 1, fail: 1, total: 3 });
  assert.equal(all.ratio.C, 66.7);
  assert.equal(out["185012"]["오션"].C, 2);
  assert.equal(out["185012"]["오로라"].M, 1);
  // 과제 목록에 없는 멤버는 집계에 안 들어감
  const noneEntry = aggregate([{ guild: "앰버", progress: new Map() }], assignments);
  assert.equal(noneEntry["185012"].ALL.total, 0);
});
