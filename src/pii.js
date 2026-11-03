// Feature: medication-duration-tracker
// pii: 개인정보(이름·생년월일·연락처·병원등록번호) 검사(공통 순수 로직) (Requirement 3.3, 3.9).
//
// 저장 전 입력 텍스트에 개인정보 패턴이 포함되어 있는지 검출하는 순수 함수 모음.
// 어떤 것도 저장하지 않으며, 검출 시 구분된 거부 사유 코드를 반환한다.
// 저장 거부·오류 표시 분기는 호출 측(Record_Store.save 등)이 담당한다.

// ---------------------------------------------------------------------------
// 거부 사유 코드 (Rejection reason codes)
// ---------------------------------------------------------------------------

/**
 * 개인정보 범주별 구분된 거부 사유 코드.
 * 각 코드는 Requirement 3.3/3.9에서 열거한 개인정보 유형(이름·생년월일·연락처·병원등록번호)에 대응한다.
 * @readonly
 * @enum {string}
 */
export const PII_REASON = Object.freeze({
  NAME: "PII_NAME", // 이름
  DATE_OF_BIRTH: "PII_DATE_OF_BIRTH", // 생년월일
  CONTACT: "PII_CONTACT", // 연락처(전화번호·이메일)
  HOSPITAL_RECORD_NUMBER: "PII_HOSPITAL_RECORD_NUMBER", // 병원등록번호
  RESIDENT_REGISTRATION_NUMBER: "PII_RRN", // 주민등록번호(생년월일+식별번호 결합)
});

// ---------------------------------------------------------------------------
// 패턴 정의 (Patterns)
// ---------------------------------------------------------------------------

// 주민등록번호: 6자리-7자리 (예: 900101-1234567). 생년월일과 식별번호가 결합된 가장 민감한 개인정보.
// 구분자는 하이픈/점/공백 허용 또는 없음(13자리 연속)도 검출.
const RRN_RE = /\b\d{6}\s*[-.\s]?\s*[1-4]\d{6}\b/;

// 생년월일(생년월일/생일 라벨 또는 날짜 형식).
// 라벨형: "생년월일: 1990-01-01", "생일 1990.1.1"
const DOB_LABELED_RE =
  /(생년월일|생일|출생(일|년월일)?|date\s*of\s*birth|\bdob\b)\s*[:：=]?\s*\d{2,4}\s*[-./년]\s*\d{1,2}\s*[-./월]?\s*\d{1,2}\s*일?/i;
// 날짜 형식만: 1900~2099 범위의 연-월-일 (오탐 억제를 위해 4자리 연도로 제한).
const DOB_DATE_RE =
  /\b(19|20)\d{2}\s*[-./년]\s*(0?[1-9]|1[0-2])\s*[-./월]?\s*(0?[1-9]|[12]\d|3[01])\s*일?\b/;

// 연락처 - 전화번호: 02/0XX 지역번호 또는 휴대폰(010 등). 구분자 하이픈/공백/점 허용.
// 국내형(0으로 시작)과 국제형(+82 접두 시 0 생략)을 모두 검출한다.
const PHONE_RE =
  /(?:\+?82[-.\s]?\d{1,2}|0\d{1,2})[-.\s]?\d{3,4}[-.\s]?\d{4}\b/;
// 연락처 - 이메일.
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;

// 병원등록번호: "병원등록번호", "등록번호", "환자번호", "진료번호", "차트번호", "MRN" 등 라벨 + 숫자.
const HOSPITAL_RECORD_RE =
  /(병원\s*등록\s*번호|환자\s*(등록\s*)?번호|진료\s*(등록\s*)?번호|차트\s*번호|등록\s*번호|chart\s*(no|number)|patient\s*(id|no|number)|\bmrn\b)\s*[:：=#]?\s*[A-Za-z]*\d{4,}/i;

// 이름: 한국어 맥락에서 이름 라벨 + 성명 또는 "홍길동 님/씨/환자" 형태.
// 라벨형: "이름: 홍길동", "성명 홍길동", "환자명: 홍길동", "name: John"
// 주의: 한글은 JS \b 경계와 호환되지 않으므로 한글 성명 뒤에 \b를 쓰지 않는다.
const NAME_LABELED_RE =
  /(이름|성명|환자\s*명|성\s*함|name)\s*[:：=]?\s*(?:[가-힣]{2,4}|[A-Za-z]+(?:\s+[A-Za-z]+)+)/i;
// 호칭형: "홍길동 님", "홍길동씨", "홍길동 환자" (한글 2~4자 성명 + 호칭).
const NAME_HONORIFIC_RE = /[가-힣]{2,4}\s*(님|씨|환자)/;

// ---------------------------------------------------------------------------
// 범주별 검출 함수 (Per-category detectors)
// ---------------------------------------------------------------------------

/**
 * 입력을 검사용 문자열로 정규화한다. 문자열이 아니면 빈 문자열로 취급한다.
 * @param {*} text
 * @returns {string}
 */
function asText(text) {
  return typeof text === "string" ? text : "";
}

/**
 * 주민등록번호(생년월일+식별번호) 패턴을 검출한다.
 * @param {string} text
 * @returns {boolean}
 */
export function hasResidentRegistrationNumber(text) {
  return RRN_RE.test(asText(text));
}

/**
 * 생년월일 패턴을 검출한다(라벨형 또는 4자리 연도 날짜 형식).
 * @param {string} text
 * @returns {boolean}
 */
export function hasDateOfBirth(text) {
  const s = asText(text);
  return DOB_LABELED_RE.test(s) || DOB_DATE_RE.test(s);
}

/**
 * 연락처(전화번호 또는 이메일) 패턴을 검출한다.
 * @param {string} text
 * @returns {boolean}
 */
export function hasContact(text) {
  const s = asText(text);
  return PHONE_RE.test(s) || EMAIL_RE.test(s);
}

/**
 * 병원등록번호 패턴을 검출한다(등록번호·환자번호·차트번호 등 라벨 + 숫자).
 * @param {string} text
 * @returns {boolean}
 */
export function hasHospitalRecordNumber(text) {
  return HOSPITAL_RECORD_RE.test(asText(text));
}

/**
 * 이름 패턴을 검출한다(라벨형 또는 호칭형).
 * @param {string} text
 * @returns {boolean}
 */
export function hasName(text) {
  const s = asText(text);
  return NAME_LABELED_RE.test(s) || NAME_HONORIFIC_RE.test(s);
}

// ---------------------------------------------------------------------------
// 통합 검사 (Aggregate detection)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} PiiDetectionResult
 * @property {boolean} detected - 하나 이상의 개인정보 패턴이 검출되었는지 여부.
 * @property {string[]} reasons - 검출된 범주별 구분 거부 사유 코드 목록(중복 없음).
 */

/**
 * 입력 텍스트에서 개인정보 패턴(이름·생년월일·연락처·병원등록번호)을 검사하고,
 * 검출 시 각 범주에 대한 구분된 거부 사유 코드를 반환한다. 아무것도 저장하지 않는다.
 *
 * 주민등록번호는 생년월일과 식별번호가 결합된 민감 정보이므로 별도 사유 코드로 보고하되,
 * 동시에 생년월일 범주로도 간주되지 않도록 전용 코드만 추가한다.
 *
 * @param {string} text - 저장 대상 입력 텍스트.
 * @returns {PiiDetectionResult} 검출 여부와 구분된 거부 사유 코드 목록.
 */
export function detectPII(text) {
  const s = asText(text);
  const reasons = [];

  if (hasResidentRegistrationNumber(s)) {
    reasons.push(PII_REASON.RESIDENT_REGISTRATION_NUMBER);
  } else if (hasDateOfBirth(s)) {
    // RRN이 아니면서 생년월일 패턴이 있을 때만 DOB로 보고(이중 보고 방지).
    reasons.push(PII_REASON.DATE_OF_BIRTH);
  }

  if (hasContact(s)) {
    reasons.push(PII_REASON.CONTACT);
  }

  if (hasHospitalRecordNumber(s)) {
    reasons.push(PII_REASON.HOSPITAL_RECORD_NUMBER);
  }

  if (hasName(s)) {
    reasons.push(PII_REASON.NAME);
  }

  return {
    detected: reasons.length > 0,
    reasons,
  };
}

/**
 * MedicationRecordInput 후보에서 개인정보 검사 대상이 되는 필드를 모아 검사한다.
 * 현재 저장 모델에서 자유 텍스트 필드는 medicationName이므로 이를 검사한다.
 * (Record_Store.save가 저장 전 호출하는 편의 함수.)
 *
 * @param {{ medicationName?: * }} candidate - 저장 전 레코드 후보.
 * @returns {PiiDetectionResult}
 */
export function detectPIIInRecord(candidate) {
  const name = candidate && typeof candidate === "object" ? candidate.medicationName : "";
  return detectPII(asText(name));
}
