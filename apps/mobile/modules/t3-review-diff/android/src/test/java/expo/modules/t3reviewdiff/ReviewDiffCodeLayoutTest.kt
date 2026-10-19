package expo.modules.t3reviewdiff

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.text.Spanned
import android.text.TextPaint
import android.text.style.BackgroundColorSpan
import android.view.View
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
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
class ReviewDiffCodeLayoutTest {
  private val paint = TextPaint().apply {
    color = Color.WHITE
    textSize = 24f
    typeface = Typeface.MONOSPACE
  }

  @Test
  fun unicodeAndTabsFitWithoutSplittingClusters() {
    val fixtures = listOf("漢字表示", "e\u0301", "👨‍👩‍👧‍👦", "مرحبا بالعالم ", "\tvalue ")
    for (fixture in fixtures) {
      val text = fixture.repeat(40)
      for (width in listOf(180, 280, 420)) {
        val layout = requireNotNull(createCodeLines(text, paint, width).nativeLayout)
        assertInkFits(layout, width, fixture)
        assertLinesFit(layout, fixture, width)
      }
    }
  }

  private fun assertLinesFit(layout: android.text.StaticLayout, fixture: String, width: Int) {
    val text = layout.text
    for (line in 0 until layout.lineCount) {
      if (!fixture.contains('\t')) {
        assertTrue("$fixture line $line at $width", layout.getLineMax(line) <= width + 1)
      }
      val start = layout.getLineStart(line)
      assertTrue(start == 0 || !Character.isLowSurrogate(text[start]))
      if (fixture == "👨‍👩‍👧‍👦" || fixture == "e\u0301") {
        assertEquals(0, start % fixture.length)
      }
    }
  }

  private fun assertInkFits(layout: android.text.StaticLayout, width: Int, fixture: String) {
    val bitmap = Bitmap.createBitmap(width + 40, layout.height, Bitmap.Config.ARGB_8888)
    layout.draw(Canvas(bitmap))
    for (x in width + 1 until bitmap.width) {
      for (y in 0 until bitmap.height) {
        assertEquals("$fixture ink outside width $width", 0, Color.alpha(bitmap.getPixel(x, y)))
      }
    }
    bitmap.recycle()
  }

  @Test
  fun asciiSegmentsCoverTheWholeLineAndFit() {
    val text = "const value = 123; ".repeat(100)
    val lines = createCodeLines(text, paint, 280)
    val pieces = lines.starts.indices.map {
      text.substring(lines.starts[it], lines.end(it, text.length))
    }
    assertEquals(text, pieces.joinToString(""))
    assertTrue(pieces.all { paint.measureText(it) <= 280 })
  }

  @Test
  fun changingCommentHeightReusesCodeButWidthAndContentInvalidateIt() {
    val cache = CodeLayoutCache()
    val row = row("漢字".repeat(100))
    val comment = row.copy(kind = "comment", id = "comment", content = "", commentText = "Before")
    val style = DiffStyle.defaults(1f).copy(wordWrap = true)
    val theme = DiffTheme.fallback("light")
    val first = cache.layout(
      listOf(row, comment),
      emptyMap(),
      paint,
      style,
      theme,
      280
    ).lines(row.id)
    val second = cache.layout(
      listOf(row, comment.copy(commentText = "After")),
      emptyMap(),
      paint,
      style,
      theme,
      280,
    ).lines(row.id)
    assertSame(first, second)
    val narrow = cache.layout(listOf(row), emptyMap(), paint, style, theme, 180).lines(row.id)
    assertNotSame(first, narrow)
    assertTrue(narrow.extraHeight > first.extraHeight)
    val edited = cache.layout(
      listOf(row.copy(content = "短い")),
      emptyMap(),
      paint,
      style,
      theme,
      180
    ).lines(row.id)
    assertTrue(edited.extraHeight < narrow.extraHeight)
    assertEquals(
      0,
      cache.layout(
        listOf(row),
        emptyMap(),
        paint,
        style.copy(wordWrap = false),
        theme,
        180
      ).extraHeight(row.id)
    )
  }

  @Test
  fun highlightsUseNativeTextRangesAndSurviveSyntaxArrival() {
    val cache = CodeLayoutCache()
    val row = row("漢字".repeat(30)).copy(wordDiffRanges = listOf(DiffWordDiffRange(3, 21)))
    val style = DiffStyle.defaults(1f).copy(wordWrap = true)
    val theme = DiffTheme.fallback("light")
    val initial = cache.layout(listOf(row), emptyMap(), paint, style, theme, 180).lines(row.id)
    val tokens = mapOf(row.id to listOf(DiffToken(row.content, 0xff008800.toInt(), 2)))
    val highlighted = cache.layout(listOf(row), tokens, paint, style, theme, 180).lines(row.id)
    assertNotSame(initial, highlighted)
    val text = requireNotNull(highlighted.nativeLayout).text as Spanned
    val span = text.getSpans(0, text.length, BackgroundColorSpan::class.java).single()
    assertEquals(3, text.getSpanStart(span))
    assertEquals(21, text.getSpanEnd(span))
  }

  @Test
  fun clippedAsciiMatchesVisibleTextAcrossWrapAndTokenBoundaries() {
    val drawing = ReviewDiffCanvasDrawing(RuntimeEnvironment.getApplication())
    val prefix = "const value = 123; ".repeat(30)
    val cases = listOf(false to "regular", true to "regular", false to "medium", true to "medium")
    for ((wrap, weight) in cases) {
      val content = prefix.repeat(if (weight == "regular") 1_000 else 2)
      val tokens =
        listOf(DiffToken(content.take(350), null, 0), DiffToken(content.drop(350), null, 0))
          .takeIf { weight == "regular" }
      val style = DiffStyle.defaults(1f).copy(wordWrap = wrap, codeFontWeight = weight)
      drawing.configureCodePaint(drawing.theme.text, 0, style)
      val codePaint = TextPaint(drawing.textPaint)
      val singleLine = CodeWrapLayout.NONE.lines("line")
      val lines = if (wrap) createCodeLines(prefix, codePaint, 180) else singleLine
      val expected = Bitmap.createBitmap(200, 100, Bitmap.Config.ARGB_8888)
      val actual = Bitmap.createBitmap(200, 100, Bitmap.Config.ARGB_8888)
      val x = if (wrap) 0f else -173f
      val baseline = if (wrap) -170f else 30f
      val expectedCanvas = Canvas(expected)
      for (line in lines.starts.indices) {
        val text = prefix.substring(lines.starts[line], lines.end(line, prefix.length))
        expectedCanvas.drawText(text, x, baseline + line * lines.height, codePaint)
      }
      val canvas = object : Canvas(actual) {
        override fun drawText(
          text: String,
          start: Int,
          end: Int,
          x: Float,
          y: Float,
          paint: Paint
        ) {
          if (weight == "regular") assertTrue("Offscreen text reached Canvas", end - start < 100)
          super.drawText(text, start, end, x, y, paint)
        }
      }
      val fullLines = if (wrap) createCodeLines(content, codePaint, 180) else lines
      drawing.drawCode(canvas, row(content), tokens, x, baseline, style, fullLines)
      assertTrue("wrap=$wrap weight=$weight", actual.sameAs(expected))
      actual.recycle()
      expected.recycle()
    }
  }

  @Test
  fun stickyHeadersDoNotReadOffscreenRowsWhileDrawing() {
    val type = Class.forName("expo.modules.t3reviewdiff.DiffCanvasView")
    val constructor = type.getDeclaredConstructor(Context::class.java).apply { isAccessible = true }
    val view = constructor.newInstance(RuntimeEnvironment.getApplication()) as View
    view.layout(0, 0, 200, 200)
    val header = row("").copy(kind = "file")
    val source = listOf(header) + List(10_000) { row("x") } + header
    var reads = 0
    val rows = object : AbstractList<DiffRow>() {
      override val size: Int get() = source.size
      override fun get(index: Int): DiffRow = source[index].also { reads += 1 }
    }
    type.getDeclaredMethod("setRows", List::class.java).apply {
      isAccessible = true
    }.invoke(view, rows)
    val top = type.getDeclaredMethod("rowTop", Int::class.java).apply {
      isAccessible = true
    }.invoke(view, 5_000)
    type.getDeclaredMethod("setVerticalOffset", Int::class.java).apply {
      isAccessible = true
    }.invoke(view, top)
    reads = 0
    view.draw(Canvas(Bitmap.createBitmap(200, 200, Bitmap.Config.ARGB_8888)))
    assertTrue("Drawing read $reads rows", reads < 100)
  }

  private fun row(content: String) = DiffRow(
    kind = "line", id = "line", fileId = "file", filePath = "test.ts", previousPath = null,
    changeType = "modified", additions = 1, deletions = 0, text = "", content = content,
    change = "add", oldLineNumber = null, newLineNumber = 1, wordDiffRanges = emptyList(),
    commentText = "", commentRangeLabel = "", commentSectionTitle = "",
  )
}
