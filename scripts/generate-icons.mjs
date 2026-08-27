import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const rootDir = new URL('..', import.meta.url).pathname;
const srcLogo = join(rootDir, 'public/icons/versiondock-logo-dark.png');
const iconsDir = join(rootDir, 'src-tauri/icons');

if (!existsSync(srcLogo)) {
  console.error(`Source logo not found: ${srcLogo}`);
  process.exit(1);
}

mkdirSync(iconsDir, { recursive: true });

// 1. Compile native helper to render HIG-compliant iconset using CoreGraphics
const tempDir = mkdtempSync(join(tmpdir(), 'vdesktop-icon-'));
const objcSource = join(tempDir, 'render.m');
const binaryPath = join(tempDir, 'render');
const iconsetDir = join(tempDir, 'icon.iconset');
mkdirSync(iconsetDir, { recursive: true });

const objcCode = `
#import <Cocoa/Cocoa.h>

int main(int argc, const char * argv[]) {
    @autoreleasepool {
        if (argc < 3) return 1;
        NSString *srcPath = [NSString stringWithUTF8String:argv[1]];
        NSString *iconsetPath = [NSString stringWithUTF8String:argv[2]];

        NSImage *srcImage = [[NSImage alloc] initWithContentsOfFile:srcPath];
        if (!srcImage) {
            NSLog(@"Failed to load image from %@", srcPath);
            return 1;
        }

        // Apple HIG: 1024x1024 canvas, 824x824 icon body centered (x: 100, y: 100)
        // With subtle drop shadow
        NSSize canvasSize = NSMakeSize(1024, 1024);
        NSImage *standardIcon = [[NSImage alloc] initWithSize:canvasSize];

        [standardIcon lockFocus];
        CGContextRef ctx = [[NSGraphicsContext currentContext] CGContext];
        CGContextClearRect(ctx, CGRectMake(0, 0, 1024, 1024));

        CGFloat bodySize = 824.0;
        CGFloat x = (1024.0 - bodySize) / 2.0; // 100.0
        CGFloat y = (1024.0 - bodySize) / 2.0 + 4.0; // 104.0 (subtle bottom shadow offset)
        NSRect bodyRect = NSMakeRect(x, y, bodySize, bodySize);

        // Ambient soft shadow
        CGContextSaveGState(ctx);
        CGColorRef shadow1Color = CGColorCreateGenericRGB(0, 0, 0, 0.28);
        CGContextSetShadowWithColor(ctx, CGSizeMake(0, -14), 22.0, shadow1Color);
        [srcImage drawInRect:bodyRect fromRect:NSZeroRect operation:NSCompositingOperationSourceOver fraction:1.0];
        CGColorRelease(shadow1Color);
        CGContextRestoreGState(ctx);

        // Key sharp shadow
        CGContextSaveGState(ctx);
        CGColorRef shadow2Color = CGColorCreateGenericRGB(0, 0, 0, 0.20);
        CGContextSetShadowWithColor(ctx, CGSizeMake(0, -4), 8.0, shadow2Color);
        [srcImage drawInRect:bodyRect fromRect:NSZeroRect operation:NSCompositingOperationSourceOver fraction:1.0];
        CGColorRelease(shadow2Color);
        CGContextRestoreGState(ctx);

        // Main body on top
        [srcImage drawInRect:bodyRect fromRect:NSZeroRect operation:NSCompositingOperationSourceOver fraction:1.0];

        [standardIcon unlockFocus];

        struct IconSize {
            const char *name;
            int size;
        } sizes[] = {
            {"icon_16x16.png", 16},
            {"icon_16x16@2x.png", 32},
            {"icon_32x32.png", 32},
            {"icon_32x32@2x.png", 64},
            {"icon_128x128.png", 128},
            {"icon_128x128@2x.png", 256},
            {"icon_256x256.png", 256},
            {"icon_256x256@2x.png", 512},
            {"icon_512x512.png", 512},
            {"icon_512x512@2x.png", 1024}
        };

        for (int i = 0; i < sizeof(sizes)/sizeof(sizes[0]); i++) {
            int s = sizes[i].size;
            NSImage *resized = [[NSImage alloc] initWithSize:NSMakeSize(s, s)];
            [resized lockFocus];
            [[NSGraphicsContext currentContext] setImageInterpolation:NSImageInterpolationHigh];
            [standardIcon drawInRect:NSMakeRect(0, 0, s, s) fromRect:NSMakeRect(0, 0, 1024, 1024) operation:NSCompositingOperationCopy fraction:1.0];
            [resized unlockFocus];

            NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithData:[resized TIFFRepresentation]];
            NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
            NSString *filePath = [iconsetPath stringByAppendingPathComponent:[NSString stringWithUTF8String:sizes[i].name]];
            [png writeToFile:filePath atomically:YES];
        }
    }
    return 0;
}
`;

writeFileSync(objcSource, objcCode, 'utf8');

try {
  console.log('Compiling native icon generator...');
  execFileSync('clang', ['-framework', 'Cocoa', objcSource, '-o', binaryPath]);

  console.log('Rendering HIG-compliant iconset...');
  execFileSync(binaryPath, [srcLogo, iconsetDir]);

  // 2. Generate icon.icns via iconutil
  console.log('Building icon.icns via iconutil...');
  const icnsPath = join(iconsDir, 'icon.icns');
  execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', icnsPath]);

  // 3. Copy/Generate required PNGs for Tauri
  console.log('Writing Tauri PNG icons...');
  writeFileSync(join(iconsDir, '32x32.png'), readFileSync(join(iconsetDir, 'icon_32x32.png')));
  writeFileSync(join(iconsDir, '64x64.png'), readFileSync(join(iconsetDir, 'icon_32x32@2x.png')));
  writeFileSync(join(iconsDir, '128x128.png'), readFileSync(join(iconsetDir, 'icon_128x128.png')));
  writeFileSync(join(iconsDir, '128x128@2x.png'), readFileSync(join(iconsetDir, 'icon_128x128@2x.png')));
  writeFileSync(join(iconsDir, 'icon.png'), readFileSync(join(iconsetDir, 'icon_512x512.png')));

  // 4. Build standard multi-resolution icon.ico for Windows
  console.log('Building icon.ico...');
  const icoSizes = [16, 32, 64, 128, 256];
  const pngBuffers = [];

  for (const s of icoSizes) {
    const pngName = s === 16 ? 'icon_16x16.png'
      : s === 32 ? 'icon_32x32.png'
      : s === 64 ? 'icon_32x32@2x.png'
      : s === 128 ? 'icon_128x128.png'
      : 'icon_256x256.png';
    pngBuffers.push({ size: s, buffer: readFileSync(join(iconsetDir, pngName)) });
  }

  // Assemble standard ICO binary
  const count = pngBuffers.length;
  const headerSize = 6 + count * 16;
  let currentOffset = headerSize;
  const entryBuffers = [];
  const imageBuffers = [];

  for (const item of pngBuffers) {
    const b = Buffer.alloc(16);
    b.writeUInt8(item.size >= 256 ? 0 : item.size, 0); // width
    b.writeUInt8(item.size >= 256 ? 0 : item.size, 1); // height
    b.writeUInt8(0, 2); // colors
    b.writeUInt8(0, 3); // reserved
    b.writeUInt16LE(1, 4); // color planes
    b.writeUInt16LE(32, 6); // bpp
    b.writeUInt32LE(item.buffer.length, 8); // size in bytes
    b.writeUInt32LE(currentOffset, 12); // offset
    entryBuffers.push(b);
    imageBuffers.push(item.buffer);
    currentOffset += item.buffer.length;
  }

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  const icoBuffer = Buffer.concat([header, ...entryBuffers, ...imageBuffers]);
  writeFileSync(join(iconsDir, 'icon.ico'), icoBuffer);

  console.log('✅ All icons successfully generated with macOS HIG compliance in src-tauri/icons/');
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
