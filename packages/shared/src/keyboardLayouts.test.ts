import { describe, expect, it } from "vite-plus/test";

import {
  KEYBOARD_LAYOUTS,
  US_KEY_REFERENCE,
  US_NUMBER_KEY_REFERENCE,
  expandQueryAcrossKeyboardLayouts,
} from "./keyboardLayouts.ts";

describe("KEYBOARD_LAYOUTS", () => {
  const rows = KEYBOARD_LAYOUTS.flatMap((layout) =>
    [
      { row: layout.unshifted, reference: US_KEY_REFERENCE },
      { row: layout.shifted, reference: US_KEY_REFERENCE },
      { row: layout.numbers, reference: US_NUMBER_KEY_REFERENCE },
    ].flatMap(({ row, reference }) =>
      row === undefined
        ? []
        : [{ id: layout.id, characters: [...row], keyCount: [...reference].length }],
    ),
  );

  it("keeps every row aligned to the US reference and free of repeated keys", () => {
    expect(
      rows.filter((row) => row.characters.length !== row.keyCount).map((row) => row.id),
    ).toEqual([]);
    expect(
      rows.filter((row) => new Set(row.characters).size !== row.characters.length).map((r) => r.id),
    ).toEqual([]);
  });
});

describe("expandQueryAcrossKeyboardLayouts", () => {
  it("maps a query typed on a Cyrillic layout back to the Latin word", () => {
    expect(expandQueryAcrossKeyboardLayouts("кумшуц")).toContain("review");
  });

  it("maps by key rather than through a decomposed base letter", () => {
    // `й` sits on `q`, while the `и` it decomposes to sits on `b`.
    const variants = expandQueryAcrossKeyboardLayouts("й");

    expect(variants).toContain("q");
    expect(variants).not.toContain("b");
  });

  it("reaches an accented Greek vowel through its base letter", () => {
    expect(expandQueryAcrossKeyboardLayouts("ά")).toContain("a");
  });

  it("reads a key that overlaps two others both ways", () => {
    // Arabic types `night` as `ىهلاف`, where `لا` is both the lam-alef key and
    // the `g` and `h` keys in turn, so only offering both readings finds it.
    expect(expandQueryAcrossKeyboardLayouts("ىهلاف")).toEqual(["nibt", "night"]);
  });

  it("reads a decomposed accented letter like its composed spelling", () => {
    expect(expandQueryAcrossKeyboardLayouts("\u03B1\u0301")).toEqual(
      expandQueryAcrossKeyboardLayouts("\u03AC"),
    );
    expect(expandQueryAcrossKeyboardLayouts("\u03B1\u0301")).toContain("a");
  });

  it("reads each overlapping key on its own", () => {
    // `لالا` is two lam-alef keys, two `gh` pairs, or one of each in either order.
    expect([...expandQueryAcrossKeyboardLayouts("لالا")].toSorted()).toEqual([
      "bb",
      "bgh",
      "ghb",
      "ghgh",
    ]);
  });

  it("keeps only the two extreme readings once overlaps would multiply past the cap", () => {
    // Five overlapping keys would give 32 readings.
    expect([...expandQueryAcrossKeyboardLayouts("لالالالالا")].toSorted()).toEqual([
      "bbbbb",
      "ghghghghgh",
    ]);
  });

  it("reads the Thai number row, which carries letters instead of digits", () => {
    // `ภ` is the `4` key on Kedmanee and `น` the `o` key, so a model id stays reachable.
    expect(expandQueryAcrossKeyboardLayouts("ภน")).toContain("4o");
  });

  it("drops a reading that kept a non-ASCII character", () => {
    // A layout that places `е` but not `ы` maps all of `еруьуы` but that letter, and
    // the `themeы` it leaves behind can never match a Latin name.
    expect(expandQueryAcrossKeyboardLayouts("еруьуы")).toEqual(["themes"]);
  });

  it("leaves a query that is already ASCII alone", () => {
    expect(expandQueryAcrossKeyboardLayouts("review")).toEqual([]);
  });
});
