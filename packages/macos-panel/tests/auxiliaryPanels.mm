#import "../src/auxiliaryPanels.h"
#import "../src/outsideClicks.h"
#include <cstdio>
#include <cstdlib>

@interface TestPanel : NSPanel
@property BOOL simulatedKey;
@property BOOL simulatedVisible;
@property BOOL acceptsKeys;
@end
@implementation TestPanel
- (BOOL)isKeyWindow { return self.simulatedKey; }
- (BOOL)isVisible { return self.simulatedVisible; }
- (BOOL)canBecomeKeyWindow { return self.acceptsKeys; }
@end

static TestPanel *Panel(BOOL acceptsKeys) {
  TestPanel *panel = [[TestPanel alloc] initWithContentRect:NSMakeRect(-20000, -20000, 1, 1)
      styleMask:NSWindowStyleMaskNonactivatingPanel backing:NSBackingStoreBuffered defer:NO];
  panel.alphaValue = 0;
  panel.releasedWhenClosed = NO;
  panel.acceptsKeys = acceptsKeys;
  return panel;
}
static void Check(bool condition, const char *message) {
  if (!condition) { fprintf(stderr, "%s\n", message); exit(1); }
}
static void Update(NSWindow *window) {
  [NSNotificationCenter.defaultCenter postNotificationName:NSWindowDidUpdateNotification object:window];
}
int main() {
  @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    TestPanel *owner = Panel(YES), *candidate = Panel(NO), *dialog = Panel(YES), *foreign = Panel(NO);
    TestPanel *other = Panel(YES);
    owner.simulatedVisible = YES;
    owner.simulatedKey = YES;
    candidate.simulatedVisible = YES;
    dialog.simulatedVisible = YES;
    foreign.simulatedVisible = YES;
    [other addChildWindow:foreign ordered:NSWindowAbove];
    const auto originalBehavior = candidate.collectionBehavior;
    {
      AuxiliaryPanels tracker(owner);
      Update(candidate);
      Check(candidate.parentWindow == owner, "Candidate did not follow its focused editor");
      Check(!candidate.isKeyWindow && owner.isKeyWindow, "Candidate took keyboard focus");
      Check(dialog.parentWindow == nil, "Keyboard dialog was attached as an input panel");
      Check(foreign.parentWindow == other, "An existing parent was replaced");
      candidate.simulatedVisible = NO;
      Update(candidate);
      Check(candidate.parentWindow == nil, "Hidden candidate kept its parent");
      Check(candidate.collectionBehavior == originalBehavior, "Candidate Space policy was not restored");
      candidate.simulatedVisible = YES;
      Update(candidate);
      owner.simulatedKey = NO;
      Update(owner);
      Check(candidate.parentWindow == nil, "Candidate kept a former keyboard owner");
      owner.simulatedKey = YES;
      Update(owner);
      Check(candidate.parentWindow == owner, "Candidate did not follow its returning editor");
    }
    Check(candidate.parentWindow == nil, "Disposal left a child relationship");
    Update(candidate);
    Check(candidate.parentWindow == nil, "Observer survived disposal");
    int clicks = 0;
    owner.simulatedVisible = YES;
    {
      OutsideClicks monitor(owner, [&] { clicks++; });
      monitor.Handle(owner);
      [owner addChildWindow:candidate ordered:NSWindowAbove];
      monitor.Handle(candidate);
      Check(clicks == 0, "An editor or its input panel was treated as an outside click");
      [owner removeChildWindow:candidate];
      monitor.Handle(other);
      Check(clicks == 1, "Clicking another app window did not dismiss");
      monitor.Handle(nil);
      Check(clicks == 2, "Clicking another process did not dismiss");
      owner.simulatedVisible = NO;
      monitor.Handle(nil);
      Check(clicks == 2, "A hidden panel received outside clicks");
    }
    [other removeChildWindow:foreign];
    for (TestPanel *panel in @[owner, candidate, dialog, foreign, other]) {
      panel.simulatedKey = NO;
      panel.simulatedVisible = NO;
      [panel close];
    }
    puts("Auxiliary panel ownership, outside clicks and cleanup passed");
  }
}
