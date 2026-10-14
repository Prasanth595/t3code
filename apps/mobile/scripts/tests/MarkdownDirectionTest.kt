package com.swmansion.enriched.markdown

import com.swmansion.enriched.markdown.utils.text.MajorityTextDirection
import org.junit.Assert.assertEquals
import org.junit.Test

class MarkdownDirectionTest {
  @Test fun choosesProseDirection() {
    val cases = listOf(
      "Device hub: מאפשר לנהל את כל המכשירים ממקום אחד." to true,
      "git status يعرض حالة المستودع الحالية." to true,
      "Use the הגדרות panel to change the theme." to false,
      "١٢٣٤٥٦٧٨٩٠ Hi" to false,
      "١٢٣٤٥٦٧٨٩٠ ، ؛ ؟ 🎉" to false,
      "\u064e\u0650\u0651 Hi" to false,
      "abc אבג" to false,
      "\u200FHello" to true,
      "\u061CHello" to true,
      "\u200Eمرحبا" to false,
      "\uD83B\uDE00\uD83B\uDE01\uD83B\uDE02 a" to true,
      "" to false,
    )
    for ((text, rtl) in cases) {
      assertEquals(text, rtl, MajorityTextDirection.isRtl(text, 0, text.length))
      assertEquals(text, rtl, MajorityTextDirection.isRtl(text.toCharArray(), 0, text.length))
    }
  }

  @Test fun onlyCountsTheRequestedParagraphRange() {
    val text = "Long English prefix שלום Long English suffix"
    assertEquals(true, MajorityTextDirection.isRtl(text, 20, 4))
  }
}
