package expo.modules.t3terminal

import android.view.inputmethod.EditorInfo
import android.widget.EditText
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], manifest = Config.NONE)
class TerminalInputConnectionTest {
  @Test
  fun imeDeletionReachesTheTerminalAfterTheInputClears() {
    val input = EditText(RuntimeEnvironment.getApplication())
    val deletes = mutableListOf<Int>()
    val connection = TerminalInputConnection(input.onCreateInputConnection(EditorInfo())!!) {
      deletes += it
    }

    connection.commitText("abc", 1)
    input.text.clear()
    connection.deleteSurroundingText(1, 0)
    connection.deleteSurroundingTextInCodePoints(2, 0)
    connection.deleteSurroundingText(Int.MAX_VALUE, 0)

    assertEquals(listOf(1, 2, 1024), deletes)
  }
}
