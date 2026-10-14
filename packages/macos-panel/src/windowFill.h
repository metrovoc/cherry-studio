#import <AppKit/AppKit.h>

static NSEvent *NormalizeWindowFill(NSWindow *owner, NSEvent *event) {
  if (!owner || event.window != owner ||
      (event.type != NSEventTypeLeftMouseDown && event.type != NSEventTypeLeftMouseUp) || event.clickCount != 2 ||
      (event.modifierFlags & NSEventModifierFlagControl) ||
      ![[NSUserDefaults.standardUserDefaults stringForKey:@"AppleActionOnDoubleClick"] isEqualToString:@"Fill"]) {
    return event;
  }
  NSView *content = owner.contentView;
  if (!content || !NSPointInRect([content convertPoint:event.locationInWindow fromView:nil], content.bounds)) return event;
  NSPoint contentHitPoint = [content.superview convertPoint:event.locationInWindow fromView:nil];
  if ([content hitTest:contentHitPoint]) return event;
  NSView *frame = content.superview;
  NSPoint frameHitPoint = frame.superview ? [frame.superview convertPoint:event.locationInWindow fromView:nil]
                                        : event.locationInWindow;
  for (NSView *hit = [frame hitTest:frameHitPoint]; hit; hit = hit.superview) {
    if ([hit isKindOfClass:NSControl.class]) return event;
  }
  // AppKit and Chromium's Fill handlers bypass the disabled zoom button.
  // Preserve mouse-down/up delivery so native dragging can still finish.
  return [NSEvent mouseEventWithType:event.type location:event.locationInWindow modifierFlags:event.modifierFlags
      timestamp:event.timestamp windowNumber:event.windowNumber context:nil eventNumber:event.eventNumber
      clickCount:1 pressure:event.pressure];
}

class WindowFill {
 public:
  explicit WindowFill(NSWindow *owner) {
    __weak NSWindow *weakOwner = owner;
    monitor_ = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskLeftMouseDown | NSEventMaskLeftMouseUp
        handler:^NSEvent *(NSEvent *event) { return NormalizeWindowFill(weakOwner, event); }];
  }

  ~WindowFill() {
    if (monitor_) [NSEvent removeMonitor:monitor_];
  }

 private:
  id monitor_;
};
