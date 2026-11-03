// Feature: medication-duration-tracker
// Voice_Input_Module: 음성 캡처와 전사(Transcript) 생성 (Requirement 1).
// Web Speech API(SpeechRecognition / webkitSpeechRecognition)를 사용하며,
// 외부 서버·네트워크 전송 없이 브라우저 내에서 동작한다.
// _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

import { MAX_RECORDING_DURATION_SEC } from "./constants.js";

/**
 * 전사(변환) 최대 허용 시간(초). 이 시간을 초과하면 transcription-timeout 오류로 처리한다.
 * Requirement 1.3("캡처 종료 후 10초 이내에 Transcript로 변환")의 상한.
 */
export const TRANSCRIPTION_TIMEOUT_SEC = 10;

/**
 * 캡처 상태. onStateChange 콜백으로 통지된다.
 * @readonly
 * @enum {string}
 */
export const VoiceState = {
  IDLE: "idle",
  RECORDING: "recording",
  TRANSCRIBING: "transcribing",
  ERROR: "error",
};

/**
 * 구분된 음성 입력 오류 코드. UI 조율 계층이 사유별로 분기·메시지 표시에 사용한다.
 * @readonly
 * @enum {string}
 */
export const VoiceErrorCode = {
  /** 마이크 접근 권한 거부 (Requirement 1.4). 캡처를 시작하지 않는다. */
  NOT_ALLOWED: "not-allowed",
  /** Web Speech API 미지원 브라우저 (Requirement 1.4 확장). 수동 입력 경로로 안내. */
  UNSUPPORTED: "unsupported",
  /** 전사 변환이 10초를 초과 (Requirement 1.3, 1.5). */
  TRANSCRIPTION_TIMEOUT: "transcription-timeout",
  /** 전사 생성 실패(결과 없음·엔진 오류 등) (Requirement 1.5). */
  TRANSCRIPTION_FAILED: "transcription-failed",
};

/**
 * 분류된 음성 입력 오류. message가 아닌 code로 분기하도록 한다.
 */
export class VoiceInputError extends Error {
  /**
   * @param {VoiceErrorCode} code - 구분된 오류 코드.
   * @param {string} [message] - 사람이 읽는 보조 메시지(분기에는 사용하지 않음).
   */
  constructor(code, message) {
    super(message ?? code);
    this.name = "VoiceInputError";
    this.code = code;
  }
}

/**
 * 현재 환경에서 사용 가능한 SpeechRecognition 생성자를 반환한다.
 * 표준(SpeechRecognition) 우선, 접두사(webkitSpeechRecognition) 폴백.
 * 미지원 환경(생성자 부재)에서는 null을 반환한다.
 * @param {*} [env] - 전역 객체(테스트에서 주입). 기본값은 globalThis.
 * @returns {(new () => any) | null}
 */
export function getSpeechRecognitionCtor(env) {
  const g =
    env ?? (typeof globalThis !== "undefined" ? globalThis : undefined);
  if (!g) return null;
  return g.SpeechRecognition ?? g.webkitSpeechRecognition ?? null;
}

/**
 * Web Speech API 기반 음성 입력 모듈을 생성한다.
 *
 * 주의: 어떤 오류 경로에서도 이미 입력·확인된 기록 데이터는 보존한다. 이 모듈은
 * 입력 데이터를 저장하지 않으며, 상태 통지와 Transcript 산출만 담당한다. 연속 실패
 * 횟수 추적과 3회 도달 시 재시도 중단(Requirement 1.6)은 UI 조율 계층의 책임이다.
 *
 * @param {Object} [deps] - 의존성 주입(테스트용).
 * @param {(new () => any) | null} [deps.recognitionCtor] - SpeechRecognition 생성자. 미지정 시 환경에서 탐지.
 * @param {*} [deps.env] - 전역 객체(생성자 탐지용). 기본값은 globalThis.
 * @returns {{
 *   startCapture: (options?: { maxDurationSec?: number, transcriptionTimeoutSec?: number }) => Promise<string>,
 *   stopCapture: () => void,
 *   onStateChange: (cb: (state: string) => void) => (() => void),
 *   getState: () => string,
 *   isSupported: () => boolean,
 * }}
 */
export function createVoiceInputModule(deps = {}) {
  const ctor =
    deps.recognitionCtor !== undefined
      ? deps.recognitionCtor
      : getSpeechRecognitionCtor(deps.env);

  /** @type {Set<(state: string) => void>} */
  const listeners = new Set();
  let state = VoiceState.IDLE;

  // 현재 진행 중인 세션 자원. 재진입·누수를 막기 위해 단일 세션만 허용한다.
  /** @type {any} */
  let recognition = null;
  let recordingTimer = null; // 180초 자동 종료 타이머
  let transcriptionTimer = null; // 10초 전사 타임아웃 타이머
  let settled = false; // 현재 세션의 Promise가 종결되었는지

  function setState(next) {
    if (state === next) return;
    state = next;
    for (const cb of listeners) {
      try {
        cb(state);
      } catch {
        // 리스너 예외가 캡처 흐름을 깨뜨리지 않도록 격리한다.
      }
    }
  }

  function clearTimers() {
    if (recordingTimer !== null) {
      clearTimeout(recordingTimer);
      recordingTimer = null;
    }
    if (transcriptionTimer !== null) {
      clearTimeout(transcriptionTimer);
      transcriptionTimer = null;
    }
  }

  function teardownRecognition() {
    if (recognition) {
      // 콜백 분리로 종결 이후 지연 이벤트의 영향 차단.
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.onaudiostart = null;
      try {
        recognition.abort?.();
      } catch {
        // 일부 구현은 이미 종료된 인식기에서 throw할 수 있다. 무시.
      }
    }
    recognition = null;
  }

  /**
   * 입력 세션을 시작한다. 최대 Max_Recording_Duration(기본 180초) 후 자동 종료되며,
   * 캡처 종료 후 전사가 transcriptionTimeoutSec(기본 10초)를 초과하면 타임아웃 오류로 reject한다.
   * @param {{ maxDurationSec?: number, transcriptionTimeoutSec?: number }} [options]
   * @returns {Promise<string>} 성공 시 Transcript 문자열, 실패 시 VoiceInputError로 reject.
   */
  function startCapture(options = {}) {
    const maxDurationSec = options.maxDurationSec ?? MAX_RECORDING_DURATION_SEC;
    const transcriptionTimeoutSec =
      options.transcriptionTimeoutSec ?? TRANSCRIPTION_TIMEOUT_SEC;

    // 미지원 환경: 캡처를 시작하지 않고 구분된 오류로 reject (Requirement 1.4 확장).
    if (!ctor) {
      setState(VoiceState.ERROR);
      return Promise.reject(
        new VoiceInputError(
          VoiceErrorCode.UNSUPPORTED,
          "이 브라우저는 음성 인식을 지원하지 않습니다. 텍스트 입력을 사용하세요.",
        ),
      );
    }

    // 세션이 이미 진행 중이면 재시작을 막는다(중복 세션 방지).
    if (state === VoiceState.RECORDING || state === VoiceState.TRANSCRIBING) {
      return Promise.reject(
        new VoiceInputError(
          VoiceErrorCode.TRANSCRIPTION_FAILED,
          "이미 음성 입력 세션이 진행 중입니다.",
        ),
      );
    }

    settled = false;

    return new Promise((resolve, reject) => {
      const finish = (fn, arg, nextState) => {
        if (settled) return;
        settled = true;
        clearTimers();
        teardownRecognition();
        setState(nextState);
        fn(arg);
      };

      const succeed = (transcript) =>
        finish(resolve, transcript, VoiceState.IDLE);
      const fail = (code, message) =>
        finish(reject, new VoiceInputError(code, message), VoiceState.ERROR);

      let instance;
      try {
        instance = new ctor();
      } catch {
        setState(VoiceState.ERROR);
        settled = true;
        reject(
          new VoiceInputError(
            VoiceErrorCode.UNSUPPORTED,
            "음성 인식기를 초기화할 수 없습니다.",
          ),
        );
        return;
      }
      recognition = instance;

      // 단발성 인식 설정(연속 모드 비활성화).
      try {
        instance.continuous = false;
        instance.interimResults = false;
      } catch {
        // 일부 구현에서 속성 설정이 불가할 수 있으나 치명적이지 않다.
      }

      // 전사 결과 수신: 10초 타임아웃을 멈추고 Transcript를 resolve (Requirement 1.3).
      instance.onresult = (event) => {
        if (settled) return;
        const transcript = extractTranscript(event);
        if (transcript === null || transcript === "") {
          // 결과 이벤트는 왔으나 유효 Transcript가 없음 → 전사 실패 (Requirement 1.5).
          fail(
            VoiceErrorCode.TRANSCRIPTION_FAILED,
            "전사 결과를 생성하지 못했습니다.",
          );
          return;
        }
        succeed(transcript);
      };

      // 엔진 오류 분류: 권한 거부(not-allowed/service-not-allowed)와 그 외 전사 실패 구분.
      instance.onerror = (event) => {
        if (settled) return;
        const err = event?.error;
        if (err === "not-allowed" || err === "service-not-allowed") {
          // 마이크 권한 거부: 캡처를 시작하지 않은 것으로 간주하고 안내 (Requirement 1.4).
          fail(
            VoiceErrorCode.NOT_ALLOWED,
            "마이크 접근 권한이 필요합니다.",
          );
          return;
        }
        // no-speech·audio-capture·network·aborted 등은 전사 실패로 처리 (Requirement 1.5).
        fail(
          VoiceErrorCode.TRANSCRIPTION_FAILED,
          `전사에 실패했습니다: ${err ?? "unknown"}`,
        );
      };

      // 녹음 종료(음성 끝) → 전사 단계로 전환하고 10초 타임아웃을 건다 (Requirement 1.3).
      instance.onend = () => {
        if (settled) return;
        // onresult/onerror가 아직 오지 않은 상태에서 녹음만 끝난 경우.
        beginTranscriptionWindow();
      };

      function beginTranscriptionWindow() {
        if (settled) return;
        if (state !== VoiceState.TRANSCRIBING) {
          setState(VoiceState.TRANSCRIBING);
        }
        if (transcriptionTimer === null) {
          transcriptionTimer = setTimeout(() => {
            // 전사 변환이 10초를 초과 (Requirement 1.3, 1.5).
            fail(
              VoiceErrorCode.TRANSCRIPTION_TIMEOUT,
              "전사 변환이 10초를 초과했습니다.",
            );
          }, transcriptionTimeoutSec * 1000);
        }
      }
      // beginTranscriptionWindow를 stopCapture에서도 쓸 수 있도록 노출.
      instance.__beginTranscriptionWindow = beginTranscriptionWindow;

      // 캡처 시작 (Requirement 1.1). start()가 throw하면 권한/상태 문제로 분류.
      try {
        instance.start();
      } catch (e) {
        // start 단계의 예외는 권한 거부(SecurityError/NotAllowedError) 가능성이 높다.
        const name = e?.name;
        if (name === "NotAllowedError" || name === "SecurityError") {
          fail(VoiceErrorCode.NOT_ALLOWED, "마이크 접근 권한이 필요합니다.");
        } else {
          fail(
            VoiceErrorCode.TRANSCRIPTION_FAILED,
            `음성 캡처를 시작하지 못했습니다: ${name ?? "unknown"}`,
          );
        }
        return;
      }

      setState(VoiceState.RECORDING);

      // 180초(기본) 자동 종료 (Requirement 1.2). 녹음을 멈추면 전사 단계로 전환된다.
      recordingTimer = setTimeout(() => {
        if (settled) return;
        requestStop();
      }, maxDurationSec * 1000);
    });
  }

  /**
   * 진행 중인 인식기를 멈추고 전사 단계로 전환한다. 내부 공용 헬퍼.
   */
  function requestStop() {
    if (!recognition || settled) return;
    // 녹음 종료 타이머는 더 이상 필요 없다.
    if (recordingTimer !== null) {
      clearTimeout(recordingTimer);
      recordingTimer = null;
    }
    // 전사 윈도우(10초 타임아웃)를 먼저 연다. stop() 후 onend가 보장되지 않는 환경 대비.
    recognition.__beginTranscriptionWindow?.();
    try {
      recognition.stop?.();
    } catch {
      // stop 예외는 치명적이지 않다. onresult/onerror/타임아웃으로 종결된다.
    }
  }

  /**
   * 진행 중인 캡처를 수동 종료하고 전사를 시작한다 (Requirement 1.3).
   * 녹음 중이 아니면 무시한다.
   */
  function stopCapture() {
    if (state !== VoiceState.RECORDING) return;
    requestStop();
  }

  /**
   * 상태 변화 콜백을 등록한다. (idle | recording | transcribing | error)
   * @param {(state: string) => void} cb
   * @returns {() => void} 구독 해제 함수.
   */
  function onStateChange(cb) {
    if (typeof cb !== "function") {
      throw new TypeError("onStateChange: cb는 함수여야 합니다.");
    }
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  /** 현재 상태를 반환한다. */
  function getState() {
    return state;
  }

  /** 현재 환경에서 음성 인식이 지원되는지 여부. */
  function isSupported() {
    return ctor !== null && ctor !== undefined;
  }

  return { startCapture, stopCapture, onStateChange, getState, isSupported };
}

/**
 * SpeechRecognition 결과 이벤트에서 Transcript 문자열을 추출한다.
 * 표준 형태(event.results[i][0].transcript)를 우선 처리하고, 모의/단순 형태도 수용한다.
 * @param {*} event
 * @returns {string|null} 공백 제거 후 비어 있지 않은 Transcript, 없으면 null.
 */
export function extractTranscript(event) {
  if (!event) return null;

  // 모의/단순 형태: event.transcript 직접 제공.
  if (typeof event.transcript === "string") {
    const t = event.transcript.trim();
    return t === "" ? null : t;
  }

  const results = event.results;
  if (!results) return null;

  // 표준 SpeechRecognitionResultList: 인덱스 접근 가능한 유사 배열.
  const parts = [];
  const len = typeof results.length === "number" ? results.length : 0;
  for (let i = 0; i < len; i++) {
    const result = results[i];
    if (!result) continue;
    const alt = result[0];
    if (alt && typeof alt.transcript === "string") {
      parts.push(alt.transcript);
    }
  }
  const joined = parts.join(" ").trim();
  return joined === "" ? null : joined;
}

/** 기본 모듈 인스턴스(실제 환경의 전역 Web Speech API 사용). */
export default createVoiceInputModule;
