import UIKit

enum T3ComposerClipboard {
  static func read() -> [String: String] { [:] }
  static func write(text: String, fragment: String) {}
}

var failures = 0
var checks = 0
func check(_ passed: Bool, _ message: String) {
  checks += 1
  if !passed {
    failures += 1
    FileHandle.standardError.write(Data("FAIL: \(message)\n".utf8))
  }
}

func document(_ composer: T3ComposerEditorView, _ value: String, caret: Int? = nil) {
  let offset = caret ?? value.utf16.count
  let payload: [String: Any] = [
    "value": value,
    "selection": ["start": offset, "end": offset],
    "tokensJson": "[]",
    "mostRecentEventCount": 10_000,
    "isNativeEcho": false,
  ]
  guard let data = try? JSONSerialization.data(withJSONObject: payload),
        let json = String(data: data, encoding: .utf8) else {
    fatalError("Invalid controlled document fixture")
  }
  composer.setControlledDocumentJson(json)
  composer.layoutIfNeeded()
}

func caretIsVisible(_ editor: UITextView) -> Bool {
  guard let selection = editor.selectedTextRange else { return false }
  let caret = editor.caretRect(for: selection.end)
  let visible = editor.bounds.contains(CGPoint(x: caret.midX, y: caret.midY))
  return visible
}

let draft = (1...40).map { "Line \($0): a long composer draft" }.joined(separator: "\n")
for resizeBeforeProp in [false, true] {
  let composer = T3ComposerEditorView()
  composer.frame = CGRect(x: 0, y: 0, width: 320, height: 160)
  composer.layoutIfNeeded()
  guard let editor = composer.subviews.first as? UITextView else {
    fatalError("Missing composer text view")
  }
  document(composer, draft, caret: (draft as NSString).range(of: "Line 22:").location)
  editor.setContentOffset(CGPoint(x: 0, y: 320), animated: false)
  let previousOffset = editor.contentOffset.y

  func collapse() {
    if resizeBeforeProp {
      composer.frame.size.height = 36
      composer.layoutIfNeeded()
    }
    composer.setScrollEnabled(false)
    composer.setContentInsetVertical(6)
    composer.frame.size.height = 36
    composer.layoutIfNeeded()
    composer.setScrollEnabled(false)
  }

  func expand() {
    if resizeBeforeProp {
      composer.frame.size.height = 160
      composer.layoutIfNeeded()
    }
    composer.setScrollEnabled(true)
    composer.setContentInsetVertical(0)
    composer.frame.size.height = 160
    composer.layoutIfNeeded()
  }

  collapse()
  expand()
  check(abs(editor.contentOffset.y - previousOffset) < 1, "Restore offset after collapse, resize first: \(resizeBeforeProp), expected \(previousOffset), got \(editor.contentOffset.y)")
  check(caretIsVisible(editor), "Reveal caret after expansion")

  document(composer, draft)
  check(caretIsVisible(editor), "Reveal the caret at the end of a long draft")
  let longerDraft = draft + "\nNew dictated text at the end"
  document(composer, longerDraft)
  check(caretIsVisible(editor), "Reveal caret after controlled insertion")
  check(editor.selectedRange.location == longerDraft.utf16.count, "Keep the requested selection")

  editor.setContentOffset(CGPoint(x: 0, y: 200), animated: false)
  composer.setFontFamily("Helvetica")
  composer.layoutIfNeeded()
  check(abs(editor.contentOffset.y - 200) < 1, "Preserve manual scroll during a typography rebuild")
  document(composer, longerDraft)
  check(abs(editor.contentOffset.y - 200) < 1, "An unchanged controlled document must not reveal the caret")

  composer.setSelection(start: 0, end: 0)
  composer.layoutIfNeeded()
  check(caretIsVisible(editor), "Reveal an explicitly moved caret")
  composer.setSelection(start: longerDraft.utf16.count, end: longerDraft.utf16.count)
  composer.layoutIfNeeded()
  check(caretIsVisible(editor), "Reveal a caret moved to the end")

  editor.insertText(" typed text")
  composer.layoutIfNeeded()
  check(caretIsVisible(editor), "Reveal caret after native insertion")

  collapse()
  document(composer, longerDraft + String(repeating: "\nMore dictated text", count: 10))
  expand()
  check(caretIsVisible(editor), "Reveal text inserted while collapsed after expansion")

  collapse()
  document(composer, "")
  expand()
  check(abs(editor.contentOffset.y) < 1, "Clamp the saved offset when the draft is cleared")
  check(editor.text.isEmpty, "Keep the cleared draft empty")
}

print("\(checks - failures)/\(checks) composer scroll checks passed")
exit(failures == 0 ? 0 : 1)
