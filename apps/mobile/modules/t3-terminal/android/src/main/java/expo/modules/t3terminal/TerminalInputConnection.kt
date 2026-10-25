package expo.modules.t3terminal

import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper

private const val MAX_DELETE_LENGTH = 1024

// The hidden input clears after every change, so text an IME deletes was
// already sent to the terminal. Some keyboards delete through these calls
// instead of KEYCODE_DEL, so forward them as terminal deletes.
internal class TerminalInputConnection(
  target: InputConnection,
  private val sendDeletes: (count: Int) -> Unit
) : InputConnectionWrapper(target, true) {
  override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
    forwardDeletes(beforeLength)
    return super.deleteSurroundingText(beforeLength, afterLength)
  }

  override fun deleteSurroundingTextInCodePoints(beforeLength: Int, afterLength: Int): Boolean {
    forwardDeletes(beforeLength)
    return super.deleteSurroundingTextInCodePoints(beforeLength, afterLength)
  }

  private fun forwardDeletes(beforeLength: Int) {
    if (beforeLength > 0) sendDeletes(beforeLength.coerceAtMost(MAX_DELETE_LENGTH))
  }
}
