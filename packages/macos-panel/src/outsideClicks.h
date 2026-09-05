#import <AppKit/AppKit.h>
#include <functional>

class OutsideClicks {
 public:
  OutsideClicks(NSWindow *owner, std::function<void()> callback) : owner_(owner), callback_(callback) {
    const auto mask = NSEventMaskLeftMouseDown | NSEventMaskRightMouseDown | NSEventMaskOtherMouseDown;
    local_ = [NSEvent addLocalMonitorForEventsMatchingMask:mask handler:^NSEvent *(NSEvent *event) {
      Handle(event.window);
      return event;
    }];
    global_ = [NSEvent addGlobalMonitorForEventsMatchingMask:mask handler:^(NSEvent *) { Handle(nil); }];
  }

  ~OutsideClicks() {
    if (local_) [NSEvent removeMonitor:local_];
    if (global_) [NSEvent removeMonitor:global_];
  }

  void Handle(NSWindow *target) {
    NSWindow *owner = owner_;
    if (!owner || !owner.isVisible) return;
    for (NSWindow *window = target; window; window = window.parentWindow) {
      if (window == owner) return;
    }
    callback_();
  }

 private:
  __weak NSWindow *owner_;
  std::function<void()> callback_;
  id local_;
  id global_;
};
