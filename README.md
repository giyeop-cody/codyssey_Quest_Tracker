# 📋 Codyssey 과제 진행도 트래커 (Quest Progress Tracker)

codyssey.kr의 과제(퀘스트) 진행 상태를 GitHub Actions가 주기적으로 수집해,
길드별·전체 멤버의 과제별 상태 분포(미진행/진행중/평가중/완료)와 비율을
GitHub Pages 정적 대시보드로 보여줍니다.

> 조회 API는 공식 공개 API가 아닌 **사이트 내부 호출 재사용**입니다.
> 약관/운영정책을 확인하고 본인 계정 세션 범위에서만 사용하세요.

---

## 대시보드

- URL: `https://<owner>.github.io/codyssey_Quest_Tracker/`
- 과제 카드마다 상태 스택바 + 인원 + 비율 표시
- 카드 클릭 → 상태별 멤버 목록 모달 (완료는 PASS/FAIL·점수 표기)
- 길드 칩(전체/길드별)으로 집계 범위 전환, 칩 숫자는 해당 길드 인원 수

## 상태 정의

| 표시 | 기준 |
|---|---|
| 미진행 | 평가 상태 `대기중` (과제 미시작) |
| 진행중 | 평가 상태 `진행중` + 예약된 평가 슬롯 **없음** |
| 평가중 | 평가 상태 `진행중` + 예약된 평가 슬롯 **있음** (슬롯 과제명과 매칭) |
| 완료 | 평가 상태 `완료` (PASS/FAIL 구분은 별도 표기) |

집계 규칙:

- 길드 귀속: 멤버는 소속 첫 길드로만 집계 (이중 집계 방지)
- 멤버의 평가 목록에 없는 과제는 그 멤버 집계에서 제외 (미배정 과제를 미진행으로 치지 않음)
- 비율은 각 과제별 집계 대상 인원 대비 % (소수 첫째 자리)

## 데이터 흐름

```
codyssey.kr (읽기 전용)
  ├─ ev/request/mbrSearch/searchList   멤버×과제 평가 상태
  └─ schedule/scheduleAllList          예약 평가 슬롯 (진행중/평가중 구분)
        ↓ collect_quest.js (Actions, 30분 주기)
docs/data/current.json  →  GitHub Pages (docs/)
```

로스터(길드 멤버 명부)는 공유 허브 [`codyssey_roster_hub`](https://github.com/giyeop-cody/codyssey_roster_hub)(비공개)의
신선본을 우선 사용하고(`codyssey_commons`의 페처 경유), 없으면 actions/cache → 길드 API 순으로 폰백합니다.
허브 로스터에는 시즌/주차 메타가 실려 있어 시즌 전환 시 허브 vars만 바꾸면 전 트래커가 따라갑니다.

## Fork해서 사용하는 방법

1. 이 레포를 **Public**으로 fork (Public이면 Actions·Pages가 무료)
2. Repository Secrets 등록:
   - `CODYSSEY_SESSION`: codyssey.kr 로그인 세션의 `JSESSIONID` 값
   - `HUB_PAT` (선택): 허브 로스터를 쓰려면 허브 레포 Contents 읽기 권한의 PAT. 없어도 길드 API로 자체 수집
3. Settings → Pages → Build and deployment = **GitHub Actions**
4. Actions 탭에서 `Collect Quest Progress` 수동 실행 → 첫 데이터 커밋 → Pages 자동 배포

## 개발 및 테스트

```bash
npm test          # 진행도 집계 코어 단위 테스트 (node:test, 외부 의존성 없음)
npm run check     # 문법 체크
npm run collect   # 로컬 수집 (CODYSSEY_SESSION 필요)
```

## 비용 메모

- Public 레포라 Actions·Pages 무료.
- 수집 1회당 멤버 수×2건의 GET/POST만 발생 (149명 기준 약 300건, 수 분 내 완료).
- 같은 세션 쿠키를 EV/Jail 트래커와 공유하며, 허브가 세션을 주기적으로 갱신·동기화한다.
