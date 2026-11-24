/* Hemory 개인용 · 설정
   clientId 는 Google Cloud Console > API 및 서비스 > 사용자 인증 정보 >
   OAuth 클라이언트 ID(웹 애플리케이션) 에서 만든 값을 넣습니다.
   비워 두면 앱 첫 화면의 "처음 설정"에서 직접 입력할 수 있습니다(폰에만 저장). */
export const CONFIG = {
  version: "1.1.0",
  clientId: "",                      // 예: "1234567890-abc...apps.googleusercontent.com"
  rootFolder: "Hemory-개인녹음",       // 내 드라이브 안의 전용 폴더
  inboxFolder: "_inbox",             // 아이폰 음성메모·단축어가 올리는 곳
  trashFolder: "_trash",             // 365일 지난 파일 보관(맥이 이동)
  scopes: "https://www.googleapis.com/auth/drive",
  driveApi: "https://www.googleapis.com/drive/v3",
  uploadApi: "https://www.googleapis.com/upload/drive/v3",
  geminiModel: "gemini-2.5-flash",
  retentionDays: 365,
};

export const TYPES = {
  meeting: { label: "회의", short: "회의" },
  work:    { label: "업무", short: "업무" },
  meal:    { label: "식사", short: "식사" },
  daily:   { label: "일상", short: "일상" },
  study:   { label: "학습", short: "학습" },
  etc:     { label: "기타", short: "기타" },
};
