// Feature: medication-duration-tracker
// save_pipeline: 출처 무관(음성·텍스트) 공통 저장 경로 (Requirement 7.3, 7.5).
//
// 사용자 확인을 통과한 Input_Draft를 받아, 메타데이터(`source`·`missing`)를 제거하여
// MedicationRecordInput으로 변환한 뒤, 공통 저장 경로(RecordStore.save)로 전달한다.
// RecordStore.save는 내부적으로 입력 검증(Requirement 5)과 개인정보 검사(Requirement 3)를
// 수행하므로, 이 모듈은 검증·개인정보 로직을 중복 구현하지 않고 단일 구현을 재사용한다.
//
// 핵심 보장: 변환·저장 분기는 Input_Draft의 `source`('voice' | 'text')에 전혀 의존하지 않는다.
// 동일한 필드 값(medicationName·doseTime·effectDuration)을 가진 두 Input_Draft는 출처와
// 무관하게 동일한 MedicationRecordInput으로 변환되어 동일한 저장 결과(수락/거부·사유)를 낸다.
// _Requirements: 7.3, 7.5_

/**
 * 확인된 Input_Draft를 저장용 입력(MedicationRecordInput)으로 변환한다.
 *
 * Input_Draft의 메타데이터 필드(`source`·`missing`)는 저장 모델에 존재하지 않으므로 제거하고,
 * 저장 대상 값 필드(medicationName·doseTime·effectDuration)만 추려 반환한다.
 * 어떤 값도 저장하지 않으며, 검증·정규화는 수행하지 않는다(공통 저장 경로가 담당).
 *
 * `source`는 의도적으로 읽지 않는다 — 변환 결과는 출처와 무관하게 동일하다(Requirement 7.5).
 *
 * @param {import('./constants.js').InputDraft} draft - 사용자 확인을 통과한 Input_Draft.
 * @returns {import('./constants.js').MedicationRecordInput} source·missing이 제거된 저장용 입력.
 */
export function draftToRecordInput(draft) {
  const d = draft ?? {};
  // 값 필드만 명시적으로 추려낸다. source·missing은 포함하지 않는다.
  // (전개 후 delete가 아닌 화이트리스트 방식으로, source가 결과에 흘러들지 않음을 구조적으로 보장한다.)
  return {
    medicationName: d.medicationName,
    doseTime: d.doseTime,
    effectDuration: d.effectDuration,
  };
}

/**
 * 확인된 Input_Draft를 공통 저장 경로로 흘려보낸다.
 *
 * 순서: source·missing 제거(변환) → RecordStore.save 호출.
 * RecordStore.save가 입력 검증(Requirement 5) + 개인정보 검사(Requirement 3)를 수행한 뒤,
 * 통과한 레코드만 저장하고 id·createdAt을 부여한다. 검증 실패·개인정보 포함 시
 * RecordStore.save가 RecordStoreError를 throw 하며, 이 함수는 이를 가로채지 않고 그대로 전파한다.
 *
 * 이 함수의 분기는 `draft.source`에 의존하지 않으므로, 음성·텍스트 두 출처는 동일하게 처리된다
 * (Requirement 7.3, 7.5).
 *
 * @param {import('./constants.js').InputDraft} draft - 사용자 확인을 통과한 Input_Draft.
 * @param {import('./Record_Store.js').RecordStore} store - 저장을 수행할 RecordStore 인스턴스.
 * @returns {Promise<import('./constants.js').MedicationRecord>} 저장된 레코드(id·createdAt 포함).
 */
export function saveConfirmedDraft(draft, store) {
  if (!store || typeof store.save !== "function") {
    throw new TypeError(
      "saveConfirmedDraft: 유효한 RecordStore 인스턴스(save 메서드 보유)가 필요합니다.",
    );
  }
  const recordInput = draftToRecordInput(draft);
  return store.save(recordInput);
}
