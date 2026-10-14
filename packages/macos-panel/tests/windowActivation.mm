#import "../src/windowActivation.h"
#include <dlfcn.h>
#include <cstdio>
#include <cstdlib>

@interface ActivationTestPanel : NSWindow
@end
@implementation ActivationTestPanel
- (NSWindowStyleMask)styleMask { return [super styleMask] | NSWindowStyleMaskNonactivatingPanel; }
@end

static void Check(bool condition, const char *message) {
  if (!condition) { fprintf(stderr, "%s\n", message); exit(1); }
}

static NSWindow *Window(Class type) {
  NSWindow *window = [[type alloc] initWithContentRect:NSMakeRect(-20000, -20000, 300, 100)
      styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
  window.releasedWhenClosed = NO;
  return window;
}

static bool PreventsActivation(NSWindow *window) {
  using Connection = int32_t (*)(void);
  using GetTags = int32_t (*)(int32_t, uint32_t, uint64_t *, int32_t);
  const auto connection = (Connection)dlsym(RTLD_DEFAULT, "CGSMainConnectionID");
  const auto getTags = (GetTags)dlsym(RTLD_DEFAULT, "CGSGetWindowTags");
  Check(connection && getTags, "WindowServer readback is unavailable");
  uint64_t tags = 0;
  Check(getTags(connection(), (uint32_t)window.windowNumber, &tags, 64) == 0, "WindowServer readback failed");
  return (tags & (1ull << 16)) != 0;
}

int main() {
  @autoreleasepool {
    NSApplication *app = [NSApplication sharedApplication];
    [app setActivationPolicy:NSApplicationActivationPolicyProhibited];
    Check(app.activationPolicy == NSApplicationActivationPolicyProhibited, "Test requires prohibited activation");
    NSWindow *owner = Window(ActivationTestPanel.class), *other = Window(ActivationTestPanel.class);
    NSWindow *regular = Window(NSWindow.class);
    Check(PreventPanelActivation(nil) != nullptr, "A missing window was accepted");
    Check(PreventPanelActivation(regular) != nullptr, "A regular window was accepted");
    const NSWindowStyleMask style = owner.styleMask;
    const NSWindowCollectionBehavior collection = owner.collectionBehavior;
    const bool ownerPrevention = PreventsActivation(owner);
    const bool otherPrevention = PreventsActivation(other);
    if (@available(macOS 27.0, *)) {
      Check(!ownerPrevention, "The fixture must reproduce the missing native activation prevention");
    }
    Check(PreventPanelActivation(owner) == nullptr, "Fresh panel activation initialization failed");
    if (@available(macOS 27.0, *)) {
      const NSTimeInterval deadline = NSProcessInfo.processInfo.systemUptime + 1;
      while (!PreventsActivation(owner) && NSProcessInfo.processInfo.systemUptime < deadline) {
        [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
      }
      Check(PreventsActivation(owner), "The panel style getter did not establish native activation prevention");
    } else {
      Check(PreventsActivation(owner) == ownerPrevention, "An older macOS version was changed");
    }
    Check(PreventsActivation(other) == otherPrevention, "Initialization changed another panel");
    Check(owner.styleMask == style && owner.collectionBehavior == collection, "Initialization changed window behavior");
    Check(!owner.isVisible && !other.isVisible && !regular.isVisible && !app.isActive,
        "Hidden tests changed visibility or activation");
    [owner close];
    [other close];
    [regular close];
    puts("Fresh panel native activation prevention and window scope passed");
  }
}
