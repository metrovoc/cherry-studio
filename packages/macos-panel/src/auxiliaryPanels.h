#import <AppKit/AppKit.h>

class AuxiliaryPanels {
 public:
  explicit AuxiliaryPanels(NSWindow *owner) : owner_(owner) {
    attached_ = [NSMapTable weakToStrongObjectsMapTable];
    NSMutableArray *observers = [NSMutableArray array];
    for (NSNotificationName name in @[NSWindowDidUpdateNotification,
                                      NSWindowDidChangeOcclusionStateNotification,
                                      NSWindowDidResignKeyNotification]) {
      [observers addObject:[NSNotificationCenter.defaultCenter
          addObserverForName:name object:nil queue:nil
          usingBlock:^(NSNotification *) { Reconcile(); }]];
    }
    observers_ = observers;
  }

  ~AuxiliaryPanels() {
    for (id observer in observers_) [NSNotificationCenter.defaultCenter removeObserver:observer];
    for (NSWindow *panel in attached_.keyEnumerator.allObjects) Detach(panel);
  }

 private:
  void Detach(NSWindow *panel) {
    if (panel.parentWindow == owner_) {
      [owner_ removeChildWindow:panel];
      panel.collectionBehavior = [[attached_ objectForKey:panel] unsignedIntegerValue];
    }
    [attached_ removeObjectForKey:panel];
  }

  void Reconcile() {
    if (updating_) return;
    updating_ = true;
    NSWindow *owner = owner_;
    for (NSWindow *panel in attached_.keyEnumerator.allObjects) {
      if (!owner.isKeyWindow || !owner.isVisible || !panel.isVisible) Detach(panel);
    }
    if (owner.isKeyWindow && owner.isVisible) {
      for (NSWindow *panel in NSApp.windows) {
        if (panel == owner || ![panel isKindOfClass:NSPanel.class] ||
            panel.canBecomeKeyWindow || !panel.isVisible || panel.parentWindow) continue;
        // Native input panels must inherit their editor's Space rather than the app's main window's Space.
        [attached_ setObject:@(panel.collectionBehavior) forKey:panel];
        [owner addChildWindow:panel ordered:NSWindowAbove];
      }
    }
    updating_ = false;
  }

  __weak NSWindow *owner_;
  NSMapTable<NSWindow *, NSNumber *> *attached_;
  NSArray *observers_;
  bool updating_ = false;
};
