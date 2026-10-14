package expo.modules.t3reviewdiff

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.text.TextPaint
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ReviewDiffCanvasDrawingTest {
  @Test
  fun longCommentsFitAndTruncationDoesNotSplitSurrogatePairs() {
    val paint = TextPaint().apply { textSize = 16f }
    for (text in listOf("Very long comment ".repeat(1_000), "\uD83D\uDE00".repeat(1_000))) {
      val clipped = ellipsizeDiffText(text, paint, 180f)
      assertTrue(clipped.endsWith("..."))
      assertTrue(paint.measureText(clipped) <= 180f)
      val prefix = clipped.dropLast(3)
      assertTrue(prefix.isEmpty() || !Character.isHighSurrogate(prefix.last()))
    }
    assertTrue(ellipsizeDiffText("Short", paint, 180f) == "Short")
  }

  @Test
  fun horizontallyClippedAsciiMatchesTheFullLine() {
    val drawing = ReviewDiffCanvasDrawing(RuntimeEnvironment.getApplication())
    val style = DiffStyle.defaults(1f).copy(codeFontSizePx = 16f)
    val content = "const value = 123; ".repeat(50)
    val tokens = listOf(
      DiffToken(content.substring(0, 101), Color.RED, 2),
      DiffToken(content.substring(101), Color.BLUE, 0),
    )
    val lines = CodeLines(intArrayOf(0), 0)
    val full = Bitmap.createBitmap(12_000, 40, Bitmap.Config.ARGB_8888)
    // Reference draws the full strings with the original Canvas text path.
    drawing.drawCode(Canvas(full), content, tokens, 0f, 24f, style, lines)
    for (offset in listOf(0, 950, 2_317)) {
      val clipped = Bitmap.createBitmap(200, 40, Bitmap.Config.ARGB_8888)
      drawing.drawCode(Canvas(clipped), content, tokens, -offset.toFloat(), 24f, style, lines, true)
      val expected = IntArray(200 * 40)
      val actual = IntArray(expected.size)
      full.getPixels(expected, 0, 200, offset, 0, 200, 40)
      clipped.getPixels(actual, 0, 200, 0, 0, 200, 40)
      assertTrue(actual.any { Color.alpha(it) > 0 })
      assertArrayEquals("horizontal clip at $offset", expected, actual)
      clipped.recycle()
    }
    full.recycle()
  }

  @Test
  fun clippedWrappedSyntaxMatchesTheFullDocumentAtTokenBoundaries() {
    val drawing = ReviewDiffCanvasDrawing(RuntimeEnvironment.getApplication())
    val style = DiffStyle.defaults(1f).copy(codeFontSizePx = 16f, wordWrap = true)
    val content = "const value = 123; ".repeat(500)
    // Run boundaries deliberately cross visual line boundaries.
    val tokens = listOf(
      DiffToken(content.substring(0, 901), Color.RED, 2),
      DiffToken(content.substring(901, 3_907), Color.GREEN, 1),
      DiffToken(content.substring(3_907), Color.BLUE, 0),
    )
    drawing.configureCodePaint(Color.BLACK, 0, style)
    val lines = createCodeLines(content, TextPaint(drawing.textPaint), 180)
    val baseline = 20f
    val full = Bitmap.createBitmap(200, lines.height * lines.starts.size + 40, Bitmap.Config.ARGB_8888)
    drawing.drawCode(Canvas(full), content, tokens, 0f, baseline, style, lines, true)
    for (offset in listOf(0, lines.height * 50 + 3, lines.height * 210 + 7)) {
      val clipped = Bitmap.createBitmap(200, 180, Bitmap.Config.ARGB_8888)
      val canvas = Canvas(clipped)
      canvas.translate(0f, -offset.toFloat())
      drawing.drawCode(canvas, content, tokens, 0f, baseline, style, lines, true)
      val expected = IntArray(200 * 180)
      val actual = IntArray(expected.size)
      full.getPixels(expected, 0, 200, 0, offset, 200, 180)
      clipped.getPixels(actual, 0, 200, 0, 0, 200, 180)
      assertTrue(actual.any { Color.alpha(it) > 0 })
      assertArrayEquals("clipped band at $offset", expected, actual)
      clipped.recycle()
    }
    full.recycle()
  }
}
