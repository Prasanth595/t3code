package expo.modules.t3terminal

/** Feed every byte immediately, but materialize only the latest grid for a display frame. */
internal class TerminalFrameScheduler(
  private val post: (Runnable) -> Unit,
  private val remove: (Runnable) -> Unit,
  private val render: () -> Unit
) {
  private var pending = false
  private val callback = Runnable {
    pending = false
    render()
  }

  fun request() {
    if (pending) return
    pending = true
    post(callback)
  }

  fun cancel() {
    remove(callback)
    pending = false
  }
}
