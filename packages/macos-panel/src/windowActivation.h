#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#include <unordered_map>

@interface PanelActivationState : NSObject
@property(weak) NSWindow *owner;
@property Class originalClass;
@property Class guardedClass;
@end
@implementation PanelActivationState
@end

static char panelActivationStateKey;

static bool PreventsActivation(NSView *view, NSEvent *event) {
  PanelActivationState *state = objc_getAssociatedObject(view, &panelActivationStateKey);
  return state.owner && view.window == state.owner && event.window == state.owner &&
      event.type == NSEventTypeLeftMouseDown;
}

static Class ActivationClass(Class original) {
  static std::unordered_map<Class, Class> classes;
  const auto found = classes.find(original);
  if (found != classes.end()) return found->second;

  NSString *name = [NSString stringWithFormat:@"CherryNonactivating_%s", class_getName(original)];
  Class guarded = objc_allocateClassPair(original, name.UTF8String, 0);
  SEL delay = @selector(shouldDelayWindowOrderingForEvent:), mouse = @selector(mouseDown:);
  Method delayMethod = class_getInstanceMethod(original, delay), mouseMethod = class_getInstanceMethod(original, mouse);
  const auto originalDelay = (BOOL (*)(id, SEL, NSEvent *))method_getImplementation(delayMethod);
  const auto originalMouse = (void (*)(id, SEL, NSEvent *))method_getImplementation(mouseMethod);
  class_addMethod(guarded, delay, imp_implementationWithBlock(^BOOL(NSView *view, NSEvent *event) {
    return PreventsActivation(view, event) ? YES : originalDelay(view, delay, event);
  }), method_getTypeEncoding(delayMethod));
  class_addMethod(guarded, mouse, imp_implementationWithBlock(^(NSView *view, NSEvent *event) {
    if (PreventsActivation(view, event)) [NSApp preventWindowOrdering];
    originalMouse(view, mouse, event);
  }), method_getTypeEncoding(mouseMethod));
  objc_registerClassPair(guarded);
  classes.emplace(original, guarded);
  return guarded;
}

class WindowActivation {
 public:
  explicit WindowActivation(NSWindow *owner) : owner_(owner) {
    views_ = [NSMapTable weakToStrongObjectsMapTable];
    monitor_ = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskLeftMouseDown
        handler:^NSEvent *(NSEvent *event) {
      Prepare(event);
      return event;
    }];
  }

  ~WindowActivation() {
    if (monitor_) [NSEvent removeMonitor:monitor_];
    for (NSView *view in views_.keyEnumerator.allObjects) {
      PanelActivationState *state = [views_ objectForKey:view];
      state.owner = nil;
      if (object_getClass(view) == state.guardedClass) object_setClass(view, state.originalClass);
      if (objc_getAssociatedObject(view, &panelActivationStateKey) == state) {
        objc_setAssociatedObject(view, &panelActivationStateKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
      }
    }
  }

  void Prepare(NSEvent *event) {
    NSWindow *owner = owner_;
    if (!owner || event.window != owner || event.type != NSEventTypeLeftMouseDown) return;
    NSView *root = owner.contentView.superview ?: owner.contentView;
    NSPoint point = root.superview ? [root.superview convertPoint:event.locationInWindow fromView:nil]
                                  : event.locationInWindow;
    NSView *view = [root hitTest:point];
    if (!view || objc_getAssociatedObject(view, &panelActivationStateKey)) return;
    PanelActivationState *state = [PanelActivationState new];
    state.owner = owner;
    state.originalClass = object_getClass(view);
    state.guardedClass = ActivationClass(state.originalClass);
    [views_ setObject:state forKey:view];
    objc_setAssociatedObject(view, &panelActivationStateKey, state, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    object_setClass(view, state.guardedClass);
  }

 private:
  __weak NSWindow *owner_;
  NSMapTable<NSView *, PanelActivationState *> *views_;
  id monitor_;
};
