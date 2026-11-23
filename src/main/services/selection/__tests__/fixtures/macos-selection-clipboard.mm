#import <ApplicationServices/ApplicationServices.h>
#import <Cocoa/Cocoa.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

#include "core/engine.h"
#include "lib/clipboard.h"
#include "lib/utils.h"

@interface FakeRunningApplication : NSObject
@property(nonatomic) pid_t processIdentifier;
@end

@implementation FakeRunningApplication
@end

namespace
{
CFTypeRef gRangeRef = nullptr;
CFTypeRef gRangeText = nullptr;
CFTypeRef gMarkerText = nullptr;
AXTextMarkerRangeRef gMarkers = nullptr;
bool gSpansElements = false;
bool gHasFocusedElement = true;

int64_t gSequence = 10;
bool gClipboardEmpty = false;
bool gBackupSucceeds = true;
bool gCopyChangesClipboard = true;
bool gConcurrentChangeDuringBackup = false;
bool gConcurrentChangeDuringRead = false;
std::string gClipboardText = "prior clipboard";
std::string gCopiedText = "complete copied paragraph.";

int gSendCopyCalls = 0;
int gRestoreCalls = 0;
int gClearLocalCalls = 0;

void resetState()
{
    gRangeText = nullptr;
    gMarkerText = nullptr;
    gSpansElements = false;
    gHasFocusedElement = true;
    gSequence = 10;
    gClipboardEmpty = false;
    gBackupSucceeds = true;
    gCopyChangesClipboard = true;
    gConcurrentChangeDuringBackup = false;
    gConcurrentChangeDuringRead = false;
    gClipboardText = "prior clipboard";
    gCopiedText = "complete copied paragraph.";
    gSendCopyCalls = 0;
    gRestoreCalls = 0;
    gClearLocalCalls = 0;
}

void require(const char *scenario, bool condition)
{
    if (!condition)
    {
        fprintf(stderr, "FAILED: %s\n", scenario);
        exit(1);
    }
}
}  // namespace

// Stubs for utils.h (only symbols referenced by core/engine.mm)
bool IsTrimmedEmpty(const std::string &text)
{
    return text.find_first_not_of(" \t\r\n") == std::string::npos;
}

AXUIElementRef GetAppElementFromFrontApp(NSRunningApplication *)
{
    return reinterpret_cast<AXUIElementRef>(const_cast<void *>(CFRetain(CFSTR("app"))));
}

AXUIElementRef GetFocusedElementFromAppElement(AXUIElementRef)
{
    if (!gHasFocusedElement)
        return nullptr;
    return reinterpret_cast<AXUIElementRef>(const_cast<void *>(CFRetain(CFSTR("focused"))));
}

AXUIElementRef GetFrontWindowElementFromAppElement(AXUIElementRef)
{
    return nullptr;
}

bool GetProgramNameFromFrontApp(NSRunningApplication *, std::string &programName)
{
    programName = "com.google.Chrome";
    return true;
}

bool IsWindowFullscreen(NSRunningApplication *)
{
    return false;
}

// Stubs for clipboard.h
bool ReadClipboard(std::string &content)
{
    content = gClipboardText;
    if (gConcurrentChangeDuringRead)
    {
        gSequence++;
        gClipboardText = "concurrent user copy";
    }
    return !content.empty();
}

int64_t GetClipboardSequence()
{
    return gSequence;
}

bool IsClipboardEmpty()
{
    return gClipboardEmpty;
}

ClipboardBackup BackupClipboard()
{
    if (gConcurrentChangeDuringBackup)
        gSequence++;
    ClipboardBackup backup;
    if (!gClipboardEmpty && gBackupSucceeds)
    {
        ClipboardItemData item;
        const auto *bytes = reinterpret_cast<const uint8_t *>(gClipboardText.data());
        item.representations.push_back({"public.utf8-plain-text", {bytes, bytes + gClipboardText.size()}});
        backup.items.push_back(std::move(item));
        backup.valid = true;
    }
    return backup;
}

bool RestoreClipboard(const ClipboardBackup &backup)
{
    gRestoreCalls++;
    gSequence++;
    if (backup.HasData() && !backup.items[0].representations.empty())
    {
        const auto &data = backup.items[0].representations[0].second;
        gClipboardText.assign(reinterpret_cast<const char *>(data.data()), data.size());
        gClipboardEmpty = false;
    }
    return true;
}

void ClearClipboardLocal()
{
    gClearLocalCalls++;
    gSequence++;
    gClipboardText.clear();
    gClipboardEmpty = true;
}

// Stubs for AX and CGEvent APIs
AXError AXUIElementCopyAttributeValue(AXUIElementRef, CFStringRef attribute, CFTypeRef *result)
{
    *result = nullptr;
    if (CFEqual(attribute, kAXSelectedTextRangeAttribute))
        *result = gRangeRef;
    else if (CFEqual(attribute, CFSTR("AXSelectedTextMarkerRange")))
        *result = gMarkers;
    if (!*result)
        return kAXErrorAttributeUnsupported;
    CFRetain(*result);
    return kAXErrorSuccess;
}

AXError AXUIElementCopyParameterizedAttributeValue(AXUIElementRef, CFStringRef attribute, CFTypeRef parameter,
                                                   CFTypeRef *result)
{
    *result = nullptr;
    if (CFEqual(attribute, kAXStringForRangeParameterizedAttribute))
        *result = gRangeText;
    else if (CFEqual(attribute, CFSTR("AXStringForTextMarkerRange")))
        *result = gMarkerText;
    else if (CFEqual(attribute, CFSTR("AXUIElementForTextMarker")))
        *result = gSpansElements && AXTextMarkerGetBytePtr((AXTextMarkerRef)parameter)[0] == 2
                      ? CFSTR("second element")
                      : CFSTR("first element");
    if (!*result)
        return kAXErrorParameterizedAttributeUnsupported;
    CFRetain(*result);
    return kAXErrorSuccess;
}

AXError AXUIElementSetAttributeValue(AXUIElementRef, CFStringRef, CFTypeRef)
{
    return kAXErrorSuccess;
}

void CGEventPostToPid(pid_t, CGEventRef event)
{
    if (CGEventGetType(event) != kCGEventKeyDown)
        return;
    gSendCopyCalls++;
    if (gCopyChangesClipboard)
    {
        gSequence++;
        gClipboardText = gCopiedText;
        gClipboardEmpty = false;
    }
}

int main()
{
    @autoreleasepool
    {
        CFRange range = {0, 20};
        gRangeRef = AXValueCreate(kAXValueTypeCFRange, &range);
        UInt8 start = 1, end = 2;
        gMarkers = AXTextMarkerRangeCreateWithBytes(nullptr, &start, 1, &end, 1);

        FakeRunningApplication *fakeApp = [[FakeRunningApplication alloc] init];
        fakeApp.processIdentifier = 4242;
        NSRunningApplication *app = reinterpret_cast<NSRunningApplication *>(fakeApp);

        // 1. Arrow-cursor drag (allowClipboardFallback=false) still recovers AX-confirmed rich selection.
        resetState();
        gRangeText = CFSTR("same-sex lov");
        gMarkerText = CFSTR("same-sex love.");
        {
            SelectionConfigSnapshot config;
            config.clipboardEnabled = true;
            config.allowClipboardFallback = false;
            config.clipboardSequence = gSequence;
            config.runningPid = 1;
            TextSelectionInfo info;
            int64_t endingSeq = 0;
            SelectionEngine engine;
            require("arrow drag recovers confirmed rich selection", engine.GetSelectedText(app, info, config, &endingSeq));
            require("arrow drag used clipboard method", info.method == SelectionMethod::Clipboard);
            require("arrow drag returned full copied text", info.text == gCopiedText);
            require("arrow drag restored clipboard", gRestoreCalls == 1 && gClipboardText == "prior clipboard");
            require("arrow drag updated ending sequence", endingSeq == gSequence);
        }

        // 2. Arrow-cursor drag with NO AX selection still blocks blind Cmd+C.
        resetState();
        gHasFocusedElement = false;
        {
            SelectionConfigSnapshot config;
            config.clipboardEnabled = true;
            config.allowClipboardFallback = false;
            config.clipboardSequence = gSequence;
            config.runningPid = 1;
            TextSelectionInfo info;
            SelectionEngine engine;
            require("arrow drag without AX text skips copy", !engine.GetSelectedText(app, info, config));
            require("arrow drag without AX sent no Cmd+C", gSendCopyCalls == 0);
        }

        // 3. Explicit clipboardEnabled=false still prevents source copy and returns AX text.
        resetState();
        gRangeText = CFSTR("same-sex lov");
        gMarkerText = CFSTR("same-sex love.");
        {
            SelectionConfigSnapshot config;
            config.clipboardEnabled = false;
            config.allowClipboardFallback = true;
            config.clipboardSequence = gSequence;
            config.runningPid = 1;
            TextSelectionInfo info;
            SelectionEngine engine;
            require("disabled clipboard falls back to AX", engine.GetSelectedText(app, info, config));
            require("disabled clipboard stays on AXAPI", info.method == SelectionMethod::AXAPI);
            require("disabled clipboard sent no Cmd+C", gSendCopyCalls == 0);
        }

        // 4. Confirmed rich selection forces fresh copy even if pasteboard changed since mouse-down.
        resetState();
        gRangeText = CFSTR("same-sex lov");
        gMarkerText = CFSTR("same-sex love.");
        gClipboardText = "stale user clipboard";
        {
            SelectionConfigSnapshot config;
            config.clipboardEnabled = true;
            config.clipboardSequence = gSequence - 1;
            config.runningPid = 1;
            TextSelectionInfo info;
            SelectionEngine engine;
            require("rich selection ignores stale clipboard", engine.GetSelectedText(app, info, config));
            require("rich selection sent fresh Cmd+C", gSendCopyCalls == 1);
            require("rich selection returned copied text", info.text == gCopiedText);
            require("rich selection restored stale user clipboard", gClipboardText == "stale user clipboard");
        }

        // 5. Unbackupable non-empty clipboard aborts copy and preserves user pasteboard.
        resetState();
        gRangeText = CFSTR("same-sex lov");
        gMarkerText = CFSTR("same-sex love.");
        gBackupSucceeds = false;
        {
            SelectionConfigSnapshot config;
            config.clipboardEnabled = true;
            config.clipboardSequence = gSequence;
            config.runningPid = 1;
            TextSelectionInfo info;
            SelectionEngine engine;
            require("unbackupable clipboard falls back to AX", engine.GetSelectedText(app, info, config));
            require("unbackupable clipboard sent no Cmd+C", gSendCopyCalls == 0);
            require("unbackupable clipboard preserved AX text", info.text == "same-sex lov");
        }

        // 6. Empty clipboard is cleared locally after copy and ending sequence stays current.
        resetState();
        gRangeText = CFSTR("same-sex lov");
        gMarkerText = CFSTR("same-sex love.");
        gClipboardEmpty = true;
        gClipboardText.clear();
        {
            SelectionConfigSnapshot config;
            config.clipboardEnabled = true;
            config.clipboardSequence = gSequence;
            config.runningPid = 1;
            TextSelectionInfo info;
            int64_t endingSeq = 0;
            SelectionEngine engine;
            require("empty clipboard recovers rich selection", engine.GetSelectedText(app, info, config, &endingSeq));
            require("empty clipboard cleared locally", gClearLocalCalls == 1 && gRestoreCalls == 0 && gClipboardEmpty);
            require("empty clipboard updated ending sequence", endingSeq == gSequence);
        }

        // 7. Concurrent clipboard write during read does not clobber new clipboard and refreshes sequence.
        resetState();
        gRangeText = CFSTR("same-sex lov");
        gMarkerText = CFSTR("same-sex love.");
        gConcurrentChangeDuringRead = true;
        {
            SelectionConfigSnapshot config;
            config.clipboardEnabled = true;
            config.clipboardSequence = gSequence;
            config.runningPid = 1;
            TextSelectionInfo info;
            int64_t endingSeq = 0;
            SelectionEngine engine;
            require("concurrent read falls back to AX", engine.GetSelectedText(app, info, config, &endingSeq));
            require("concurrent read did not restore over new clipboard",
                    gRestoreCalls == 0 && gClipboardText == "concurrent user copy");
            require("concurrent read refreshed ending sequence", endingSeq == gSequence);
        }

        // 8. Whitespace-only AX text with differing markers must not leak preferSourceCopy_ when AX fails.
        resetState();
        gRangeText = CFSTR("   ");
        gMarkerText = CFSTR(" \n ");
        {
            SelectionConfigSnapshot config;
            config.clipboardEnabled = true;
            config.allowClipboardFallback = false;
            config.clipboardSequence = gSequence;
            config.runningPid = 1;
            TextSelectionInfo info;
            SelectionEngine engine;
            require("whitespace-only AX does not trigger copy on arrow drag", !engine.GetSelectedText(app, info, config));
            require("whitespace-only AX sent no Cmd+C", gSendCopyCalls == 0);
        }

        [fakeApp release];
        CFRelease(gMarkers);
        CFRelease(gRangeRef);
    }
    return 0;
}
