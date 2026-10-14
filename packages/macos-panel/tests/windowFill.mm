#import "../src/windowFill.h"
#include <cstdio>
#include <cstdlib>
#include <memory>

@interface FillTestContent : NSView
@end
@implementation FillTestContent
- (NSView *)hitTest:(NSPoint)point {
  NSView *hit = [super hitTest:point];
  if (hit != self) return hit;
  NSPoint local = [self convertPoint:point fromView:self.superview];
  if (NSPointInRect(local, NSMakeRect(8, NSHeight(self.bounds) - 60, NSWidth(self.bounds) - 16, 52))) return nil;
  return hit;
}
@end

@interface FillTestWindow : NSWindow
@property(strong) NSEvent *delivered;
@property NSUInteger deliveries;
@end
@implementation FillTestWindow
- (void)sendEvent:(NSEvent *)event { self.delivered = event; self.deliveries++; }
@end

static void Check(bool condition, const char *message) {
  if (!condition) { fprintf(stderr, "%s\n", message); exit(1); }
}

static FillTestWindow *Window() {
  FillTestWindow *window = [[FillTestWindow alloc] initWithContentRect:NSMakeRect(-20000, -20000, 300, 200)
      styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskResizable | NSWindowStyleMaskFullSizeContentView
      backing:NSBackingStoreBuffered defer:NO];
  window.releasedWhenClosed = NO;
  window.contentView = [[FillTestContent alloc] initWithFrame:window.contentView.frame];
  return window;
}

static NSEvent *Mouse(FillTestWindow *window, NSPoint point, NSEventType type = NSEventTypeLeftMouseUp,
    NSInteger count = 2, NSEventModifierFlags flags = NSEventModifierFlagShift) {
  return [NSEvent mouseEventWithType:type location:point modifierFlags:flags timestamp:42.25
      windowNumber:window.windowNumber context:nil eventNumber:19 clickCount:count pressure:0.75];
}

static NSEvent *Deliver(FillTestWindow *window, NSEvent *event) {
  NSUInteger before = window.deliveries;
  [NSApp sendEvent:event];
  Check(window.deliveries == before + 1, "The mouse event was swallowed or delivered twice");
  return window.delivered;
}

static void CheckNormalized(FillTestWindow *window, NSEvent *event) {
  NSEvent *result = Deliver(window, event);
  Check(result.clickCount == 1, "Title-bar Fill still received a double click");
  Check(result.type == event.type && NSEqualPoints(result.locationInWindow, event.locationInWindow) &&
      result.modifierFlags == event.modifierFlags && result.timestamp == event.timestamp &&
      result.window == event.window && result.windowNumber == event.windowNumber &&
      result.eventNumber == event.eventNumber && result.pressure == event.pressure,
      "Normalization lost mouse delivery metadata");
}

static void CheckUnchanged(FillTestWindow *window, NSEvent *event, const char *reason) {
  Check(Deliver(window, event) == event, reason);
}

int main() {
  @autoreleasepool {
    NSApplication *app = NSApplication.sharedApplication;
    [app setActivationPolicy:NSApplicationActivationPolicyProhibited];
    Check(app.activationPolicy == NSApplicationActivationPolicyProhibited, "Test requires prohibited activation");
    NSUserDefaults *defaults = NSUserDefaults.standardUserDefaults;
    NSDictionary *arguments = [defaults volatileDomainForName:NSArgumentDomain];
    NSMutableDictionary *settings = arguments.mutableCopy;
    settings[@"AppleActionOnDoubleClick"] = @"Fill";
    [defaults setVolatileDomain:settings forName:NSArgumentDomain];

    FillTestWindow *owner = Window(), *other = Window();
    NSPoint nativeTitle = NSMakePoint(100, NSMaxY(owner.contentView.frame) - 14);
    NSPoint customTitle = NSMakePoint(100, NSMaxY(owner.contentLayoutRect) - 20);
    Check(!NSPointInRect(nativeTitle, owner.contentLayoutRect), "Native title-bar fixture is outside its region");
    Check(NSPointInRect(customTitle, owner.contentLayoutRect), "Custom title-bar fixture is outside its region");
    auto guard = std::make_unique<WindowFill>(owner);
    for (NSEventType type : {NSEventTypeLeftMouseDown, NSEventTypeLeftMouseUp}) {
      CheckNormalized(owner, Mouse(owner, nativeTitle, type));
      CheckNormalized(owner, Mouse(owner, customTitle, type));
      CheckUnchanged(other, Mouse(other, nativeTitle, type), "Another window's Fill action changed");
      CheckUnchanged(owner, Mouse(owner, NSMakePoint(100, 70), type), "Content double-click changed");
      CheckUnchanged(owner, Mouse(owner, NSMakePoint(1, 190), type), "Resize-edge double-click changed");
      CheckUnchanged(owner, Mouse(owner, NSMakePoint(-1, 190), type), "Outside-frame double-click changed");
      CheckUnchanged(owner, Mouse(owner, nativeTitle, type, 1), "Ordinary dragging changed");
      CheckUnchanged(owner, Mouse(owner, NSMakePoint(1, 190), type, 1), "Ordinary resizing changed");
      CheckUnchanged(owner, Mouse(owner, nativeTitle, type, 2, NSEventModifierFlagControl),
          "Control-click context-menu handling changed");
    }
    CheckUnchanged(owner, Mouse(owner, nativeTitle, NSEventTypeLeftMouseDragged, 1), "Drag movement changed");
    CheckUnchanged(owner, Mouse(owner, nativeTitle, NSEventTypeRightMouseUp), "Right-click handling changed");

    NSView *contentButton = [[NSView alloc] initWithFrame:NSMakeRect(customTitle.x - 8, customTitle.y - 8, 16, 16)];
    [owner.contentView addSubview:contentButton];
    CheckUnchanged(owner, Mouse(owner, customTitle, NSEventTypeLeftMouseDown), "No-drag content press changed");
    CheckUnchanged(owner, Mouse(owner, customTitle), "No-drag content release changed");
    [contentButton removeFromSuperview];
    NSButton *button = [[NSButton alloc] initWithFrame:NSMakeRect(nativeTitle.x - 8, nativeTitle.y - 8, 16, 16)];
    [owner.contentView.superview addSubview:button positioned:NSWindowAbove relativeTo:nil];
    CheckUnchanged(owner, Mouse(owner, nativeTitle, NSEventTypeLeftMouseDown), "Native button press changed");
    CheckUnchanged(owner, Mouse(owner, nativeTitle), "Native button release changed");
    [button removeFromSuperview];
    for (NSString *action in @[@"Minimize", @"Maximize", @"None"]) {
      settings[@"AppleActionOnDoubleClick"] = action;
      [defaults setVolatileDomain:settings forName:NSArgumentDomain];
      CheckUnchanged(owner, Mouse(owner, nativeTitle, NSEventTypeLeftMouseDown), "Another double-click action changed");
      CheckUnchanged(owner, Mouse(owner, nativeTitle), "Another double-click action changed");
    }
    settings[@"AppleActionOnDoubleClick"] = @"Fill";
    [defaults setVolatileDomain:settings forName:NSArgumentDomain];
    owner.contentView = [[FillTestContent alloc] initWithFrame:owner.contentView.frame];
    CheckNormalized(owner, Mouse(owner, nativeTitle));
    guard.reset();
    CheckUnchanged(owner, Mouse(owner, nativeTitle), "Disposal left the Fill monitor installed");
    guard.reset();

    __weak NSWindow *releasedOwner;
    @autoreleasepool {
      FillTestWindow *temporary = Window();
      releasedOwner = temporary;
      guard = std::make_unique<WindowFill>(temporary);
      [temporary close];
    }
    Check(releasedOwner == nil, "The Fill monitor retained its owner window");
    CheckUnchanged(owner, Mouse(owner, nativeTitle), "An expired owner changed another window's event");
    guard.reset();
    [defaults setVolatileDomain:arguments forName:NSArgumentDomain];
    Check(!owner.isVisible && !other.isVisible && !app.isActive, "Hidden tests changed visibility or activation");
    [owner close];
    [other close];
    puts("Window-scoped Fill prevention, mouse delivery, and cleanup passed");
  }
}
