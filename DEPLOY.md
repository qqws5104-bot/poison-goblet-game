# 실제 웹사이트로 배포하기 (예은님/팀원이 진행하는 단계)

지금 제 작업 환경은 외부 인터넷이 막혀 있어서(패키지 설치용 npm 레지스트리만 허용),
제가 이 서버를 대신 인터넷에 띄워드릴 수는 없습니다. 대신 아래 순서대로 하면
5~10분 안에 팀원 각자의 컴퓨터에서 URL 하나로 접속하는 진짜 웹사이트가 됩니다.

이 게임은 "상대가 내 방 내용을 모른다"는 게 핵심이라, 서버가 각 플레이어의 비밀
정보(독 위치, 미니게임의 숨겨진 값 등)를 따로 들고 있어야 합니다. 그래서 지금
구조(Node.js + Socket.io 서버 하나가 게임 상태를 관리)를 그대로 유지하는 배포
방식을 권장드립니다.

## 왜 Render.com을 예로 들었나

무료로 Node.js 서버를 상시 호스팅할 수 있는 서비스 중 계정 가입이 간단하고,
GitHub 저장소만 연결하면 자동으로 빌드·배포해주는 곳이라 이 예시로 골랐습니다.
다만 무료 티어의 정확한 제한(예: 일정 시간 미사용 시 서버가 잠들었다가 다음
접속 때 몇십 초 정도 늦게 깨어나는 등)은 제가 지금 환경에서 실시간으로 확인할
방법이 없어서, 가입 시점에 화면에 나오는 조건을 직접 확인해 주세요. Railway,
Fly.io 등 다른 Node.js 호스팅 서비스를 쓰셔도 동일한 파일로 배포 가능합니다
(이미 `Dockerfile`, `Procfile`을 함께 넣어뒀습니다).

## 준비물

- GitHub 계정 (없으면 github.com에서 무료로 즉시 생성 가능)
- Render.com 계정 (GitHub 계정으로 바로 가입 가능)

## 1단계 — 이 코드를 GitHub 저장소에 올리기

터미널 사용이 편하다면:
```bash
cd poison_game
git init
git add .
git commit -m "당신의 술잔에 독배를 - 프로토타입"
# GitHub에서 새 저장소를 만든 뒤 안내되는 remote 주소로 교체
git remote add origin https://github.com/<계정명>/<저장소명>.git
git branch -M main
git push -u origin main
```

터미널이 낯설다면:
1. github.com 로그인 → 우측 상단 "+" → "New repository" → 이름만 정하고 생성
   (Public/Private 아무거나 상관없습니다)
2. 생성된 저장소 페이지에서 "uploading an existing file" 클릭
3. `poison_game` 폴더 안의 파일/폴더를 통째로 드래그해서 업로드 (단, `node_modules`
   폴더가 있다면 그건 올리지 마세요 — 필요 없고 용량만 큽니다)
4. "Commit changes" 클릭

## 2단계 — Render.com에서 배포

1. render.com 가입/로그인 (GitHub 계정으로 로그인하면 저장소 연결이 쉽습니다)
2. 대시보드에서 "New +" → "Web Service" 선택
3. 방금 올린 GitHub 저장소를 선택
4. 설정 화면에서:
   - **Environment**: Node (또는 Docker — 둘 다 준비되어 있으니 편한 쪽으로)
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Plan**: 무료(Free) 플랜 선택
5. "Create Web Service" 클릭 → 몇 분 기다리면 `https://<임의이름>.onrender.com`
   같은 URL이 발급됩니다.
6. 이 URL을 팀원과 공유하면, 각자 컴퓨터에서 그 주소로 접속만 하면 됩니다
   (먼저 접속하는 사람이 장남, 두 번째가 차남).

## 밸런스 수치를 배포본에서 바꾸려면

Render 대시보드 → 해당 서비스 → "Environment" 탭에서 환경변수를 추가하면
로컬에서 쓰던 것과 똑같이 적용됩니다. 예: `TIME_LIMIT_SEC` = `120`,
`NIM_LIMIT` = `21` 등 (전체 목록은 README.md 참고). 값을 바꾸고 저장하면
서비스가 자동 재시작됩니다.

## 로컬에서 먼저 확인하고 싶다면

배포 전에 예은님 컴퓨터에서 바로 확인하려면 README.md의 "실행 방법"대로
`npm install && node server.js` 후 `http://localhost:3000`으로 접속하면 됩니다.
배포는 "같은 와이파이가 아니어도, 각자 컴퓨터에서 그냥 URL만 열면 되게" 만드는
단계일 뿐, 게임 자체는 로컬 실행과 완전히 동일합니다.
