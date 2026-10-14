#import "MajorityTextDirection.h"

int main(void) {
  @autoreleasepool {
    NSArray<NSArray *> *cases = @[
      @[@"Device hub: מאפשר לנהל את כל המכשירים ממקום אחד.", @(NSWritingDirectionRightToLeft)],
      @[@"git status يعرض حالة المستودع الحالية.", @(NSWritingDirectionRightToLeft)],
      @[@"Use the הגדרות panel to change the theme.", @(NSWritingDirectionLeftToRight)],
      @[@"١٢٣٤٥٦٧٨٩٠ Hi", @(NSWritingDirectionLeftToRight)],
      @[@"١٢٣٤٥٦٧٨٩٠ ، ؛ ؟ 🎉", @(NSWritingDirectionNatural)],
      @[@"\u064e\u0650\u0651 Hi", @(NSWritingDirectionLeftToRight)],
      @[@"abc אבג", @(NSWritingDirectionLeftToRight)],
      @[@"\u200FHello", @(NSWritingDirectionRightToLeft)],
      @[@"\u061CHello", @(NSWritingDirectionRightToLeft)],
      @[@"\u200Eمرحبا", @(NSWritingDirectionLeftToRight)],
      @[@"\U0001EE00\U0001EE01\U0001EE02 a", @(NSWritingDirectionRightToLeft)],
      @[@"", @(NSWritingDirectionNatural)],
    ];
    for (NSArray *test in cases) {
      NSCAssert(ENRMMajorityTextDirection(test[0]) == [test[1] integerValue], @"Wrong direction: %@", test[0]);
    }
    printf("12 native direction cases passed\n");
  }
  return 0;
}
