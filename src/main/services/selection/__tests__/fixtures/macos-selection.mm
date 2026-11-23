#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#include <cstdio>
#include <string>
#include <vector>
#define private public
#include "core/engine.h"
#undef private

static CFTypeRef selectedText;
static CFTypeRef selectedRange;
static CFTypeRef rangeText;
static CFTypeRef value;
static AXTextMarkerRangeRef markers;
static CFStringRef markerText;
static bool spansElements;

AXError AXUIElementCopyAttributeValue(AXUIElementRef, CFStringRef attribute, CFTypeRef *result)
{
    *result = nullptr;
    if (CFEqual(attribute, kAXSelectedTextAttribute)) *result = selectedText;
    if (CFEqual(attribute, kAXSelectedTextRangeAttribute)) *result = selectedRange;
    if (CFEqual(attribute, CFSTR("AXSelectedTextMarkerRange"))) *result = markers;
    if (CFEqual(attribute, kAXValueAttribute)) *result = value;
    if (!*result) return kAXErrorAttributeUnsupported;
    CFRetain(*result);
    return kAXErrorSuccess;
}

AXError AXUIElementCopyParameterizedAttributeValue(AXUIElementRef, CFStringRef attribute,
                                                 CFTypeRef parameter, CFTypeRef *result)
{
    *result = nullptr;
    if (CFEqual(attribute, CFSTR("AXStringForTextMarkerRange"))) *result = markerText;
    if (CFEqual(attribute, CFSTR("AXUIElementForTextMarker")))
        *result = spansElements && AXTextMarkerGetBytePtr((AXTextMarkerRef)parameter)[0] == 2
                      ? CFSTR("second element") : CFSTR("first element");
    if (CFEqual(attribute, kAXStringForRangeParameterizedAttribute)) *result = rangeText;
    if (!*result) return kAXErrorParameterizedAttributeUnsupported;
    CFRetain(*result);
    return kAXErrorSuccess;
}

static void expectText(const char *scenario, const char *expected, bool needsCopy = false)
{
    SelectionEngine engine;
    std::string actual;
    bool found = engine.GetSelectedTextFromElement(reinterpret_cast<AXUIElementRef>(1), actual);
    if (found != (expected[0] != '\0') || actual != expected || engine.preferSourceCopy_ != needsCopy)
    {
        fprintf(stderr, "%s: expected [%s] (copy=%d), got [%s] (copy=%d)\n",
                scenario, expected, needsCopy, actual.c_str(), engine.preferSourceCopy_);
        exit(1);
    }
}

int main()
{
    CFRange range = {7, 14};
    selectedRange = AXValueCreate(kAXValueTypeCFRange, &range);
    selectedText = CFSTR("elected words)");
    rangeText = CFSTR("selected words");
    expectText("Chromium soft-wrap offset", "selected words");

    UInt8 start = 1, end = 2;
    markers = AXTextMarkerRangeCreateWithBytes(nullptr, &start, 1, &end, 1);
    markerText = CFStringCreateWithCString(kCFAllocatorDefault, "onehour and eighteenminutes.", kCFStringEncodingUTF8);
    rangeText = CFSTR("one hour and eighteen minute");
    expectText("inconsistent AX serializations require source copy", "one hour and eighteen minute", true);
    CFRelease(markerText);
    rangeText = markerText = CFSTR("one paragraphanother paragraph");
    spansElements = true;
    expectText("matching AX strings can omit paragraph breaks", "one paragraphanother paragraph", true);
    rangeText = nullptr;
    selectedText = CFSTR("one paragraphanother paragraph");
    expectText("kAXSelectedText fallback still checks markers", "one paragraphanother paragraph", true);
    rangeText = markerText;
    spansElements = false;
    expectText("ordinary selection stays on AX", "one paragraphanother paragraph");
    CFRelease(markers);
    markers = nullptr;

    selectedText = CFSTR("native selection");
    rangeText = nullptr;
    expectText("unsupported range lookup", "native selection");
    rangeText = CFSTR("");
    expectText("empty range lookup", "native selection");
    rangeText = kCFBooleanTrue;
    expectText("non-string range lookup", "native selection");

    rangeText = nullptr;
    selectedText = nullptr;
    value = CFSTR("Before selected words) after.");
    expectText("value-only provider", "selected words");
    value = nullptr;
    expectText("no selection", "");
    CFRelease(selectedRange);

    selectedRange = nullptr;
    selectedText = CFSTR("native selection");
    expectText("unsupported selected range", "native selection");
    selectedRange = kCFBooleanTrue;
    expectText("non-range attribute", "native selection");

    selectedRange = nullptr;
    int number = 42;
    selectedText = CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &number);
    expectText("numeric selection", "42");
    CFRelease(selectedText);
    return 0;
}
