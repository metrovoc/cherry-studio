#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>

static void Print(id value) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingPrettyPrinted error:nil];
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
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
    if ([command isEqualToString:@"snapshot"]) {
      NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionAll, kCGNullWindowID));
      Print(@{@"uptime": @(NSProcessInfo.processInfo.systemUptime),
              @"frontmostPid": @(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier),
              @"windows": windows ?: @[]});
      return 0;
    }
    return 2;
  }
}
