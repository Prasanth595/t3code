package expo.modules.t3terminal

import org.junit.Assert.assertEquals
import org.junit.Test

class TerminalFrameSchedulerTest {
  @Test
  fun outputBurstsRenderOnlyTheLatestGridOncePerFrame() {
    val callbacks = mutableListOf<Runnable>()
    var grid = 0
    val rendered = mutableListOf<Int>()
    val scheduler = TerminalFrameScheduler(
      post = { callbacks.add(it) },
      remove = { callbacks.remove(it) },
      render = { rendered.add(grid) },
    )
    repeat(100) {
      grid += 1
      scheduler.request()
    }
    assertEquals(1, callbacks.size)
    callbacks.removeAt(0).run()
    assertEquals(listOf(100), rendered)
    grid += 1
    scheduler.request()
    callbacks.removeAt(0).run()
    assertEquals(listOf(100, 101), rendered)
  }

  @Test
  fun outputArrivingDuringRenderSchedulesTheNextFrame() {
    val callbacks = mutableListOf<Runnable>()
    var rendered = 0
    lateinit var scheduler: TerminalFrameScheduler
    scheduler = TerminalFrameScheduler(
      post = { callbacks.add(it) },
      remove = { callbacks.remove(it) },
      render = {
        rendered += 1
        if (rendered == 1) scheduler.request()
      },
    )
    scheduler.request()
    callbacks.removeAt(0).run()
    assertEquals(1, callbacks.size)
    callbacks.removeAt(0).run()
    assertEquals(2, rendered)
    assertEquals(0, callbacks.size)
  }

  @Test
  fun detachingCancelsTheOldFrameAndReattachingCanRequestAnother() {
    val callbacks = mutableListOf<Runnable>()
    var rendered = 0
    val scheduler = TerminalFrameScheduler(
      post = { callbacks.add(it) },
      remove = { callbacks.remove(it) },
      render = { rendered += 1 },
    )
    scheduler.request()
    scheduler.cancel()
    assertEquals(0, callbacks.size)
    assertEquals(0, rendered)
    scheduler.request()
    callbacks.removeAt(0).run()
    assertEquals(1, rendered)
  }
}
