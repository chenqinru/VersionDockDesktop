# VersionDock Desktop patch

Upstream: `tao` 0.35.3 from crates.io, licensed under Apache-2.0.
The upstream source, examples and license files are retained. Cargo registry
metadata and the dependency crate lockfile are omitted.

## macOS animated resize reentrancy

`src/platform_impl/macos/util/async.rs::set_maximized_async` previously held
`SharedState`'s mutex while calling `NSWindow.zoom:` or
`setFrame:display:animate:`. AppKit runs a nested event loop during these
animations. A resize callback that services WebKit's render callbacks can
dispatch a window-state query and deadlock on that same mutex.

The patch releases the mutex after updating/snapshotting the state and before
entering AppKit. Both the titled/resizable and fallback branches are covered.
No window behavior or other platform implementation is changed.

Keep this patch when updating Tao, or remove the override once the upstream
version releases the mutex before both AppKit calls. Do not replace it with
build-time modifications to the Cargo registry cache.

Acceptance: open a real multi-repository workspace in a separate QA app and
capture intermediate frames during repeated titlebar double-click maximize /
restore, edge dragging, and fullscreen exit. Verify that the app remains
responsive, the page fills the window, and geometry persistence still works.
