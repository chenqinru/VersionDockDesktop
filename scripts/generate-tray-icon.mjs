// macOS: node scripts/generate-tray-icon.mjs
// Reuse the logo's light foreground as a transparent macOS template mask.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'versiondock-tray-'));
const source = join(temporary, 'render.m');
const executable = join(temporary, 'render');
try {
  writeFileSync(source, `
#import <Cocoa/Cocoa.h>
int main(int argc, const char **argv) {
  @autoreleasepool {
    if (argc != 3) return 1;
    NSBitmapImageRep *input = [[NSBitmapImageRep alloc] initWithData:[NSData dataWithContentsOfFile:@(argv[1])]];
    if (!input) return 2;
    NSBitmapImageRep *mask = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:input.pixelsWide pixelsHigh:input.pixelsHigh bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
    for (NSInteger y = 0; y < input.pixelsHigh; y++) {
      for (NSInteger x = 0; x < input.pixelsWide; x++) {
        NSColor *color = [[input colorAtX:x y:y] colorUsingColorSpace:[NSColorSpace deviceRGBColorSpace]];
        CGFloat brightness = MIN(color.redComponent, MIN(color.greenComponent, color.blueComponent));
        CGFloat alpha = MAX(0, MIN(1, (brightness - 0.55) / 0.18)) * color.alphaComponent;
        [mask setColor:[NSColor colorWithDeviceRed:0 green:0 blue:0 alpha:alpha] atX:x y:y];
      }
    }
    // 36 physical pixels, rendered by AppKit at 18 points on Retina screens.
    NSBitmapImageRep *output = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:36 pixelsHigh:36 bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:144 bitsPerPixel:0];
    [NSGraphicsContext saveGraphicsState];
    [NSGraphicsContext setCurrentContext:[NSGraphicsContext graphicsContextWithBitmapImageRep:output]];
    [[NSGraphicsContext currentContext] setImageInterpolation:NSImageInterpolationHigh];
    NSImage *image = [[NSImage alloc] initWithSize:NSMakeSize(input.pixelsWide, input.pixelsHigh)];
    [image addRepresentation:mask];
    [image drawInRect:NSMakeRect(2, 2, 32, 32)];
    [NSGraphicsContext restoreGraphicsState];
    NSData *png = [output representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    NSString *target = @(argv[2]);
    if (![png writeToFile:target atomically:YES]) return 3;
    NSString *raw = [[target stringByDeletingPathExtension] stringByAppendingPathExtension:@"rgba"];
    // Raw RGBA keeps Rust free of a runtime PNG decoder and its dependencies.
    NSData *rgba = [NSData dataWithBytes:output.bitmapData length:output.bytesPerRow * output.pixelsHigh];
    if (![rgba writeToFile:raw atomically:YES]) return 4;
    NSBitmapImageRep *brand = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:32 pixelsHigh:32 bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:128 bitsPerPixel:0];
    [NSGraphicsContext saveGraphicsState];
    [NSGraphicsContext setCurrentContext:[NSGraphicsContext graphicsContextWithBitmapImageRep:brand]];
    [[NSGraphicsContext currentContext] setImageInterpolation:NSImageInterpolationHigh];
    NSImage *brandImage = [[NSImage alloc] initWithData:[NSData dataWithContentsOfFile:@(argv[1])]];
    [brandImage drawInRect:NSMakeRect(0, 0, 32, 32)];
    [NSGraphicsContext restoreGraphicsState];
    NSString *brandTarget = [[target stringByDeletingLastPathComponent] stringByAppendingPathComponent:@"tray-brand.rgba"];
    if (![[NSData dataWithBytes:brand.bitmapData length:brand.bytesPerRow * brand.pixelsHigh] writeToFile:brandTarget atomically:YES]) return 5;
    // A compact D badge remains legible in Windows/Linux trays at small sizes.
    [NSGraphicsContext saveGraphicsState];
    [NSGraphicsContext setCurrentContext:[NSGraphicsContext graphicsContextWithBitmapImageRep:brand]];
    [[NSColor colorWithDeviceRed:1 green:0.4 blue:0.05 alpha:1] setFill];
    [[NSBezierPath bezierPathWithRoundedRect:NSMakeRect(17, 0, 15, 15) xRadius:4 yRadius:4] fill];
    [@"D" drawAtPoint:NSMakePoint(20, 0) withAttributes:@{NSFontAttributeName:[NSFont boldSystemFontOfSize:12], NSForegroundColorAttributeName:[NSColor whiteColor]}];
    [NSGraphicsContext restoreGraphicsState];
    NSString *devTarget = [[target stringByDeletingLastPathComponent] stringByAppendingPathComponent:@"tray-brand-dev.rgba"];
    if (![[NSData dataWithBytes:brand.bitmapData length:brand.bytesPerRow * brand.pixelsHigh] writeToFile:devTarget atomically:YES]) return 6;
    NSString *devPreview = [[devTarget stringByDeletingPathExtension] stringByAppendingPathExtension:@"png"];
    return [[brand representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:devPreview atomically:YES] ? 0 : 7;
  }
}`);
  execFileSync('clang', ['-framework', 'Cocoa', source, '-o', executable]);
  execFileSync(executable, [join(root, 'public/icons/versiondock-logo-dark.png'), join(root, 'src-tauri/icons/tray-template.png')]);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
