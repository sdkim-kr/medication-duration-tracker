// Feature: medication-duration-tracker
// Record_Parser: Transcript에서 약물명·복용시각·지속시간을 추출 (Requirement 2).
// 순수 함수 parse(transcript, now) — 저장하지 않는다.
// _Requirements: 2.1, 2.2, 2.4_

import {
  MAX_MEDICATION_NAME_LEN,
  EFFECT_DURATION_MIN,
  EFFECT_DURATION_MAX,
  UNKNOWN,
  truncateToMinute,
} from "./constants.js";

/**
 * 한국어 지속 시간 단위를 분으로 환산하는 계수.
 * @readonly
 */
const DURATION_UNIT_TO_MINUTES = {
  분: 1,
  시간: 60,
  시: 60,
  일: 60 * 24,
};

// 지속 시간 토큰: "효과 30분", "3시간", "2일 동안", "지속 90분" 등.
// 숫자 + 단위(분/시간/시/일) 조합을 포착한다. 가장 먼저 매칭되는 유효 값을 사용한다.
const DURATION_RE = /(\d+(?:\.\d+)?)\s*(분|시간|시|일)/g;

// 24시간제 복용 시각 토큰: "14시 30분", "오후 2시", "9시", "08:15" 등.
// 그룹: 오전/오후(선택), 시, 분(선택).
const TIME_RE =
  /(오전|오후|아침|저녁|밤|낮)?\s*(\d{1,2})\s*(?:시|:)\s*(\d{1,2})?\s*분?/;

// 날짜 토큰(선택): "3월 5일", "2024년 3월 5일". 연도는 선택.
const DATE_RE = /(?:(\d{4})\s*년\s*)?(\d{1,2})\s*월\s*(\d{1,2})\s*일/;

// 약물명 토큰: "타이레놀 복용", "이부프로펜 먹었어", "약물명은 아스피린" 등.
// 전사에서 약물명을 직접 추출하기는 자연어 의존이 크므로, 명시적 패턴을 우선 시도하고
// 실패하면 null(= missing)로 둔다. UI가 최대 3회 재요청한다(Requirement 2.3).
const MED_NAME_PATTERNS = [
  /약(?:물)?\s*(?:명|이름)\s*(?:은|는|:)?\s*([^\s,.]+)/, // "약물명은 X", "약 이름: X"
  /([^\s,.]+)\s*(?:을|를)?\s*(?:복용|먹|섭취)/, // "X 복용", "X를 먹었어"
];

/**
 * 약물명 후보를 정규화한다. 공백 제거 후 최대 100자로 절단한다.
 * @param {string} raw
 * @returns {string|null}
 */
function normalizeMedicationName(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // 최대 100자 제약(Requirement 2.1). 초과분은 절단한다.
  return trimmed.slice(0, MAX_MEDICATION_NAME_LEN);
}

/**
 * Transcript에서 약물명을 추출한다. 명시적 패턴을 순서대로 시도한다.
 * @param {string} transcript
 * @returns {string|null}
 */
function extractMedicationName(transcript) {
  for (const re of MED_NAME_PATTERNS) {
    const m = transcript.match(re);
    if (m && m[1]) {
      const name = normalizeMedicationName(m[1]);
      if (name) return name;
    }
  }
  return null;
}

/**
 * Transcript에서 복용 시각을 추출하여 epoch ms(분 해상도)로 반환한다.
 * 날짜가 명시되면 해당 날짜를, 없으면 now의 날짜를 사용한다.
 * 시각 토큰이 없으면 null을 반환한다(기본값은 parse에서 now로 설정).
 * @param {string} transcript
 * @param {Date} now
 * @returns {number|null}
 */
function extractDoseTime(transcript, now) {
  const timeMatch = transcript.match(TIME_RE);
  const dateMatch = transcript.match(DATE_RE);

  if (!timeMatch && !dateMatch) return null;

  // 기준 날짜 구성요소는 now에서 가져온다.
  let year = now.getFullYear();
  let month = now.getMonth(); // 0-based
  let day = now.getDate();
  let hour = now.getHours();
  let minute = now.getMinutes();

  if (dateMatch) {
    if (dateMatch[1]) year = Number(dateMatch[1]);
    month = Number(dateMatch[2]) - 1;
    day = Number(dateMatch[3]);
    // 날짜만 명시되고 시각이 없으면 00:00로 둔다.
    if (!timeMatch) {
      hour = 0;
      minute = 0;
    }
  }

  if (timeMatch) {
    const meridiem = timeMatch[1];
    let h = Number(timeMatch[2]);
    const min = timeMatch[3] !== undefined ? Number(timeMatch[3]) : 0;

    // 범위를 벗어난 시/분은 시각 미추출로 간주한다.
    if (h > 23 || min > 59) {
      if (!dateMatch) return null;
    } else {
      // 오후/저녁/밤: 12시간제 보정(12시는 그대로).
      if ((meridiem === "오후" || meridiem === "저녁" || meridiem === "밤") && h < 12) {
        h += 12;
      }
      // 오전 12시(자정)는 0시로 보정.
      if ((meridiem === "오전" || meridiem === "아침") && h === 12) {
        h = 0;
      }
      hour = h;
      minute = min;
    }
  }

  const d = new Date(year, month, day, hour, minute, 0, 0);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return null;
  return truncateToMinute(ms);
}

/**
 * Transcript에서 효과 지속 시간을 분 단위 정수로 추출한다.
 * 유효 범위(1..10080)를 벗어나거나 토큰이 없으면 null을 반환한다.
 * @param {string} transcript
 * @returns {number|null}
 */
function extractEffectDuration(transcript) {
  DURATION_RE.lastIndex = 0;
  let match;
  while ((match = DURATION_RE.exec(transcript)) !== null) {
    const value = Number(match[1]);
    const unit = match[2];
    const factor = DURATION_UNIT_TO_MINUTES[unit];
    if (factor === undefined) continue;
    const minutes = Math.round(value * factor);
    if (
      Number.isInteger(minutes) &&
      minutes >= EFFECT_DURATION_MIN &&
      minutes <= EFFECT_DURATION_MAX
    ) {
      return minutes;
    }
  }
  return null;
}

/**
 * Transcript에서 약물명·복용 시각·지속 시간을 추출한다. 저장하지 않는다(순수 함수).
 *
 * - Dose_Time이 전사에 없으면 now를 분 해상도로 절삭한 값으로 설정한다(Requirement 2.2).
 * - Medication_Name 추출 실패는 null로 두고 missing에 기록한다(UI가 재요청, Requirement 2.3).
 * - Effect_Duration 추출 실패 시 값은 '확인되지 않음'으로 설정하고 missing에 기록한다(Requirement 2.4).
 *
 * @param {string} transcript - 음성 인식 결과 텍스트.
 * @param {Date} [now=new Date()] - 레코드 생성 시점의 현재 시각(Dose_Time 기본값·날짜 기준).
 * @returns {import('./constants.js').ParseResult}
 */
export function parse(transcript, now = new Date()) {
  const text = typeof transcript === "string" ? transcript : "";
  const baseNow = now instanceof Date ? now : new Date(now);

  /** @type {string[]} */
  const missing = [];

  // --- Medication_Name (Requirement 2.1, 2.3) ---
  const medicationName = extractMedicationName(text);
  if (medicationName === null) {
    missing.push("medicationName");
  }

  // --- Dose_Time (Requirement 2.1, 2.2) ---
  let doseTime = extractDoseTime(text, baseNow);
  if (doseTime === null) {
    // 미명시 시 현재 시각(분 해상도)을 기본값으로 설정(Requirement 2.2).
    doseTime = truncateToMinute(baseNow.getTime());
  }

  // --- Effect_Duration (Requirement 2.1, 2.4) ---
  const extractedDuration = extractEffectDuration(text);
  /** @type {number|'확인되지 않음'} */
  let effectDuration;
  if (extractedDuration === null) {
    // 미추출 시 '확인되지 않음'으로 설정(Requirement 2.4).
    effectDuration = UNKNOWN;
    missing.push("effectDuration");
  } else {
    effectDuration = extractedDuration;
  }

  return {
    medicationName,
    doseTime,
    effectDuration,
    source: "voice",
    missing,
  };
}

export default { parse };
