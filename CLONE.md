# 이 레포를 clone/fork해서 쓰는 법

이 트래커는 길드 멤버들의 과제 진행 상태(미진행/진행중/평가중/완료)를 수집해 보여준다.
과제 축은 **과정별 마스터 목록(getUqstnlist)** 기준이며, 실패 시 배정된 과제만으로 폴 백한다.
별도 인프라(로스터 허브·세션 동기화) **없이도** 단독으로 돌아간다.

## 1. fork/clone 후 해야 할 일

### (1) Repository Secret 등록 (필수)

| Secret | 값 |
|---|---|
| `CODYSSEY_SESSION` | `JSESSIONID=xxxx` 형태의 쿠키 문자열. usr.codyssey.kr 로그인 후 개발자도구 → Application → Cookies에서 복사 |

- 세션 만료 시 수집이 안내와 함께 스킵/실패한다. 새 값으로 교체할 것 (수동 갱신 모델)
- `HUB_PAT`은 **등록하지 않아도 된다**

### (2) 대상 길드/시즌 변경 (자기 기수에 맞게)

`collect_quest.js`의 환경변수 기본값:

| 변수 | 기본값 | 의미 |
|---|---|---|
| `GUILD_IDS` | `3,4,5,6` | 대상 길드 ID (콤마 구분) |
| `GUILD_SEASON` | `5` | 길드 시즌 |
| `GUILD_WEEK` | `9` | 주차 |

Actions에서 바꾸려면 `.github/workflows/collect.yml`의 수집 step `env:`에 추가하거나,
로컬 실행 시 `GUILD_IDS=... node collect_quest.js`처럼 넘긴다.

### (3) GitHub Pages 활성화

Settings → Pages → Source를 **GitHub Actions**로 설정. 데이터 커밋 후 `Deploy Dashboard`
워크플로가 자동 배포한다.

## 2. 로스터(명부)는 어떻게 얻나 — 허브 없어도 됨

```
로스터 허브(비공개, HUB_PAT 있을 때만)  →  actions/cache 로스터(8시간 이내)  →  길드 API 직접 조회
```

허브 없는 클로너는 자동으로 캐시→길드 API 경로를 쓴다. 추가 설정 없음.

## 3. 외부 워치독 (선택)

GitHub 스케줄러 정전 대비:
[giyeop-cody/codyssey_watchdog](https://github.com/giyeop-cody/codyssey_watchdog) 참고.

- `collect.yml`의 `repository_dispatch(external-collect)` 트리거는 이미 이 레포에 있음
- worker를 fork해 `OWNER`/`TARGETS`를 자기 레포로 바꾼 뒤 `GH_TOKEN`에 자기 PAT 등록

## 4. 안 되는 것 / 주의

- **세션 자동 갱신 없음** — 만료 시 Secret을 직접 갱신해야 한다.
- 과제 마스터 조회(getUqstnlist)도 세션으로 인증된다. 세션이 없거나 실패하면
  배정된 과제만 표시되는 census 모드로 자동 폴 백한다 (JSON의 `meta.questMaster`로 확인).
- 원작자 레포의 데이터와 무관하게 **완전히 자기 대상만** 수집된다.
