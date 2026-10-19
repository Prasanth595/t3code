import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";

const MODEL_PICKER_ORIGIN_STORAGE_KEY = "t3code:model-picker-origin:v1";

/** Which rail tab the last model was picked from, so the picker reopens there. */
const ModelPickerOrigin = Schema.Literals(["favorites", "instance"]);
export type ModelPickerOrigin = typeof ModelPickerOrigin.Type;

export function readModelPickerOrigin(): ModelPickerOrigin | null {
  try {
    return getLocalStorageItem(MODEL_PICKER_ORIGIN_STORAGE_KEY, ModelPickerOrigin);
  } catch (error) {
    console.error("Could not read model picker origin.", error);
    return null;
  }
}

export function writeModelPickerOrigin(origin: ModelPickerOrigin): void {
  try {
    setLocalStorageItem(MODEL_PICKER_ORIGIN_STORAGE_KEY, origin, ModelPickerOrigin);
  } catch (error) {
    console.error("Could not persist model picker origin.", error);
  }
}
