# ChatGPT를 활용한 FAQ 기반 채팅 애플리케이션 개발

## 전체 개요
- **목표**: 기존 FAQ 데이터를 ChatGPT로 학습시켜 사용자가 채팅을 통해 질문하면 적절한 답변 제공
- **관리자 페이지**: FAQ 데이터를 관리하고 업데이트 가능
- **기술 스택**: 
  - 백엔드: Node.js (클라우드타입)
  - 프론트엔드: React Native, Bootstrap
- **주요 기능**: 실시간 채팅 UI, ChatGPT 연동 API, FAQ 데이터 CRUD

## UI 설계
- **기본 화면**: 채팅 인터페이스 (사용자/응답 메시지 표시)
- **추가 기능**: FAQ 검색 및 추천 기능
- **관리자 페이지**: FAQ 데이터 관리 (로그인 필요, 마스터 아이디 권한)

## 컴포넌트 개발
- **메시지 UI**: 입력 및 출력 메시지를 카드 형태로 렌더링
- **FAQList**: FAQ 데이터를 리스트 및 검색 기능으로 표시
- **AdminPanel**: 관리자용 FAQ 관리 페이지

## 채팅 기능 구현
- **흐름**: 사용자 메시지 → 서버 전송 → ChatGPT 응답 수신 → 화면 출력
- **실시간 채팅**: WebSocket 또는 Polling 기술 고려
- **예외 처리**: API에 저장되지 않은 데이터나 질문은 CS 상담톡 연결
- **데이터 관리**: MongoDB를 이용한 채팅 내용 저장

## 관리자 페이지 기능
- **FAQ 등록**: 새로운 질문/답변 추가
- **FAQ 수정/삭제**: 기존 FAQ 관리
- **검색/필터링**: FAQ 데이터 효율적 검색
- **데이터 확장**: API 정보 입력 및 데이터 전송을 통한 ChatGPT 데이터 확장
- **디자인**: Bootstrap 기반 UI/UX

## 백엔드 (Node.js & 클라우드타입)
- **서버 설계**: Express.js 기반 RESTful API 개발
  - `/api/chat`: 사용자 메시지를 ChatGPT로 전달하여 응답 반환
  - `/api/faq`: FAQ 데이터 CRUD 작업
- **ChatGPT 연동**: OpenAI API 활용, FAQ 데이터를 컨텍스트에 포함해 맞춤형 응답 제공
- **API 요금 최적화**: Redis 캐시 활용, FAQ 데이터와 완전히 일치하는 질문은 DB에서 바로 응답  
  - 예시: gpt-3.5-turbo (입력 토큰 $0.0015/1,000, 출력 토큰 $0.002/1,000)
- **데이터베이스 설계**: MongoDB 사용, FAQs 컬렉션 및 인덱싱 작업
- **서버 배포**: 
  - 클라우드타입을 통한 HTTPS 지원
  - CI/CD (GitHub 연동, 코드 변경 시 자동 배포)
  - 서버 모니터링 및 로그 관리


![image](https://github.com/user-attachments/assets/b9e1f09e-9454-4b46-af6f-f8454ea9fe8b)

