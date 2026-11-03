// Feature: medication-duration-tracker
// Record_Store: 기록의 영구 저장·조회·수정·삭제 (Requirement 3).
//
// 저장소는 세 계층으로 폴백한다.
//   1) IndexedDB      - 브라우저 기본 영구 저장소(선호).
//   2) localStorage   - IndexedDB 미지원 시 폴백.
//   3) in-memory Map  - 브라우저 API가 전혀 없는 환경(Node/vitest) 폴백. 테스트 용이성 확보.
//
// save는 공통 검증(validation.js)과 개인정보 검사(pii.js)를 통과한 레코드만 저장하며,
// 저장 시 id(crypto.randomUUID())와 createdAt(생성 시각)을 부여한다.
// 공개 API(save/list/update/remove/getByMedication)는 모두 Promise를 반환한다.
// _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9

import { truncateToMinute } from "./constants.js";
import { validateInput } from "./validation.js";
import { detectPIIInRecord } from "./pii.js";

// ---------------------------------------------------------------------------
// 상수
// ---------------------------------------------------------------------------

const DB_NAME = "medication-duration-tracker";
const DB_VERSION = 1;
const STORE_NAME = "records";
const LS_KEY = "mdt:records";

/** update/remove 대상 id가 저장소에 없을 때의 오류 메시지(Requirement 3.7). */
export const NOT_FOUND_MESSAGE = "대상 기록 없음";

// ---------------------------------------------------------------------------
// 오류 타입
// ---------------------------------------------------------------------------

/**
 * 저장 거부 오류. 검증 실패(Requirement 5) 또는 개인정보 포함(Requirement 3.3, 3.9) 시 throw 된다.
 * 호출 측(UI)이 reason/codes로 분기하여 사용자에게 사유별 오류 표시를 제공한다(Requirement 3.2, 3.3).
 */
export class RecordStoreError extends Error {
  /**
   * @param {string} message
   * @param {{ reason: string, codes?: string[] }} meta
   */
  constructor(message, { reason, codes = [] } = { reason: "UNKNOWN" }) {
    super(message);
    this.name = "RecordStoreError";
    this.reason = reason;
    this.codes = codes;
  }
}

/** 저장 거부 사유 구분 코드. */
export const StoreRejectReason = Object.freeze({
  VALIDATION: "VALIDATION", // 입력 검증 실패 (Requirement 5)
  PII: "PII", // 개인정보 포함 (Requirement 3.3, 3.9)
  NOT_FOUND: "NOT_FOUND", // 대상 기록 없음 (Requirement 3.7)
});

// ---------------------------------------------------------------------------
// 백엔드 추상화
// ---------------------------------------------------------------------------
// 각 백엔드는 공통 인터페이스를 구현한다:
//   getAll(): Promise<MedicationRecord[]>   - 저장된 전체 레코드(순서 무관)
//   put(record): Promise<void>              - id 기준 삽입/갱신
//   get(id): Promise<MedicationRecord|null> - 단건 조회
//   delete(id): Promise<void>               - 단건 삭제

/**
 * in-memory 백엔드. 브라우저 저장소가 없는 환경(Node/vitest)에서 사용한다.
 */
class MemoryBackend {
  constructor() {
    /** @type {Map<string, import('./constants.js').MedicationRecord>} */
    this._map = new Map();
  }
  async getAll() {
    return Array.from(this._map.values()).map((r) => ({ ...r }));
  }
  async put(record) {
    this._map.set(record.id, { ...record });
  }
  async get(id) {
    const r = this._map.get(id);
    return r ? { ...r } : null;
  }
  async delete(id) {
    this._map.delete(id);
  }
}

/**
 * localStorage 백엔드. IndexedDB 미지원 브라우저 폴백.
 * 전체 레코드를 단일 JSON 배열로 직렬화하여 보관한다.
 */
class LocalStorageBackend {
  constructor(storage) {
    this._ls = storage;
  }
  _readAll() {
    try {
      const raw = this._ls.getItem(LS_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  _writeAll(records) {
    this._ls.setItem(LS_KEY, JSON.stringify(records));
  }
  async getAll() {
    return this._readAll();
  }
  async put(record) {
    const all = this._readAll();
    const idx = all.findIndex((r) => r.id === record.id);
    if (idx >= 0) all[idx] = record;
    else all.push(record);
    this._writeAll(all);
  }
  async get(id) {
    return this._readAll().find((r) => r.id === id) ?? null;
  }
  async delete(id) {
    this._writeAll(this._readAll().filter((r) => r.id !== id));
  }
}

/**
 * IndexedDB 백엔드. 브라우저 기본 영구 저장소.
 */
class IndexedDbBackend {
  constructor(idbFactory) {
    this._factory = idbFactory;
    this._dbPromise = null;
  }
  _open() {
    if (this._dbPromise) return this._dbPromise;
    this._dbPromise = new Promise((resolve, reject) => {
      const req = this._factory.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this._dbPromise;
  }
  async _tx(mode, fn) {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const store = tx.objectStore(STORE_NAME);
      let result;
      Promise.resolve(fn(store))
        .then((r) => {
          result = r;
        })
        .catch(reject);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  _reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async getAll() {
    return this._tx("readonly", (store) => this._reqToPromise(store.getAll()));
  }
  async put(record) {
    await this._tx("readwrite", (store) => this._reqToPromise(store.put(record)));
  }
  async get(id) {
    const r = await this._tx("readonly", (store) =>
      this._reqToPromise(store.get(id))
    );
    return r ?? null;
  }
  async delete(id) {
    await this._tx("readwrite", (store) =>
      this._reqToPromise(store.delete(id))
    );
  }
}

/**
 * 실행 환경을 탐지하여 적합한 백엔드를 선택한다.
 * IndexedDB → localStorage → in-memory 순으로 폴백한다.
 * @param {object} [env] - 테스트에서 주입 가능한 환경 객체(기본: globalThis).
 * @returns {MemoryBackend|LocalStorageBackend|IndexedDbBackend}
 */
function selectBackend(env) {
  const g = env ?? (typeof globalThis !== "undefined" ? globalThis : {});
  // IndexedDB: open 함수를 제공하는지 확인한다.
  if (g.indexedDB && typeof g.indexedDB.open === "function") {
    return new IndexedDbBackend(g.indexedDB);
  }
  // localStorage: 실제 Web Storage API(getItem/setItem)를 제공하는지 확인한다.
  // 일부 런타임은 getter/setter 없는 비기능 localStorage 전역을 노출하므로 메서드 존재를 검사한다.
  if (
    g.localStorage &&
    typeof g.localStorage.getItem === "function" &&
    typeof g.localStorage.setItem === "function"
  ) {
    return new LocalStorageBackend(g.localStorage);
  }
  // 브라우저 저장소가 없는 환경(Node/vitest)은 in-memory 폴백.
  return new MemoryBackend();
}

/**
 * id 생성기. crypto.randomUUID()를 선호하고, 미지원 환경에서는 폴백한다.
 * @returns {string}
 */
function generateId() {
  const c = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  // 폴백: 충분히 고유한 식별자(테스트/구형 환경 전용).
  return (
    "rec-" +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 10)
  );
}

// ---------------------------------------------------------------------------
// Record_Store
// ---------------------------------------------------------------------------

/**
 * 기록 저장소. 저장·조회·수정·삭제를 담당한다(Requirement 3).
 * 공개 메서드는 모두 Promise를 반환한다.
 */
export class RecordStore {
  /**
   * @param {object} [options]
   * @param {object} [options.backend] - 직접 주입할 백엔드(테스트용).
   * @param {object} [options.env] - 백엔드 탐지에 사용할 환경 객체(기본 globalThis).
   * @param {() => number} [options.now] - 현재 시각(epoch ms) 제공자. 검증·createdAt에 사용.
   */
  constructor({ backend, env, now } = {}) {
    this._backend = backend ?? selectBackend(env);
    this._now = typeof now === "function" ? now : () => Date.now();
  }

  /**
   * 레코드를 영구 저장한다. 공통 검증(Requirement 5)과 개인정보 검사(Requirement 3.3, 3.9)를
   * 통과한 레코드만 저장하며, id와 createdAt을 부여한다(Requirement 3.1).
   * 검증 실패·개인정보 포함 시 RecordStoreError를 reject한다(Requirement 3.2, 3.3).
   *
   * @param {import('./constants.js').MedicationRecordInput} recordInput
   * @returns {Promise<import('./constants.js').MedicationRecord>} 저장된 레코드(id·createdAt 포함).
   */
  async save(recordInput) {
    const now = this._now();

    // 1) 개인정보 검사 — 포함 시 저장 거부(Requirement 3.3, 3.9).
    const pii = detectPIIInRecord(recordInput);
    if (pii.detected) {
      throw new RecordStoreError("개인정보가 포함되어 저장이 거부되었습니다.", {
        reason: StoreRejectReason.PII,
        codes: pii.reasons,
      });
    }

    // 2) 입력 검증 — 실패 시 저장 거부(Requirement 5.1~5.4). 입력 값은 보존(저장만 하지 않음).
    const validation = validateInput(recordInput, now);
    if (!validation.valid) {
      throw new RecordStoreError("입력 검증에 실패하여 저장이 거부되었습니다.", {
        reason: StoreRejectReason.VALIDATION,
        codes: validation.codes,
      });
    }

    // 3) 정규화된 값으로 레코드 구성. doseTime은 분 해상도로 절삭한다.
    const medicationName = validation.fields.medicationName.value;
    const doseTime = truncateToMinute(validation.fields.doseTime.value);
    const effectDuration =
      validation.fields.effectDuration.value !== undefined
        ? validation.fields.effectDuration.value
        : recordInput.effectDuration; // '확인되지 않음' 통과 케이스

    /** @type {import('./constants.js').MedicationRecord} */
    const record = {
      id: generateId(),
      medicationName,
      doseTime,
      effectDuration,
      createdAt: now,
    };

    await this._backend.put(record);
    return { ...record };
  }

  /**
   * 저장된 모든 레코드를 Dose_Time 기준 내림차순으로 반환한다(Requirement 3.4).
   * 저장된 레코드가 없으면 빈 배열을 반환한다(Requirement 3.5).
   * @returns {Promise<import('./constants.js').MedicationRecord[]>}
   */
  async list() {
    const all = await this._backend.getAll();
    return all
      .slice()
      .sort((a, b) => b.doseTime - a.doseTime);
  }

  /**
   * 기존 레코드를 갱신하고 갱신된 레코드를 반환한다(Requirement 3.6).
   * 대상 id가 없으면 거부한다(Requirement 3.7).
   * patch에 포함된 필드만 검증·정규화 후 반영한다.
   *
   * @param {string} id
   * @param {Partial<import('./constants.js').MedicationRecordInput>} patch
   * @returns {Promise<import('./constants.js').MedicationRecord>}
   */
  async update(id, patch) {
    const existing = await this._backend.get(id);
    if (!existing) {
      throw new RecordStoreError(NOT_FOUND_MESSAGE, {
        reason: StoreRejectReason.NOT_FOUND,
      });
    }

    const now = this._now();
    const p = patch ?? {};

    // 갱신 후보를 기존 값과 병합하여 전체 검증·개인정보 검사를 적용한다.
    const merged = {
      medicationName:
        p.medicationName !== undefined ? p.medicationName : existing.medicationName,
      doseTime: p.doseTime !== undefined ? p.doseTime : existing.doseTime,
      effectDuration:
        p.effectDuration !== undefined
          ? p.effectDuration
          : existing.effectDuration,
    };

    // 개인정보 검사(Requirement 3.3, 3.9).
    const pii = detectPIIInRecord(merged);
    if (pii.detected) {
      throw new RecordStoreError("개인정보가 포함되어 저장이 거부되었습니다.", {
        reason: StoreRejectReason.PII,
        codes: pii.reasons,
      });
    }

    // 입력 검증(Requirement 5).
    const validation = validateInput(merged, now);
    if (!validation.valid) {
      throw new RecordStoreError("입력 검증에 실패하여 갱신이 거부되었습니다.", {
        reason: StoreRejectReason.VALIDATION,
        codes: validation.codes,
      });
    }

    const effectDuration =
      validation.fields.effectDuration.value !== undefined
        ? validation.fields.effectDuration.value
        : merged.effectDuration;

    /** @type {import('./constants.js').MedicationRecord} */
    const updated = {
      id: existing.id,
      medicationName: validation.fields.medicationName.value,
      doseTime: truncateToMinute(validation.fields.doseTime.value),
      effectDuration,
      createdAt: existing.createdAt,
    };

    await this._backend.put(updated);
    return { ...updated };
  }

  /**
   * 레코드를 저장소에서 제거한다(Requirement 3.8).
   * 대상 id가 없으면 거부한다(Requirement 3.7).
   * @param {string} id
   * @returns {Promise<void>}
   */
  async remove(id) {
    const existing = await this._backend.get(id);
    if (!existing) {
      throw new RecordStoreError(NOT_FOUND_MESSAGE, {
        reason: StoreRejectReason.NOT_FOUND,
      });
    }
    await this._backend.delete(id);
  }

  /**
   * 특정 약물명(및 선택적 기간)으로 레코드를 조회한다. Dose_Time 내림차순으로 반환한다.
   * 분석·비교 엔진이 저장소를 읽을 때 사용한다.
   *
   * @param {string} name - 조회할 Medication_Name(공백 제거 후 정확히 일치).
   * @param {import('./constants.js').DateRange} [range] - 선택적 Dose_Time 기간(포함 범위).
   * @returns {Promise<import('./constants.js').MedicationRecord[]>}
   */
  async getByMedication(name, range) {
    const target = typeof name === "string" ? name.trim() : "";
    const all = await this.list(); // 이미 내림차순 정렬됨
    return all.filter((r) => {
      if (r.medicationName !== target) return false;
      if (range) {
        if (typeof range.startMs === "number" && r.doseTime < range.startMs) {
          return false;
        }
        if (typeof range.endMs === "number" && r.doseTime > range.endMs) {
          return false;
        }
      }
      return true;
    });
  }
}

/**
 * 기본 RecordStore 인스턴스를 생성하는 편의 팩토리.
 * 실행 환경(IndexedDB/localStorage/in-memory)을 자동 탐지한다.
 * @param {object} [options] - RecordStore 생성자 옵션.
 * @returns {RecordStore}
 */
export function createRecordStore(options) {
  return new RecordStore(options);
}
