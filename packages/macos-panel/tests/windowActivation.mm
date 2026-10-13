#import "../src/windowActivation.h"
#include <cstdio>
#include <cstdlib>

@interface ActivationTestApplication : NSApplication
@property NSUInteger prevented;
@end
@implementation ActivationTestApplication
- (void)preventWindowOrdering { self.prevented++; [super preventWindowOrdering]; }
@end

@interface ActivationTestView : NSView
@property NSUInteger clicks;
@property(strong) NSEvent *lastEvent;
@end
@implementation ActivationTestView
- (BOOL)acceptsFirstMouse:(NSEvent *)event { return YES; }
- (BOOL)shouldDelayWindowOrderingForEvent:(NSEvent *)event { return NO; }
- (void)mouseDown:(NSEvent *)event { self.clicks++; self.lastEvent = event; }
@end

@interface ActivationChildView : ActivationTestView
@end
@implementation ActivationChildView
- (void)mouseDown:(NSEvent *)event { [super mouseDown:event]; }
@end

@interface ActivationDragContent : NSView
@end
@implementation ActivationDragContent
- (NSView *)hitTest:(NSPoint)point { return nil; }
@end

static void Check(bool condition, const char *message) {
  if (!condition) { fprintf(stderr, "%s\n", message); exit(1); }
}

static NSWindow *Window() {
  NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(-20000, -20000, 300, 100)
      styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
  window.releasedWhenClosed = NO;
  return window;
}

static NSEvent *Click(NSWindow *window, NSEventType type = NSEventTypeLeftMouseDown) {
  return [NSEvent mouseEventWithType:type location:NSMakePoint(45, 25) modifierFlags:0
      timestamp:0 windowNumber:window.windowNumber context:nil eventNumber:1 clickCount:1 pressure:1];
}

int main() {
  @autoreleasepool {
    ActivationTestApplication *app = [ActivationTestApplication sharedApplication];
    [app setActivationPolicy:NSApplicationActivationPolicyProhibited];
    Check(app.activationPolicy == NSApplicationActivationPolicyProhibited, "Test requires prohibited activation");
    NSWindow *owner = Window(), *other = Window();
    ActivationTestView *original = [[ActivationTestView alloc] initWithFrame:NSMakeRect(20, 10, 100, 50)];
    ActivationTestView *unrelated = [[ActivationTestView alloc] initWithFrame:original.frame];
    [other.contentView addSubview:unrelated];
    ActivationChildView *replacement = [[ActivationChildView alloc] initWithFrame:original.frame];
    NSEvent *click = Click(owner), *outside = Click(other);
    {
      WindowActivation guard(owner);
      [owner.contentView addSubview:original];
      guard.Prepare(outside);
      Check(object_getClass(unrelated) == ActivationTestView.class, "Another window was modified");
      guard.Prepare(Click(owner, NSEventTypeRightMouseDown));
      Check(object_getClass(original) == ActivationTestView.class, "A non-left click changed the view");
      guard.Prepare(click);
      Check([original shouldDelayWindowOrderingForEvent:click], "Owned click could activate before delivery");
      [original mouseDown:click];
      Check(original.clicks == 1 && original.lastEvent == click && app.prevented == 1,
          "Activation prevention lost or changed the original click");
      Check(![unrelated shouldDelayWindowOrderingForEvent:outside], "Unrelated view's activation was changed");
      [unrelated mouseDown:outside];
      Check(unrelated.clicks == 1 && app.prevented == 1, "An unrelated click was suppressed");

      [original removeFromSuperview];
      [other.contentView addSubview:original];
      Check(![original shouldDelayWindowOrderingForEvent:outside], "A moved view kept its old owner's policy");
      [original mouseDown:outside];
      Check(original.clicks == 2 && app.prevented == 1, "Moving a view changed its click behavior");
      [owner.contentView addSubview:replacement];
      guard.Prepare(click);
      [replacement mouseDown:click];
      Check(replacement.clicks == 1 && app.prevented == 2, "Replacement renderer lost activation prevention");
    }
    Check(object_getClass(original) == ActivationTestView.class &&
          object_getClass(replacement) == ActivationChildView.class, "Disposal did not restore view classes");
    Check(![replacement shouldDelayWindowOrderingForEvent:click], "Disposal left activation prevention enabled");
    [replacement mouseDown:click];
    Check(replacement.clicks == 2 && app.prevented == 2, "Disposal changed click delivery");

    Class laterClass;
    {
      WindowActivation guard(owner);
      guard.Prepare(click);
      laterClass = objc_allocateClassPair(object_getClass(replacement), "LaterActivationTestSubclass", 0);
      objc_registerClassPair(laterClass);
      object_setClass(replacement, laterClass);
    }
    Check(object_getClass(replacement) == laterClass, "Disposal overwrote a later view subclass");
    Check(![replacement shouldDelayWindowOrderingForEvent:click], "A retained subclass kept an inactive guard");
    [replacement mouseDown:click];
    Check(replacement.clicks == 3 && app.prevented == 2, "A retained subclass stopped forwarding clicks");
    object_setClass(replacement, ActivationChildView.class);
    objc_disposeClassPair(laterClass);

    NSWindow *dragOwner = Window();
    dragOwner.contentView = [[ActivationDragContent alloc] initWithFrame:NSMakeRect(0, 0, 300, 100)];
    NSView *frame = dragOwner.contentView.superview;
    Class frameClass = object_getClass(frame);
    Class testFrameClass = objc_allocateClassPair(frameClass, "ActivationTestFrame", 0);
    __block NSUInteger frameClicks = 0;
    __block NSEvent *frameEvent = nil;
    SEL mouseDown = @selector(mouseDown:);
    class_addMethod(testFrameClass, mouseDown, imp_implementationWithBlock(^(NSView *, NSEvent *event) {
      frameClicks++;
      frameEvent = event;
    }), method_getTypeEncoding(class_getInstanceMethod(frameClass, mouseDown)));
    objc_registerClassPair(testFrameClass);
    object_setClass(frame, testFrameClass);
    NSEvent *drag = Click(dragOwner);
    const NSUInteger preventedBeforeDrag = app.prevented;
    {
      WindowActivation guard(dragOwner);
      guard.Prepare(drag);
      Check([frame shouldDelayWindowOrderingForEvent:drag], "A draggable region bypassed activation prevention");
      [frame mouseDown:drag];
      Check(frameClicks == 1 && frameEvent == drag && app.prevented == preventedBeforeDrag + 1,
          "Activation prevention lost, duplicated or changed the frame drag event");
    }
    Check(object_getClass(frame) == testFrameClass, "Disposal did not restore the frame class");
    object_setClass(frame, frameClass);
    Check(!owner.isVisible && !other.isVisible && !dragOwner.isVisible && !app.isActive,
        "Hidden tests changed visibility or activation");
    [owner close];
    [other close];
    [dragOwner close];
    puts("Window activation scope, click delivery, renderer replacement and cleanup passed");
  }
}
