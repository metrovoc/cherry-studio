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

AXError AXUIElementCopyAttributeValue(AXUIElementRef, CFStringRef attribute, CFTypeRef *result)
{
    *result = nullptr;
    if (CFEqual(attribute, kAXSelectedTextAttribute)) *result = selectedText;
    if (CFEqual(attribute, kAXSelectedTextRangeAttribute)) *result = selectedRange;
    if (CFEqual(attribute, kAXValueAttribute)) *result = value;
    if (!*result) return kAXErrorAttributeUnsupported;
    CFRetain(*result);
    return kAXErrorSuccess;
}

AXError AXUIElementCopyParameterizedAttributeValue(AXUIElementRef, CFStringRef attribute,
                                                 CFTypeRef, CFTypeRef *result)
{
    *result = nullptr;
    if (CFEqual(attribute, kAXStringForRangeParameterizedAttribute)) *result = rangeText;
    if (!*result) return kAXErrorParameterizedAttributeUnsupported;
    CFRetain(*result);
    return kAXErrorSuccess;
}

static void expectText(const char *scenario, const char *expected)
{
    SelectionEngine engine;
    std::string actual;
    bool found = engine.GetSelectedTextFromElement(reinterpret_cast<AXUIElementRef>(1), actual);
    if (found != (expected[0] != '\0') || actual != expected)
    {
        fprintf(stderr, "%s: expected [%s], got [%s]\n", scenario, expected, actual.c_str());
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
