package expo.modules.t3terminal

import android.view.KeyEvent
import android.view.inputmethod.EditorInfo
import android.widget.TextView

internal class TerminalEnterListener(
  private val isReadOnly: () -> Boolean,
  private val sendEnter: () -> Unit,
) : TextView.OnEditorActionListener {
  override fun onEditorAction(view: TextView?, actionId: Int, event: KeyEvent?): Boolean {
    if (isReadOnly()) return true
    val isKeyUp = event?.action == KeyEvent.ACTION_UP
    val isImeSend = actionId == EditorInfo.IME_ACTION_SEND && !isKeyUp
    val isHardwareEnter = event?.keyCode == KeyEvent.KEYCODE_ENTER &&
      event.action == KeyEvent.ACTION_DOWN
    val isEnter = isImeSend || isHardwareEnter
    return if (isEnter) {
      sendEnter()
      true
    } else {
      false
    }
  }
}
