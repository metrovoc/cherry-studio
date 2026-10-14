#import <AppKit/AppKit.h>

static const char *PreventPanelActivation(NSWindow *window) {
  if (!window || window.isVisible || !(window.styleMask & NSWindowStyleMaskNonactivatingPanel)) {
    return "Expected a fresh hidden nonactivating panel";
  }
  if (@available(macOS 27.0, *)) {
    // Electron's panel style getter does not initialize AppKit's activation state on macOS 27.
    // Match electron/electron#54807 before the panel's first show.
    SEL setter = NSSelectorFromString(@"_setPreventsActivation:");
    if (![window respondsToSelector:setter]) return "AppKit panel activation prevention is unavailable";
    const auto invoke = (void (*)(id, SEL, BOOL))[window methodForSelector:setter];
    invoke(window, setter, YES);
  }
  return nullptr;
}
