// cover: Handoff's fake lock screen (extra), so Claude can still use the screen while you're away.
// Installed by `handoff extras install cover`, which builds it to ~/.claude-watch-notes/bin/cover.
//
// The Mac never really locks while this runs. Instead, when the lid closes or nobody has touched the
// Mac for 5 minutes (and nothing is playing a video), a lock screen of ours covers every display and takes the keyboard and mouse.
// It opens with your real Mac password, checked by macOS (OpenDirectory), never stored.
// Claude lifts it while it uses the screen: a Claude Code hook runs `cover lift`, which writes "lift-until" (ms).
//
// It's weaker than the real lock, on purpose:
//   Ctrl+Option+Cmd+Shift+U   gets past it without the password (in case it's broken)
//   Cmd+Option+Esc            Force Quit still works
//   if it stops responding for 15 seconds, it quits by itself
//
// With the lid closed a MacBook has no display, so this also makes a screen in software
// (CGVirtualDisplay, as Sidecar uses) that mirrors the built-in one while the lid is open.
//
// Its picture: "coverWallpaper" in ~/.claude-watch-notes/extras.json, an image's path or "desktop"
// (your desktop picture); dark grey without one. Set with `handoff extras cover wallpaper`.
//
//   cover run        what the LaunchAgent runs
//   cover test       shows the lock screen now (the shortcut or your password closes it; quits after 60 s)
//   cover lift [N]   lifts it for N seconds (default 120): what the Claude Code hook runs

#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <IOKit/IOKitLib.h>
#import <IOKit/pwr_mgt/IOPMLib.h>
#import <OpenDirectory/OpenDirectory.h>
#import <QuartzCore/QuartzCore.h>

// ---------- the screen in software (private API, declared here) ----------

@class CGVirtualDisplay;
@interface CGVirtualDisplayDescriptor : NSObject
@property(retain, nonatomic) dispatch_queue_t queue;
@property(retain, nonatomic) NSString *name;
@property(nonatomic) unsigned int maxPixelsHigh, maxPixelsWide, serialNum, productID, vendorID;
@property(nonatomic) CGSize sizeInMillimeters;
@property(copy, nonatomic) void (^terminationHandler)(id, CGVirtualDisplay *);
@end
@interface CGVirtualDisplayMode : NSObject
- (instancetype)initWithWidth:(unsigned int)width height:(unsigned int)height refreshRate:(double)rate;
@end
@interface CGVirtualDisplaySettings : NSObject
@property(retain, nonatomic) NSArray *modes;
@property(nonatomic) unsigned int hiDPI;
@end
@interface CGVirtualDisplay : NSObject
- (instancetype)initWithDescriptor:(CGVirtualDisplayDescriptor *)descriptor;
- (BOOL)applySettings:(CGVirtualDisplaySettings *)settings;
@property(readonly, nonatomic) unsigned int displayID;
@end

static CGVirtualDisplay *virtualScreen;

static CGDirectDisplayID builtIn(void) {
    CGDirectDisplayID ids[16];
    uint32_t n = 0;
    CGGetOnlineDisplayList(16, ids, &n);
    for (uint32_t i = 0; i < n; i++) if (CGDisplayIsBuiltin(ids[i])) return ids[i];
    return kCGNullDirectDisplay;
}

static void mirror(void) {
    CGDirectDisplayID b = builtIn();
    if (!virtualScreen || b == kCGNullDirectDisplay || CGDisplayMirrorsDisplay(virtualScreen.displayID) == b) return;
    CGDisplayConfigRef config;
    if (CGBeginDisplayConfiguration(&config) != kCGErrorSuccess) return;
    CGConfigureDisplayMirrorOfDisplay(config, virtualScreen.displayID, b);
    if (CGCompleteDisplayConfiguration(config, kCGConfigureForSession) != kCGErrorSuccess) CGCancelDisplayConfiguration(config);
}

static void displaysChanged(CGDirectDisplayID d, CGDisplayChangeSummaryFlags flags, void *info) {
    if (flags & kCGDisplayBeginConfigurationFlag) return;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), dispatch_get_main_queue(), ^{ mirror(); });
}

static void makeVirtualScreen(void) {
    CGDirectDisplayID b = builtIn();
    if (b == kCGNullDirectDisplay) b = CGMainDisplayID();
    CGDisplayModeRef mode = CGDisplayCopyDisplayMode(b);
    unsigned int w = mode ? (unsigned int)CGDisplayModeGetWidth(mode) : 1470;
    unsigned int h = mode ? (unsigned int)CGDisplayModeGetHeight(mode) : 956;
    if (mode) CGDisplayModeRelease(mode);
    CGVirtualDisplayDescriptor *d = [[CGVirtualDisplayDescriptor alloc] init];
    d.queue = dispatch_get_main_queue();
    d.name = @"Handoff";
    d.maxPixelsWide = w * 2;
    d.maxPixelsHigh = h * 2;
    d.sizeInMillimeters = CGSizeMake(w * 25.4 / 110, h * 25.4 / 110);
    d.vendorID = 0x4846; d.productID = 1; d.serialNum = 1;
    d.terminationHandler = ^(id _, CGVirtualDisplay *__) { virtualScreen = nil; };
    virtualScreen = [[CGVirtualDisplay alloc] initWithDescriptor:d];
    CGVirtualDisplaySettings *s = [[CGVirtualDisplaySettings alloc] init];
    s.hiDPI = 1;
    s.modes = @[ [[CGVirtualDisplayMode alloc] initWithWidth:w height:h refreshRate:60] ];
    if (!virtualScreen || ![virtualScreen applySettings:s]) { NSLog(@"cover: no screen in software; with the lid closed the Mac may lock for real"); virtualScreen = nil; return; }
    CGDisplayRegisterReconfigurationCallback(displaysChanged, NULL);
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), dispatch_get_main_queue(), ^{ mirror(); });
}

// ---------- state ----------

static NSString *handoffDir(void) { return [NSHomeDirectory() stringByAppendingPathComponent:@".claude-watch-notes"]; }
static NSString *home(NSString *name) { return [[handoffDir() stringByAppendingPathComponent:@"cover"] stringByAppendingPathComponent:name]; }
static const double IDLE = 5 * 60;
static BOOL armed, testing;
static NSMutableArray<NSWindow *> *covers;
static NSSecureTextField *field;
static NSTextField *hint;

static BOOL lidClosed(void) {
    io_service_t root = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPMrootDomain"));
    if (!root) return NO;
    CFTypeRef v = IORegistryEntryCreateCFProperty(root, CFSTR("AppleClamshellState"), kCFAllocatorDefault, 0);
    IOObjectRelease(root);
    BOOL closed = v && CFGetTypeID(v) == CFBooleanGetTypeID() && CFBooleanGetValue(v);
    if (v) CFRelease(v);
    return closed;
}

static BOOL lifted(void) {
    NSString *until = [NSString stringWithContentsOfFile:home(@"lift-until") encoding:NSUTF8StringEncoding error:nil];
    return until && until.doubleValue > NSDate.date.timeIntervalSince1970 * 1000;
}

// Your real Mac password, checked by macOS. Never written anywhere.
static BOOL rightPassword(NSString *password) {
    NSError *e = nil;
    ODNode *node = [ODNode nodeWithSession:ODSession.defaultSession type:kODNodeTypeLocalNodes error:&e];
    ODRecord *me = [node recordWithRecordType:kODRecordTypeUsers name:NSUserName() attributes:nil error:&e];
    return me && [me verifyPassword:password error:&e];
}

// ---------- the lock screen ----------

@interface Cover : NSWindow
@end
@implementation Cover
- (BOOL)canBecomeKeyWindow { return YES; }
- (BOOL)canBecomeMainWindow { return YES; }
@end

static void hideCover(void);
static void letIn(const char *how) {
    armed = NO;
    hideCover();
    if (testing) { printf("cover test: let in by %s\n", how); fflush(stdout); exit(0); }
}

static void submit(void) {
    if (!field.enabled) return;
    NSString *password = field.stringValue;
    field.stringValue = @"";
    field.enabled = NO;
    hint.stringValue = @"Checking…";
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        BOOL ok = rightPassword(password);
        dispatch_async(dispatch_get_main_queue(), ^{
            field.enabled = YES;
            if (ok) { hint.stringValue = @""; letIn("your password"); return; }
            hint.stringValue = @"Wrong password";
            if (testing) { printf("cover test: wrong password, stayed locked\n"); fflush(stdout); }
            [field.window makeFirstResponder:field];
        });
    });
}

@interface Typed : NSObject <NSTextFieldDelegate>
@end
@implementation Typed
- (BOOL)control:(NSControl *)c textView:(NSTextView *)tv doCommandBySelector:(SEL)sel {
    if (sel != @selector(insertNewline:)) return NO;
    submit();
    return YES;
}
@end
static Typed *typed;

// macOS may not let us in front, and then keys would go to the app behind the cover. While it's up,
// a keyboard listener takes every key: into the password box, or the shortcut. (Needs Accessibility.)
static CFMachPortRef tap;
static CGEventRef keys(CGEventTapProxy proxy, CGEventType type, CGEventRef e, void *info) {
    if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) { CGEventTapEnable(tap, true); return e; }
    if (!covers.count) return e;
    if (type == kCGEventKeyDown) {
        CGEventFlags fq = kCGEventFlagMaskCommand | kCGEventFlagMaskAlternate;
        if ((CGEventGetFlags(e) & fq) == fq && CGEventGetIntegerValueField(e, kCGKeyboardEventKeycode) == 53) { letIn("Force Quit (Cmd+Option+Esc)"); return e; }
    }
    if (NSApp.isActive && field.window.isKeyWindow) return e; // in front: the password box gets them as usual
    if (type != kCGEventKeyDown) return NULL;
    CGEventFlags all = kCGEventFlagMaskControl | kCGEventFlagMaskAlternate | kCGEventFlagMaskCommand | kCGEventFlagMaskShift;
    CGKeyCode code = (CGKeyCode)CGEventGetIntegerValueField(e, kCGKeyboardEventKeycode);
    if ((CGEventGetFlags(e) & all) == all && code == 32 /* U */) { letIn("the shortcut"); return NULL; }
    // Cmd+Option+Esc: the Force Quit window would open behind the cover, so get out of the way instead.
    CGEventFlags fq = kCGEventFlagMaskCommand | kCGEventFlagMaskAlternate;
    if ((CGEventGetFlags(e) & fq) == fq && code == 53) { letIn("Force Quit (Cmd+Option+Esc)"); return e; }
    if (code == 36 || code == 76) submit();                                   // Return, Enter
    else if (code == 51) { NSString *v = field.stringValue; if (v.length) field.stringValue = [v substringToIndex:v.length - 1]; } // Delete
    else if (code == 53) field.stringValue = @"";                             // Escape
    else if (!(CGEventGetFlags(e) & (kCGEventFlagMaskCommand | kCGEventFlagMaskControl))) {
        UniChar chars[8]; UniCharCount n = 0;
        CGEventKeyboardGetUnicodeString(e, 8, &n, chars);
        if (n && field.enabled) field.stringValue = [field.stringValue stringByAppendingString:[NSString stringWithCharacters:chars length:n]];
    }
    return NULL;
}

static NSTextField *label(NSString *s, CGFloat size, NSFontWeight weight, CGFloat white) {
    NSTextField *t = [NSTextField labelWithString:s];
    t.font = [NSFont systemFontOfSize:size weight:weight];
    t.textColor = [NSColor colorWithWhite:white alpha:1];
    t.alignment = NSTextAlignmentCenter;
    return t;
}

static void center(NSControl *v, NSRect in, CGFloat y, CGFloat width) {
    [v sizeToFit];
    CGFloat w = width ?: v.frame.size.width;
    v.frame = NSMakeRect((in.size.width - w) / 2, y, w, v.frame.size.height);
}

// The picture behind the clock: read each time it covers, so a new one applies without a restart.
static NSImage *wallpaper(NSScreen *screen) {
    NSData *json = [NSData dataWithContentsOfFile:[handoffDir() stringByAppendingPathComponent:@"extras.json"]];
    NSDictionary *extras = json ? [NSJSONSerialization JSONObjectWithData:json options:0 error:nil] : nil;
    id choice = [extras isKindOfClass:NSDictionary.class] ? extras[@"coverWallpaper"] : nil;
    if (![choice isKindOfClass:NSString.class] || ![choice length]) return nil;
    NSURL *url = [choice isEqual:@"desktop"] ? [NSWorkspace.sharedWorkspace desktopImageURLForScreen:screen] : [NSURL fileURLWithPath:choice];
    return url ? [[NSImage alloc] initWithContentsOfURL:url] : nil;
}

static void showCover(void) {
    if (covers.count) return;
    NSScreen *main = NSScreen.mainScreen;
    for (NSScreen *screen in NSScreen.screens) {
        Cover *w = [[Cover alloc] initWithContentRect:screen.frame styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
        w.releasedWhenClosed = NO;
        w.level = CGShieldingWindowLevel();
        w.backgroundColor = [NSColor colorWithWhite:0.08 alpha:1];
        w.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorStationary | NSWindowCollectionBehaviorFullScreenAuxiliary;
        [w setFrame:screen.frame display:NO];
        NSRect r = screen.frame;
        NSImage *picture = wallpaper(screen);
        if (picture) { // fills the screen, a little darker so the clock and password box stay readable
            NSView *back = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, r.size.width, r.size.height)];
            back.wantsLayer = YES;
            back.layer.contents = picture;
            back.layer.contentsGravity = kCAGravityResizeAspectFill;
            back.layer.masksToBounds = YES;
            CALayer *shade = [CALayer layer];
            shade.frame = back.bounds;
            shade.backgroundColor = [NSColor colorWithWhite:0 alpha:0.3].CGColor;
            [back.layer addSublayer:shade];
            [w.contentView addSubview:back];
        }
        if (screen == main) {
            NSDateFormatter *f = [[NSDateFormatter alloc] init];
            f.dateFormat = @"h:mm";
            NSTextField *clock = label([f stringFromDate:NSDate.date], 96, NSFontWeightSemibold, 0.85);
            center(clock, r, r.size.height * 0.68, 0);
            NSTextField *name = label(NSFullUserName(), 18, NSFontWeightMedium, 0.9);
            center(name, r, r.size.height * 0.30, 0);
            field = [[NSSecureTextField alloc] initWithFrame:NSMakeRect((r.size.width - 220) / 2, r.size.height * 0.30 - 40, 220, 26)];
            field.placeholderString = @"Enter Password";
            field.bezelStyle = NSTextFieldRoundedBezel;
            field.delegate = typed;
            hint = label(@"", 13, NSFontWeightRegular, 0.6);
            hint.frame = NSMakeRect((r.size.width - 300) / 2, r.size.height * 0.30 - 70, 300, 18);
            for (NSView *v in @[ clock, name, field, hint ]) [w.contentView addSubview:v];
        }
        [w orderFrontRegardless];
        [covers addObject:w];
    }
    NSApp.presentationOptions = NSApplicationPresentationHideDock | NSApplicationPresentationHideMenuBar |
        NSApplicationPresentationDisableProcessSwitching | NSApplicationPresentationDisableHideApplication;
    [NSApp activateIgnoringOtherApps:YES];
    if (@available(macOS 14, *)) [NSApp activate];
    for (NSWindow *w in covers) if (field.window == w) { [w makeKeyAndOrderFront:nil]; [w makeFirstResponder:field]; }
}

static void hideCover(void) {
    if (!covers.count) return;
    for (NSWindow *w in covers) [w orderOut:nil];
    [covers removeAllObjects];
    field = nil; hint = nil;
    NSApp.presentationOptions = NSApplicationPresentationDefault;
    [NSApp hide:nil]; // the app you were in gets the keyboard back
}

// Force Quit's window (it belongs to loginwindow) would open behind the cover: when one shows up, get out of the way.
// Keys alone can't tell, since the password box turns on secure input, which hides them from listeners.
static void forceQuitCheck(void) {
    if (!covers.count) return;
    NSArray *list = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID));
    for (NSDictionary *w in list) {
        if (![w[(id)kCGWindowOwnerName] isEqual:@"loginwindow"]) continue;
        CGRect r;
        if (CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)w[(id)kCGWindowBounds], &r) && r.size.width > 100 && r.size.height > 100) {
            letIn("Force Quit (Cmd+Option+Esc)");
            return;
        }
    }
}

// Something playing a video (or a presentation) keeps the display on: the real lock waits for it, so we do too.
static BOOL somethingPlaying(void) {
    CFDictionaryRef byPid = NULL;
    if (IOPMCopyAssertionsByProcess(&byPid) != kIOReturnSuccess || !byPid) return NO;
    NSDictionary *all = CFBridgingRelease(byPid);
    for (NSNumber *pid in all) {
        if (pid.intValue == getpid()) continue;
        for (NSDictionary *a in all[pid]) {
            NSString *type = a[@"AssertType"];
            if (([type isEqual:@"PreventUserIdleDisplaySleep"] || [type isEqual:@"NoDisplaySleepAssertion"]) && [a[@"AssertLevel"] intValue] > 0) return YES;
        }
    }
    return NO;
}

// Twice a second: cover when the lid has closed or nobody has used the Mac for a while, unless Claude is working.
static void tick(void) {
    static BOOL wasClosed;
    BOOL closed = lidClosed();
    double idle = CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateHIDSystemState, kCGAnyInputEventType);
    if ((closed && !wasClosed) || (idle > IDLE && !lifted() && !somethingPlaying())) armed = YES;
    wasClosed = closed;
    if (armed && !lifted()) showCover(); else hideCover();
}

// `cover lift N`: Claude is about to use the screen. If the cover was down, give it a moment to go before Claude looks.
static int lift(int seconds) {
    double now = NSDate.date.timeIntervalSince1970 * 1000;
    BOOL wasDown = !lifted();
    [NSFileManager.defaultManager createDirectoryAtPath:home(@"") withIntermediateDirectories:YES attributes:nil error:nil];
    [[NSString stringWithFormat:@"%.0f", now + seconds * 1000.0] writeToFile:home(@"lift-until") atomically:YES encoding:NSUTF8StringEncoding error:nil];
    int pid = [NSString stringWithContentsOfFile:home(@"pid") encoding:NSUTF8StringEncoding error:nil].intValue;
    if (wasDown && pid > 0 && kill(pid, 0) == 0) sleep(1);
    return 0;
}

int main(int argc, char **argv) {
    @autoreleasepool {
        NSString *mode = argc > 1 ? @(argv[1]) : @"";
        if ([mode isEqual:@"lift"]) return lift(argc > 2 && atoi(argv[2]) > 0 ? atoi(argv[2]) : 120);
        if (![mode isEqual:@"run"] && ![mode isEqual:@"test"]) { fprintf(stderr, "usage: cover run|test|lift [seconds]\n"); return 1; }
        testing = [mode isEqual:@"test"];
        [NSApplication sharedApplication];
        NSApp.activationPolicy = NSApplicationActivationPolicyAccessory;
        covers = [NSMutableArray array];
        typed = [[Typed alloc] init];

        // Ctrl+Option+Cmd+Shift+U: past it without the password, in case it's broken.
        [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown handler:^NSEvent *(NSEvent *e) {
            NSEventModifierFlags all = NSEventModifierFlagControl | NSEventModifierFlagOption | NSEventModifierFlagCommand | NSEventModifierFlagShift;
            if ((e.modifierFlags & all) == all && e.keyCode == 32 /* U */) { letIn("the shortcut"); return nil; }
            if (testing && (e.modifierFlags & (NSEventModifierFlagControl | NSEventModifierFlagOption | NSEventModifierFlagCommand))) {
                printf("cover test: key %d with%s%s%s%s\n", e.keyCode, e.modifierFlags & NSEventModifierFlagControl ? " ctrl" : "", e.modifierFlags & NSEventModifierFlagOption ? " option" : "",
                    e.modifierFlags & NSEventModifierFlagCommand ? " cmd" : "", e.modifierFlags & NSEventModifierFlagShift ? " shift" : "");
                fflush(stdout);
            }
            NSEventModifierFlags fq = NSEventModifierFlagCommand | NSEventModifierFlagOption;
            if ((e.modifierFlags & fq) == fq && e.keyCode == 53) { letIn("Force Quit (Cmd+Option+Esc)"); return e; }
            return e;
        }];
        // If it stops responding, get out of the way.
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
            __block volatile double alive = NSDate.date.timeIntervalSince1970;
            for (;;) {
                dispatch_async(dispatch_get_main_queue(), ^{ alive = NSDate.date.timeIntervalSince1970; });
                sleep(5);
                if (NSDate.date.timeIntervalSince1970 - alive > 15) { NSLog(@"cover: not responding, quitting"); exit(1); }
            }
        });
        // A screen added or taken away (the lid): cover them all again. Hiding the menu bar also sends this,
        // so only when the screens themselves changed.
        __block NSString *screensWere = nil;
        NSString *(^screensNow)(void) = ^{ NSMutableString *s = [NSMutableString string]; for (NSScreen *x in NSScreen.screens) [s appendString:NSStringFromRect(x.frame)]; return (NSString *)s; };
        screensWere = screensNow();
        [NSNotificationCenter.defaultCenter addObserverForName:NSApplicationDidChangeScreenParametersNotification object:nil queue:nil
            usingBlock:^(NSNotification *n) {
                NSString *now = screensNow();
                if ([now isEqual:screensWere]) return;
                screensWere = now;
                if (!covers.count) return;
                for (NSWindow *w in covers) [w orderOut:nil];
                [covers removeAllObjects];
                showCover();
            }];
        tap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionDefault,
            CGEventMaskBit(kCGEventKeyDown) | CGEventMaskBit(kCGEventKeyUp) | CGEventMaskBit(kCGEventFlagsChanged), keys, NULL);
        if (tap) CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(NULL, tap, 0), kCFRunLoopCommonModes);
        else NSLog(@"cover: no keyboard listener (allow it under Accessibility); keys may reach the app behind the cover");

        [NSTimer scheduledTimerWithTimeInterval:0.5 repeats:YES block:^(NSTimer *t) { forceQuitCheck(); }];
        if (testing) {
            armed = YES;
            showCover();
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 60 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{ printf("cover test: closed after 60 seconds\n"); exit(0); });
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
                printf("cover test: in front=%s, keyboard listener=%s\n", NSApp.isActive ? "yes" : "no", tap ? "yes" : "no");
                fflush(stdout);
            });
        } else {
            [NSFileManager.defaultManager createDirectoryAtPath:home(@"") withIntermediateDirectories:YES attributes:nil error:nil];
            [[NSString stringWithFormat:@"%d", getpid()] writeToFile:home(@"pid") atomically:YES encoding:NSUTF8StringEncoding error:nil];
            makeVirtualScreen();
            // The real lock comes with display sleep or the screen saver: keep the display awake instead.
            IOPMAssertionID awake;
            IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleDisplaySleep, kIOPMAssertionLevelOn, CFSTR("Handoff cover"), &awake);
            armed = lidClosed();
            [NSTimer scheduledTimerWithTimeInterval:0.5 repeats:YES block:^(NSTimer *t) { tick(); }];
        }
        [NSApp run];
    }
    return 0;
}
