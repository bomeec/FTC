# matchCourt

테니스 복식 코트 배정 웹 앱. 멤버/코트/라운드를 설정하면 매 라운드 코트별 인원을 자동 배정합니다.

## 주요 규칙

- 매 라운드 전원 참여(쉬는 사람 없음): 코트 수 × 4 = 멤버 수
- 코트 타입: 남복 / 여복 / 혼복 / 잡복(남3여1·여3남1)
- 홀수 구성(잡복)은 최소화하고, 가능하면 랠리 코트로 배치
- 4라운드 중 남복·여복 최소 1회씩 포함
- 랠리 코트에 있던 사람은 다음 라운드 반드시 게임 코트로
- premium 멤버: 성별 복식 ≥1회, 혼복 ≥1회, 게임 코트 ≥3회 보장

## 파일

- `index.html` — 웹 UI (설정, 배정 결과, 멤버별 통계)
- `assign.js` — 배정 로직 (브라우저/Node 겸용)
- `info.json` — 기본 멤버·코트·라운드 설정
- `run.js` — Node에서 결과 확인용 (`node run.js [seed]`)
- `server.js` — 로컬 개발 서버 (`node server.js`) — 배포에는 불필요

## 로컬 실행

```bash
node server.js
# http://localhost:8000 접속
```

## 배포 (GitHub Pages)

정적 사이트이므로 `index.html`이 레포 루트에 있으면 GitHub Pages로 바로 서빙됩니다.
Settings → Pages → Branch: `main` / Folder: `/ (root)`.
