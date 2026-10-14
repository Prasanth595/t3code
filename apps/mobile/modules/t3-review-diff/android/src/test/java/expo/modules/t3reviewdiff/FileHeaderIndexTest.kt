package expo.modules.t3reviewdiff

import org.junit.Assert.assertEquals
import org.junit.Test

class FileHeaderIndexTest {
  @Test
  fun findsHeadersAtFileBoundariesAndAcrossLongFiles() {
    val headers = intArrayOf(3, 4, 50_000, 100_000)
    val index = FileHeaderIndex(headers)
    for (row in listOf(-1, 0, 2, 3, 4, 5, 49_999, 50_000, 99_999, 100_000, 200_000)) {
      assertEquals(headers.lastOrNull { it <= row } ?: -1, index.atOrBefore(row))
      assertEquals(headers.firstOrNull { it > row } ?: -1, index.after(row))
    }
  }

  @Test
  fun emptyAndCollapsedDocumentsHaveNoStaleHeaders() {
    val empty = FileHeaderIndex(intArrayOf())
    assertEquals(-1, empty.atOrBefore(0))
    assertEquals(-1, empty.after(0))
    // Collapsing a file replaces the index with the filtered row positions.
    val collapsed = FileHeaderIndex(intArrayOf(0, 1, 2))
    assertEquals(1, collapsed.atOrBefore(1))
    assertEquals(2, collapsed.after(1))
    assertEquals(-1, collapsed.after(2))
  }
}
