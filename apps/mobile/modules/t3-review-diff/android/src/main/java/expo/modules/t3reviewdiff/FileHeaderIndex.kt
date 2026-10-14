package expo.modules.t3reviewdiff

/** Index only headers; scrolling and hit testing must not walk every line in a file. */
internal class FileHeaderIndex(private val indices: IntArray) {
  fun atOrBefore(row: Int): Int = indices.getOrElse(upperBound(row) - 1) { -1 }

  fun after(row: Int): Int = indices.getOrElse(upperBound(row)) { -1 }

  private fun upperBound(row: Int): Int {
    var low = 0
    var high = indices.size
    while (low < high) {
      val middle = (low + high) ushr 1
      if (indices[middle] <= row) low = middle + 1 else high = middle
    }
    return low
  }
}
