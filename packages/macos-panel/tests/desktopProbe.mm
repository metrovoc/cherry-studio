#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <ImageIO/ImageIO.h>
#include <vector>

static void Print(id value) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingPrettyPrinted error:nil];
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
}

static id Attribute(AXUIElementRef element, CFStringRef key) {
  CFTypeRef value = nullptr;
  return AXUIElementCopyAttributeValue(element, key, &value) == kAXErrorSuccess ? CFBridgingRelease(value) : nil;
}

static NSDictionary *Tree(AXUIElementRef element, int depth) {
  NSMutableDictionary *result = [NSMutableDictionary new];
  for (NSString *key in @[@"AXRole", @"AXTitle", @"AXDescription", @"AXIdentifier", @"AXValue", @"AXEnabled"]) {
    id value = Attribute(element, (__bridge CFStringRef)key);
    if ([value isKindOfClass:NSString.class] || [value isKindOfClass:NSNumber.class]) result[key] = value;
  }
  NSMutableArray *children = [NSMutableArray new];
  if (depth > 0) for (id child in Attribute(element, kAXChildrenAttribute)) {
    [children addObject:Tree((__bridge AXUIElementRef)child, depth - 1)];
  }
  result[@"children"] = children;
  return result;
}

static bool Press(AXUIElementRef element, NSString *query) {
  for (NSString *key in @[@"AXTitle", @"AXDescription", @"AXIdentifier"]) {
    id value = Attribute(element, (__bridge CFStringRef)key);
    if ([value isKindOfClass:NSString.class] && [value localizedCaseInsensitiveContainsString:query] &&
        AXUIElementPerformAction(element, kAXPressAction) == kAXErrorSuccess) return true;
  }
  for (id child in Attribute(element, kAXChildrenAttribute)) {
    if (Press((__bridge AXUIElementRef)child, query)) return true;
  }
  return false;
}

static void Mouse(CGEventType type, CGPoint point, int count = 1) {
  CGEventRef event = CGEventCreateMouseEvent(nullptr, type, point, kCGMouseButtonLeft);
  CGEventSetIntegerValueField(event, kCGMouseEventClickState, count);
  CGEventPost(kCGHIDEventTap, event);
  CFRelease(event);
  usleep(100000);
}

int main(int argc, const char **argv) {
  @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    if (argc < 2) return 2;
    NSString *command = @(argv[1]);
    if ([command isEqualToString:@"capabilities"]) {
      NSArray *screens = [NSScreen.screens valueForKey:@"deviceDescription"];
      CFDictionaryRef session = CGSessionCopyCurrentDictionary();
      Print(@{@"session": session ? CFBridgingRelease(session) : @{},
              @"screenCount": @(screens.count), @"accessibility": @(AXIsProcessTrusted()),
              @"postEvents": @(CGPreflightPostEventAccess()),
              @"screenCapture": @(CGPreflightScreenCaptureAccess()),
              @"frontmostPid": @(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier),
              @"os": NSProcessInfo.processInfo.operatingSystemVersionString});
      return screens.count ? 0 : 3;
    }
    if ([command isEqualToString:@"application"] && argc == 3) {
      NSRunningApplication *target = [NSRunningApplication runningApplicationWithProcessIdentifier:atoi(argv[2])];
      if (!target) return 6;
      Print(@{@"pid": @(target.processIdentifier), @"activationPolicy": @(target.activationPolicy),
              @"active": @(target.active), @"terminated": @(target.terminated)});
      return 0;
    }
    if ([command isEqualToString:@"snapshot"]) {
      NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionAll, kCGNullWindowID));
      Print(@{@"uptime": @(NSProcessInfo.processInfo.systemUptime),
              @"frontmostPid": @(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier),
              @"windows": windows ?: @[]});
      return 0;
    }
    if ([command isEqualToString:@"image-metrics"] && argc == 3) {
      CGImageSourceRef source = CGImageSourceCreateWithURL((__bridge CFURLRef)[NSURL fileURLWithPath:@(argv[2])], nullptr);
      if (!source) return 8;
      CGImageRef image = CGImageSourceCreateImageAtIndex(source, 0, nullptr);
      size_t width = CGImageGetWidth(image), height = CGImageGetHeight(image);
      std::vector<uint8_t> pixels(width * height * 4);
      CGColorSpaceRef colors = CGColorSpaceCreateDeviceRGB();
      CGContextRef context = CGBitmapContextCreate(pixels.data(), width, height, 8, width * 4, colors,
          kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
      CGContextDrawImage(context, CGRectMake(0, 0, width, height), image);
      size_t count = 0, minX = width, maxX = 0, minY = height, maxY = 0;
      for (size_t y = 100; y + 100 < height; ++y) for (size_t x = 0; x < width; ++x) {
        const uint8_t *pixel = pixels.data() + (y * width + x) * 4;
        if (pixel[0] > 170 && pixel[1] < 100 && pixel[2] > 30 && pixel[2] < 150) {
          ++count; minX = MIN(minX, x); maxX = MAX(maxX, x); minY = MIN(minY, y); maxY = MAX(maxY, y);
        }
      }
      Print(@{@"count": @(count), @"minX": @(minX), @"maxX": @(maxX), @"minY": @(minY),
              @"maxY": @(maxY), @"width": @(width), @"height": @(height)});
      CGContextRelease(context); CGColorSpaceRelease(colors); CGImageRelease(image); CFRelease(source);
      return 0;
    }
    if (![@"true" isEqualToString:NSProcessInfo.processInfo.environment[@"GITHUB_ACTIONS"]]) return 78;
    if ([command isEqualToString:@"ax-press-all"] && argc == 3) {
      for (NSRunningApplication *target in NSWorkspace.sharedWorkspace.runningApplications) {
        AXUIElementRef element = AXUIElementCreateApplication(target.processIdentifier);
        bool success = Press(element, @(argv[2]));
        CFRelease(element);
        if (success) { Print(@{@"bundle": target.bundleIdentifier ?: @"", @"pid": @(target.processIdentifier)}); return 0; }
      }
      return 7;
    }
    if ([command isEqualToString:@"ax-tree-all"]) {
      NSMutableArray *trees = [NSMutableArray new];
      for (NSRunningApplication *target in NSWorkspace.sharedWorkspace.runningApplications) {
        AXUIElementRef element = AXUIElementCreateApplication(target.processIdentifier);
        [trees addObject:@{@"bundle": target.bundleIdentifier ?: @"", @"pid": @(target.processIdentifier),
            @"tree": Tree(element, 12)}];
        CFRelease(element);
      }
      Print(trees);
      return 0;
    }
    if (([command isEqualToString:@"ax-tree"] || [command isEqualToString:@"ax-press"]) && argc >= 3) {
      NSRunningApplication *target = [NSRunningApplication runningApplicationsWithBundleIdentifier:@(argv[2])].firstObject;
      if (!target) return 6;
      AXUIElementRef element = AXUIElementCreateApplication(target.processIdentifier);
      bool success = true;
      if ([command isEqualToString:@"ax-tree"]) Print(Tree(element, 12));
      else success = argc == 4 && Press(element, @(argv[3]));
      CFRelease(element);
      return success ? 0 : 7;
    }
    if ([command isEqualToString:@"activate"] && argc == 3) {
      NSRunningApplication *target = [NSRunningApplication runningApplicationWithProcessIdentifier:atoi(argv[2])];
      return [target activateWithOptions:0] ? 0 : 4;
    }
    if ([command isEqualToString:@"type"] && argc == 3) {
      if (!CGPreflightPostEventAccess()) return 5;
      NSString *text = @(argv[2]);
      if (!text.length || text.length > 20) return 2;
      std::vector<UniChar> characters(text.length);
      [text getCharacters:characters.data() range:NSMakeRange(0, text.length)];
      for (bool down : {true, false}) {
        CGEventRef event = CGEventCreateKeyboardEvent(nullptr, 0, down);
        CGEventKeyboardSetUnicodeString(event, characters.size(), characters.data());
        CGEventPost(kCGHIDEventTap, event);
        CFRelease(event);
        usleep(100000);
      }
      return 0;
    }
    if (([command isEqualToString:@"click"] || [command isEqualToString:@"drag"]) && argc >= 4) {
      if (!CGPreflightPostEventAccess()) return 5;
      CGPoint start = CGPointMake(atof(argv[2]), atof(argv[3]));
      Mouse(kCGEventMouseMoved, start);
      if ([command isEqualToString:@"drag"] && argc == 6) {
        Mouse(kCGEventLeftMouseDown, start);
        for (int index = 1; index <= 10; ++index) {
          Mouse(kCGEventLeftMouseDragged, CGPointMake(start.x + atof(argv[4]) * index / 10,
                                                    start.y + atof(argv[5]) * index / 10));
        }
        Mouse(kCGEventLeftMouseUp, CGPointMake(start.x + atof(argv[4]), start.y + atof(argv[5])));
      } else {
        int clicks = argc == 5 ? atoi(argv[4]) : 1;
        for (int index = 1; index <= clicks; ++index) {
          Mouse(kCGEventLeftMouseDown, start, index);
          Mouse(kCGEventLeftMouseUp, start, index);
        }
      }
      return 0;
    }
    if ([command isEqualToString:@"source"] && argc == 3) {
      [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
      NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(220, 140, 640, 440)
          styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskResizable
          backing:NSBackingStoreBuffered defer:NO];
      window.title = @"External Source";
      NSTextField *text = [NSTextField labelWithString:@"External source for the assistant desktop probe"];
      text.frame = NSMakeRect(30, 200, 570, 50);
      [window.contentView addSubview:text];
      [window makeKeyAndOrderFront:nil];
      [NSApp activateIgnoringOtherApps:YES];
      [@{ @"pid": @(getpid()), @"windowNumber": @(window.windowNumber) } writeToFile:@(argv[2]) atomically:YES];
      [NSTimer scheduledTimerWithTimeInterval:180 repeats:NO block:^(NSTimer *) { [NSApp terminate:nil]; }];
      [NSApp run];
      return 0;
    }
    return 2;
  }
}
