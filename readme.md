# AI 직원 시스템

관리 AI와 작업 AI를 조직화하고 업무 지시, 실행 이력, 대화와 복구 상태를 관리하는 프로젝트입니다. TypeScript·SQLite·Codex CLI·MCP 기반의 단일 호스트 초기 구현을 포함합니다. 구현 개요와 운영 제약은 [실행 안내](src/README.md)를 기준으로 확인하세요.

## 저장소 구성

| 경로 | 내용 |
|---|---|
| `request/` | 기획서, 요구사항 정의서 및 발표 자료 |
| `design/` | 시스템 아키텍처, 메뉴·화면 및 동작 설계 |
| `prototype/` | HTML 화면 프로토타입과 안내서 |
| `src/` | 애플리케이션 소스, 실행 설정 및 테스트 |
| `test-file/` | 테스트 관련 파일 디렉터리 |

설계 문서는 구현 전 설계안을 포함합니다. 설계·프로토타입의 설명을 현재 구현 또는 검증 완료 기능과 동일하게 해석하지 마세요. 문서 상태는 [전체 설계](design/system-architecture.md), 구현 안내는 [src README](src/README.md)를 확인하세요.

## 문서 안내

- [한국어 기획서](request/ai-employee-system-plan.ko.md)
- [한국어 요구사항 정의서](request/ai-employee-system-requirements.ko.md)
- [시스템 전체 설계](design/system-architecture.md)
- [메뉴·화면 설계](design/menu-design.md)
- [동작 설계](design/action-design.md)
- [화면 프로토타입](prototype/index.html)
- [프로토타입 안내서](prototype/guidebook.html)
- [설치·실행 및 운영 안내](src/README.md)
- [외부 관리 MCP 안내](src/ADMIN_MCP.md)

## 로컬 실행

[실행 안내](src/README.md)와 [패키지 설정](src/package.json)에 따르면 Node.js 24 이상과 로컬 Codex CLI가 필요합니다. 아래 토큰 생성 예시는 Python도 사용합니다.

저장소 루트에서 PowerShell로 실행하세요.

```powershell
Set-Location .\src
npm ci
# 기존 .env는 덮어쓰지 않습니다.
if (!(Test-Path -LiteralPath .env)) {
    Copy-Item -LiteralPath .env.example -Destination .env
}
python .\create_token\generate.py
# 출력된 OPERATOR_TOKEN 값을 .env에 직접 설정합니다.
codex login status
# 인증 및 환경 설정을 확인한 뒤 실행합니다.
npm start
```

기본 웹 주소는 `http://127.0.0.1:3000`이며 실제 포트는 환경 설정에 따릅니다. 로그인한 Codex CLI와 같은 OS 사용자로 실행하세요. 기존 Docker 인스턴스를 사용 중이라면 동시 실행 전에 [전환 안내](src/README.md)를 확인하세요.

토큰·인증 정보 및 실제 `.env` 값은 문서나 저장소에 기록하지 마세요. 외부 관리 MCP의 인증·포트 설정은 [전용 안내서](src/ADMIN_MCP.md)를 따릅니다.

## 개발 검증

`src` 디렉터리에서 다음 명령을 실행합니다. 명령 정의는 [package.json](src/package.json)에 있습니다.

```powershell
npm test
npm run typecheck
npm run build
```

이 README 작성 과정에서는 애플리케이션 실행이나 위 개발 검증 명령을 수행하지 않았습니다. 실제 Codex CLI 연동 및 운영 환경 동작은 검증되지 않음입니다.
