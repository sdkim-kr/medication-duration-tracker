// Feature: medication-duration-tracker
// UI 조율 계층 (Task 14.1): 입력 선택·확인·저장 흐름 통합.
//
// 음성·텍스트 두 입력 수단을 동등한 선택지로 노출하고(Requirement 7.1), 두 경로가 산출한
// Input_Draft를 단일 확인 화면으로 받아 수정/승인한다(Requirement 2.6, 7.3). 승인 전까지는
// 어떤 값도 저장하지 않으며, 승인 시 공통 저장 파이프라인(saveConfirmedDraft)을 호출한다.
// 재시도 카운터(retry.js)와 구분된 오류 코드 → 사용자 메시지 매핑을 연결한다.
// _Requirements: 2.6, 7.1, 7.3_

import { UNKNOWN, truncateToMinute } from "./src/constants.js";
import { parse } from "./src/Record_Parser.js";
import { collectInput } from "./src/Text_Input_Module.js";
import { createRecordStore, RecordStoreError, StoreRejectReason } from "./src/Record_Store.js";
import { saveConfirmedDraft } from "./src/save_pipeline.js";
import { analyze } from "./src/Analysis_Engine.js";
import { compare } from "./src/Comparison_Engine.js";
import {
  createVoiceInputModule,
  VoiceInputError,
  VoiceErrorCode,
} from "./src/Voice_Input_Module.js";
import {
  createRetryCounter,
  recordFailure,
  reset,
  isManualInputRequired,
} from "./src/retry.js";
import { ValidationCode } from "./src/validation.js";
import { PII_REASON } from "./src/pii.js";

// ---------------------------------------------------------------------------
// 오류 코드 → 사용자 메시지 매핑 (순수, 테스트 가능)
// ---------------------------------------------------------------------------

/** 입력 검증 거부 코드(Requirement 5)에 대한 사용자 안내 메시지. */
const VALIDATION_MESSAGES = {
  [ValidationCode.DOSE_TIME_EMPTY]: "복용 시각을 입력해 주세요.",
  [ValidationCode.DOSE_TIME_INVALID]: "유효한 복용 시각을 입력해 주세요.",
  [ValidationCode.DOSE_TIME_FUTURE]: "복용 시각은 미래일 수 없습니다. 유효한 시각을 입력해 주세요.",
  [ValidationCode.EFFECT_DURATION_EMPTY]: "효과 지속 시간을 분 단위 정수로 입력해 주세요.",
  [ValidationCode.EFFECT_DURATION_NOT_INTEGER]: "효과 지속 시간은 분 단위 정수여야 합니다.",
  [ValidationCode.EFFECT_DURATION_NEGATIVE]: "효과 지속 시간은 0 이상이어야 합니다.",
  [ValidationCode.MEDICATION_NAME_EMPTY]: "약물명을 입력해 주세요.",
  [ValidationCode.MEDICATION_NAME_TOO_LONG]: "약물명은 최대 100자까지 입력할 수 있습니다.",
};

/** 개인정보 거부 코드(Requirement 3.3, 3.9)에 대한 사용자 안내 메시지. */
const PII_MESSAGES = {
  [PII_REASON.NAME]: "이름",
  [PII_REASON.DATE_OF_BIRTH]: "생년월일",
  [PII_REASON.CONTACT]: "연락처",
  [PII_REASON.HOSPITAL_RECORD_NUMBER]: "병원등록번호",
  [PII_REASON.RESIDENT_REGISTRATION_NUMBER]: "주민등록번호",
};

/** 음성 입력 오류 코드(Requirement 1)에 대한 사용자 안내 메시지. */
const VOICE_MESSAGES = {
  [VoiceErrorCode.NOT_ALLOWED]: "마이크 접근 권한이 필요합니다. 권한을 허용하거나 텍스트 입력을 사용하세요.",
  [VoiceErrorCode.UNSUPPORTED]: "이 브라우저는 음성 인식을 지원하지 않습니다. 텍스트 입력을 사용하세요.",
  [VoiceErrorCode.TRANSCRIPTION_TIMEOUT]: "음성 변환이 지연되었습니다. 다시 시도해 주세요.",
  [VoiceErrorCode.TRANSCRIPTION_FAILED]: "음성을 변환하지 못했습니다. 다시 시도해 주세요.",
};

/**
 * RecordStoreError를 사용자용 메시지로 변환한다(순수 함수).
 * 입력 값은 보존되며 저장만 거부된 상태임을 전제로 안내한다(Requirement 3.2).
 * @param {RecordStoreError} error
 * @returns {string}
 */
export function describeStoreError(error) {
  if (!(error instanceof RecordStoreError)) {
    return "저장에 실패했습니다. 입력 값은 보존되었습니다. 다시 시도해 주세요.";
  }
  if (error.reason === StoreRejectReason.PII) {
    const kinds = (error.codes ?? [])
      .map((c) => PII_MESSAGES[c])
      .filter(Boolean);
    const detail = kinds.length > 0 ? `(${kinds.join(", ")})` : "";
    return `개인정보가 포함되어 저장이 거부되었습니다 ${detail}. 개인정보를 제거하고 다시 시도해 주세요.`.trim();
  }
  if (error.reason === StoreRejectReason.VALIDATION) {
    const msgs = (error.codes ?? [])
      .map((c) => VALIDATION_MESSAGES[c])
      .filter(Boolean);
    return msgs.length > 0
      ? msgs.join(" ")
      : "입력 검증에 실패하여 저장이 거부되었습니다.";
  }
  if (error.reason === StoreRejectReason.NOT_FOUND) {
    return "대상 기록을 찾을 수 없습니다.";
  }
  return "저장에 실패했습니다. 입력 값은 보존되었습니다.";
}

/**
 * 음성 입력 오류를 사용자용 메시지로 변환한다(순수 함수).
 * @param {VoiceInputError|Error} error
 * @returns {string}
 */
export function describeVoiceError(error) {
  if (error instanceof VoiceInputError && VOICE_MESSAGES[error.code]) {
    return VOICE_MESSAGES[error.code];
  }
  return "음성 입력 중 오류가 발생했습니다. 텍스트 입력을 사용할 수 있습니다.";
}

// ---------------------------------------------------------------------------
// Input_Draft → 폼 표시 값 변환 (순수)
// ---------------------------------------------------------------------------

/**
 * epoch ms를 <input type="datetime-local">용 로컬 문자열("YYYY-MM-DDTHH:mm")로 변환한다.
 * @param {number|null|undefined} ms
 * @returns {string}
 */
export function msToDatetimeLocal(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/**
 * <input type="datetime-local"> 문자열을 분 해상도 epoch ms로 변환한다.
 * 빈 문자열이면 null(= 미입력)을 반환한다.
 * @param {string} value
 * @returns {number|null}
 */
export function datetimeLocalToMs(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return truncateToMinute(ms);
}

// ---------------------------------------------------------------------------
// 분석/비교 결과 → 표시 모델 변환 (순수, 테스트 가능)
// ---------------------------------------------------------------------------

/** 분석/비교 상태 코드 → 사용자 표시 라벨·CSS 변형. */
const STATUS_DISPLAY = {
  ok: { label: "집계 가능", variant: "ok" },
  "데이터 부족": { label: "데이터 부족", variant: "insufficient" },
  "집계 가능 데이터 없음": { label: "집계 가능 데이터 없음", variant: "empty" },
};

/**
 * 평균값(분)을 사용자 표시 문자열로 변환한다. null이면 '—'.
 * @param {number|null} average
 * @returns {string}
 */
export function formatAverage(average) {
  return typeof average === "number" ? `${average}분` : "—";
}

/**
 * 추세 값을 사용자 표시 문자열로 변환한다. null이면 '—'(산출 안 됨).
 * @param {'증가'|'감소'|'변화 없음'|null} trend
 * @returns {string}
 */
export function formatTrend(trend) {
  return trend == null ? "—" : trend;
}

/**
 * AnalysisResult(또는 비교의 약물별 통계)를 표시용 행 목록으로 변환한다(순수 함수).
 * 통계·열거 필드만 포함하며 의학적 판단 문구를 넣지 않는다(Requirement 4.6, 6.7).
 * '확인되지 않음' 제외 건수와 데이터 부족 상태를 명시적으로 포함한다(Requirement 4.4, 6.5, 6.6).
 *
 * @param {import('./src/constants.js').AnalysisResult|import('./src/constants.js').ComparisonPerMedication} result
 * @returns {{ rows: Array<{label: string, value: string}>, status: {code: string, label: string, variant: string} }}
 */
export function toStatView(result) {
  const statusMeta =
    STATUS_DISPLAY[result.status] ?? { label: result.status, variant: "insufficient" };
  return {
    rows: [
      { label: "평균 지속 시간", value: formatAverage(result.average) },
      { label: "추세", value: formatTrend(result.trend) },
      { label: "집계 건수", value: `${result.includedCount}건` },
      { label: "'확인되지 않음' 제외", value: `${result.excludedUnknownCount}건` },
    ],
    status: { code: result.status, label: statusMeta.label, variant: statusMeta.variant },
  };
}

// ---------------------------------------------------------------------------
// 앱 상태 (브라우저에서만 실행)
// ---------------------------------------------------------------------------

export function initApp() {
  const store = createRecordStore();
  const voice = createVoiceInputModule();

  // 재시도 카운터: 연속 음성 변환 실패 추적(Requirement 1.6, 2.3).
  let retryState = createRetryCounter();

  // 현재 확인 중인 Input_Draft(승인 전까지 저장하지 않음, Requirement 2.6).
  /** @type {import('./src/constants.js').InputDraft|null} */
  let currentDraft = null;

  // --- DOM 참조 ---
  const $ = (id) => document.getElementById(id);
  const statusEl = $("status");
  const chooseVoiceBtn = $("choose-voice");
  const chooseTextBtn = $("choose-text");
  const voicePanel = $("voice-panel");
  const textPanel = $("text-panel");
  const confirmPanel = $("confirm-panel");
  const voiceStartBtn = $("voice-start");
  const voiceStopBtn = $("voice-stop");
  const voiceStateEl = $("voice-state");
  const textForm = $("text-form");
  const textMedication = $("text-medication");
  const textDoseTime = $("text-dose-time");
  const textDuration = $("text-duration");
  const confirmForm = $("confirm-form");
  const confirmSource = $("confirm-source");
  const confirmMedication = $("confirm-medication");
  const confirmDoseTime = $("confirm-dose-time");
  const confirmDuration = $("confirm-duration");
  const confirmDurationUnknown = $("confirm-duration-unknown");
  const confirmError = $("confirm-error");
  const confirmCancel = $("confirm-cancel");
  const recordsList = $("records-list");
  // 분석 화면
  const analysisForm = $("analysis-form");
  const analysisMedication = $("analysis-medication");
  const analysisStart = $("analysis-start");
  const analysisEnd = $("analysis-end");
  const analysisResult = $("analysis-result");
  // 비교 화면
  const comparisonForm = $("comparison-form");
  const comparisonChoices = $("comparison-choices");
  const comparisonStart = $("comparison-start");
  const comparisonEnd = $("comparison-end");
  const comparisonResult = $("comparison-result");

  // --- 상태 메시지 헬퍼 ---
  function showStatus(message, isError = false) {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.classList.toggle("error", isError);
  }
  function clearStatus() {
    showStatus("");
  }
  function showConfirmError(message) {
    if (confirmError) confirmError.textContent = message || "";
  }

  // --- 패널 전환 ---
  function selectInputMode(mode) {
    // 음성·텍스트는 동등한 선택지. 선택 시 해당 패널만 노출한다(Requirement 7.1).
    voicePanel?.classList.toggle("hidden", mode !== "voice");
    textPanel?.classList.toggle("hidden", mode !== "text");
    chooseVoiceBtn?.setAttribute("aria-pressed", String(mode === "voice"));
    chooseTextBtn?.setAttribute("aria-pressed", String(mode === "text"));
    confirmPanel?.classList.add("hidden");
    currentDraft = null;
    clearStatus();
  }

  // --- 단일 확인 화면 표시 (음성·텍스트 공통, Requirement 2.6, 7.3) ---
  function showConfirmScreen(draft) {
    currentDraft = draft;
    showConfirmError("");

    if (confirmSource) {
      const label = draft.source === "voice" ? "음성 입력" : "텍스트 입력";
      const missing =
        draft.missing && draft.missing.length > 0
          ? ` · 보완 필요: ${draft.missing
              .map((m) => (m === "medicationName" ? "약물명" : "효과 지속 시간"))
              .join(", ")}`
          : "";
      confirmSource.textContent = `출처: ${label}${missing}`;
    }

    if (confirmMedication) {
      confirmMedication.value = draft.medicationName ?? "";
    }
    if (confirmDoseTime) {
      const ms =
        typeof draft.doseTime === "number"
          ? draft.doseTime
          : datetimeLocalToMs(String(draft.doseTime ?? ""));
      confirmDoseTime.value = ms !== null ? msToDatetimeLocal(ms) : "";
    }
    const isUnknown = draft.effectDuration === UNKNOWN || draft.effectDuration == null;
    if (confirmDurationUnknown) confirmDurationUnknown.checked = isUnknown;
    if (confirmDuration) {
      confirmDuration.value = isUnknown ? "" : String(draft.effectDuration);
      confirmDuration.disabled = isUnknown;
    }

    // 확인 화면만 노출한다. 아직 저장하지 않는다.
    voicePanel?.classList.add("hidden");
    textPanel?.classList.add("hidden");
    confirmPanel?.classList.remove("hidden");
  }

  /**
   * 확인 화면의 현재 값으로부터 저장용 Input_Draft를 구성한다.
   * 사용자가 확인 화면에서 수정한 값을 반영한다(Requirement 2.6).
   * @returns {import('./src/constants.js').InputDraft}
   */
  function collectConfirmDraft() {
    const name = confirmMedication ? confirmMedication.value.trim() : "";
    const doseMs = confirmDoseTime ? datetimeLocalToMs(confirmDoseTime.value) : null;
    let effectDuration;
    if (confirmDurationUnknown && confirmDurationUnknown.checked) {
      effectDuration = UNKNOWN;
    } else {
      const raw = confirmDuration ? confirmDuration.value.trim() : "";
      effectDuration = raw === "" ? UNKNOWN : raw; // 공통 저장 경로가 검증
    }
    return {
      medicationName: name === "" ? null : name,
      doseTime: doseMs,
      effectDuration,
      source: currentDraft ? currentDraft.source : "text",
      missing: [],
    };
  }

  // --- 승인 → 공통 저장 파이프라인 (Task 8.1) ---
  async function approveAndSave() {
    const draft = collectConfirmDraft();
    showConfirmError("");
    try {
      const record = await saveConfirmedDraft(draft, store);
      // 저장 성공: 확인 화면 종료, 상태 알림(Requirement 3.1).
      currentDraft = null;
      confirmPanel?.classList.add("hidden");
      showStatus(`"${record.medicationName}" 기록을 저장했습니다.`);
      await refreshRecords();
    } catch (error) {
      // 저장 실패·검증 실패·개인정보 포함: 입력 값 보존, 확인 화면 유지(Requirement 3.2).
      showConfirmError(describeStoreError(error));
    }
  }

  // --- 음성 경로: 캡처 → 전사 → 파싱 → Input_Draft ---
  async function startVoiceCapture() {
    if (!voice.isSupported()) {
      showStatus(VOICE_MESSAGES[VoiceErrorCode.UNSUPPORTED], true);
      return;
    }
    clearStatus();
    if (voiceStartBtn) voiceStartBtn.disabled = true;
    if (voiceStopBtn) voiceStopBtn.disabled = false;
    try {
      const transcript = await voice.startCapture();
      // 성공: 연속 실패 카운터 초기화(Requirement 1.6).
      retryState = reset(retryState);
      const draft = parse(transcript, new Date());
      showConfirmScreen(draft);
    } catch (error) {
      // 전사 실패·타임아웃 등: 실패 1회 기록, 기존 입력 데이터 보존(Requirement 1.5).
      retryState = recordFailure(retryState);
      if (isManualInputRequired(retryState)) {
        // 연속 3회 실패: 재시도 중단, 수동(텍스트) 입력 안내(Requirement 1.6, 2.3).
        showStatus(
          "음성 변환이 여러 번 실패했습니다. 텍스트 입력을 사용해 주세요.",
          true
        );
        selectInputMode("text");
      } else {
        showStatus(describeVoiceError(error), true);
      }
    } finally {
      if (voiceStartBtn) voiceStartBtn.disabled = false;
      if (voiceStopBtn) voiceStopBtn.disabled = true;
    }
  }

  // --- 텍스트 경로: 필드 수집 → Input_Draft (Requirement 7.3) ---
  function submitTextInput(event) {
    event?.preventDefault?.();
    const fields = {
      medicationName: textMedication ? textMedication.value : "",
      doseTime: textDoseTime ? datetimeLocalToMs(textDoseTime.value) : null,
      effectDuration: textDuration ? textDuration.value : "",
    };
    const draft = collectInput(fields, new Date());
    showConfirmScreen(draft);
  }

  // --- 기록 목록 렌더 (Requirement 3.4): store.list는 Dose_Time 내림차순 ---
  async function refreshRecords() {
    let records = [];
    try {
      records = await store.list();
    } catch {
      // 목록 조회 실패는 치명적이지 않다. 조용히 무시한다.
      return;
    }

    if (recordsList) {
      recordsList.innerHTML = "";
      for (const r of records) {
        const li = document.createElement("li");
        const when = new Date(r.doseTime).toLocaleString("ko-KR");
        const dur =
          r.effectDuration === UNKNOWN ? "확인되지 않음" : `${r.effectDuration}분`;
        li.textContent = `${r.medicationName} · ${when} · 지속 ${dur}`;
        recordsList.appendChild(li);
      }
    }

    // 분석·비교 화면의 약물 선택지를 저장된 약물명으로 갱신한다(Requirement 4.1, 6.3).
    const names = uniqueMedicationNames(records);
    refreshMedicationChoices(names);
  }

  /**
   * 저장된 레코드에서 중복 없는 약물명을 가나다순으로 반환한다.
   * @param {import('./src/constants.js').MedicationRecord[]} records
   * @returns {string[]}
   */
  function uniqueMedicationNames(records) {
    const set = new Set(records.map((r) => r.medicationName));
    return [...set].sort((a, b) => a.localeCompare(b, "ko"));
  }

  /** 분석용 <select>와 비교용 체크박스 목록을 약물명으로 채운다. 기존 선택은 최대한 보존한다. */
  function refreshMedicationChoices(names) {
    if (analysisMedication) {
      const prev = analysisMedication.value;
      analysisMedication.innerHTML = "";
      for (const name of names) {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        analysisMedication.appendChild(opt);
      }
      if (names.includes(prev)) analysisMedication.value = prev;
    }

    if (comparisonChoices) {
      const checked = new Set(
        [...comparisonChoices.querySelectorAll("input:checked")].map((el) => el.value)
      );
      comparisonChoices.innerHTML = "";
      if (names.length === 0) {
        const p = document.createElement("p");
        p.className = "result-empty";
        p.textContent = "저장된 약물이 없습니다.";
        comparisonChoices.appendChild(p);
      } else {
        for (const name of names) {
          const label = document.createElement("label");
          label.className = "inline-check";
          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.value = name;
          cb.checked = checked.has(name);
          label.appendChild(cb);
          label.appendChild(document.createTextNode(` ${name}`));
          comparisonChoices.appendChild(label);
        }
      }
    }
  }

  /** 두 datetime-local 입력에서 DateRange를 구성한다. 둘 다 비면 undefined(전체). */
  function collectRange(startEl, endEl) {
    const startMs = startEl ? datetimeLocalToMs(startEl.value) : null;
    const endMs = endEl ? datetimeLocalToMs(endEl.value) : null;
    if (startMs === null && endMs === null) return undefined;
    /** @type {import('./src/constants.js').DateRange} */
    const range = {};
    if (startMs !== null) range.startMs = startMs;
    if (endMs !== null) range.endMs = endMs;
    return range;
  }

  /** 통계 카드 DOM을 생성한다(분석·비교 공용). statView는 toStatView 결과. */
  function buildStatCard(name, statView) {
    const card = document.createElement("div");
    card.className = "stat-card";

    if (name) {
      const title = document.createElement("div");
      title.className = "stat-card__name";
      title.textContent = name;
      card.appendChild(title);
    }

    for (const row of statView.rows) {
      const rowEl = document.createElement("div");
      rowEl.className = "stat-row";
      const labelEl = document.createElement("span");
      labelEl.className = "stat-row__label";
      labelEl.textContent = row.label;
      const valueEl = document.createElement("span");
      valueEl.className = "stat-row__value";
      valueEl.textContent = row.value;
      rowEl.appendChild(labelEl);
      rowEl.appendChild(valueEl);
      card.appendChild(rowEl);
    }

    const statusEl2 = document.createElement("span");
    statusEl2.className = `stat-status stat-status--${statView.status.variant}`;
    statusEl2.textContent = statView.status.label;
    card.appendChild(statusEl2);

    return card;
  }

  // --- 분석 화면 (Requirement 4.1, 4.2, 4.4, 4.5) ---
  async function runAnalysis(event) {
    event?.preventDefault?.();
    if (!analysisResult) return;
    const name = analysisMedication ? analysisMedication.value : "";
    analysisResult.innerHTML = "";

    if (!name) {
      const p = document.createElement("p");
      p.className = "result-empty";
      p.textContent = "분석할 약물을 선택해 주세요. 먼저 기록을 저장하세요.";
      analysisResult.appendChild(p);
      return;
    }

    const range = collectRange(analysisStart, analysisEnd);
    let records = [];
    try {
      records = await store.getByMedication(name, range);
    } catch {
      const p = document.createElement("p");
      p.className = "result-empty";
      p.textContent = "기록을 불러오지 못했습니다.";
      analysisResult.appendChild(p);
      return;
    }

    // Analysis_Engine 재사용: '확인되지 않음' 제외·제외 건수·데이터 부족 상태를 그대로 반영.
    const result = analyze(records, range);
    analysisResult.appendChild(buildStatCard(name, toStatView(result)));
  }

  // --- 비교 화면 (Requirement 6.3, 6.4, 6.5) ---
  async function runComparison(event) {
    event?.preventDefault?.();
    if (!comparisonResult) return;
    comparisonResult.innerHTML = "";

    const selected = comparisonChoices
      ? [...comparisonChoices.querySelectorAll("input:checked")].map((el) => el.value)
      : [];

    const range = collectRange(comparisonStart, comparisonEnd);

    // 약물명 → 기록 맵을 구성한다(각 약물 통계는 Comparison_Engine이 Analysis_Engine으로 산출).
    const recordsByMedication = new Map();
    for (const name of selected) {
      let recs = [];
      try {
        recs = await store.getByMedication(name, range);
      } catch {
        recs = [];
      }
      recordsByMedication.set(name, recs);
    }

    const result = compare(recordsByMedication, range);

    // 2개 미만: 비교 미수행 안내만 표시(Requirement 6.2).
    if (result.invalid) {
      const p = document.createElement("p");
      p.className = "result-guidance";
      p.textContent = result.invalid;
      comparisonResult.appendChild(p);
      return;
    }

    // 약물별 통계를 나란히 비교(Requirement 6.4). 데이터 부족 약물은 격리 표시(Requirement 6.5).
    const grid = document.createElement("div");
    grid.className = "comparison-grid";
    for (const per of result.perMedication) {
      grid.appendChild(buildStatCard(per.medicationName, toStatView(per)));
    }
    comparisonResult.appendChild(grid);
  }

  // --- 이벤트 바인딩 ---
  chooseVoiceBtn?.addEventListener("click", () => selectInputMode("voice"));
  chooseTextBtn?.addEventListener("click", () => selectInputMode("text"));
  voiceStartBtn?.addEventListener("click", startVoiceCapture);
  voiceStopBtn?.addEventListener("click", () => voice.stopCapture());
  textForm?.addEventListener("submit", submitTextInput);
  confirmForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    approveAndSave();
  });
  confirmCancel?.addEventListener("click", () => {
    // 취소: 저장하지 않고 입력 선택으로 돌아간다(승인 전 미저장, Requirement 2.6).
    currentDraft = null;
    confirmPanel?.classList.add("hidden");
    selectInputMode(chooseVoiceBtn?.getAttribute("aria-pressed") === "true" ? "voice" : "text");
  });
  confirmDurationUnknown?.addEventListener("change", () => {
    if (confirmDuration) confirmDuration.disabled = confirmDurationUnknown.checked;
  });
  analysisForm?.addEventListener("submit", runAnalysis);
  comparisonForm?.addEventListener("submit", runComparison);

  // 음성 상태 표시(Requirement 1 상태 피드백).
  voice.onStateChange((state) => {
    if (!voiceStateEl) return;
    const labels = {
      idle: "",
      recording: "🔴 녹음 중...",
      transcribing: "⏳ 변환 중...",
      error: "⚠️ 오류",
    };
    voiceStateEl.textContent = labels[state] ?? "";
  });

  // 초기 렌더.
  refreshRecords();

  return {
    selectInputMode,
    startVoiceCapture,
    submitTextInput,
    approveAndSave,
    showConfirmScreen,
    refreshRecords,
    runAnalysis,
    runComparison,
    getCurrentDraft: () => currentDraft,
  };
}

// 브라우저 환경에서만 자동 초기화한다. (테스트 환경에서는 import만 하고 initApp을 호출하지 않는다.)
if (typeof document !== "undefined" && typeof window !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => initApp());
  } else {
    initApp();
  }
}
