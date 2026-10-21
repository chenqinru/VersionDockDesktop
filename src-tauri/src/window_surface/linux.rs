//! Main WebKitGTK views follow their GTK Box allocation, not Wry's Fixed bounds.
use gtk::prelude::*;
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::Rc,
};
use webkit2gtk::WebViewExt;

#[derive(Default)]
struct Frame {
    image: Option<gtk::cairo::ImageSurface>,
    previous: Option<gtk::cairo::ImageSurface>,
    cache_until: Option<std::time::Instant>,
    generation: u64,
    release_after_draw: bool,
    prepared: Option<(i32, i32)>,
    timeout: Option<gtk::glib::SourceId>,
}
struct ResizeObserver {
    handlers: Vec<(gtk::glib::WeakRef<gtk::Widget>, gtk::glib::SignalHandlerId)>,
    frame: Rc<RefCell<Frame>>,
    active: Rc<Cell<bool>>,
}
impl Drop for ResizeObserver {
    fn drop(&mut self) {
        self.active.set(false);
        if let Some(timeout) = self.frame.borrow_mut().timeout.take() {
            timeout.remove();
        }
        for (widget, handler) in self.handlers.drain(..) {
            if let Some(widget) = widget.upgrade() {
                widget.disconnect(handler);
            }
        }
    }
}
thread_local! { static OBSERVERS: RefCell<HashMap<String,ResizeObserver>>=RefCell::default(); }
pub(super) fn forget(label: &str) {
    OBSERVERS.with(|entries| {
        entries.borrow_mut().remove(label);
    });
}

pub(super) fn clear_frame(label: &str) {
    OBSERVERS.with(|entries| {
        if let Some(observer) = entries.borrow().get(label) {
            let mut frame = observer.frame.borrow_mut();
            frame.generation = frame.generation.wrapping_add(1);
            frame.image = None;
            frame.previous = None;
            frame.release_after_draw = false;
            frame.prepared = None;
            if let Some(timeout) = frame.timeout.take() {
                timeout.remove();
            }
        }
    });
}

pub(super) fn release_prepared(label: &str) {
    OBSERVERS.with(|entries| {
        if let Some(observer) = entries.borrow().get(label) {
            observer.frame.borrow_mut().prepared = None;
        }
    });
}

pub(super) fn prepare(view: &webkit2gtk::WebView, label: &str, width: i32, height: i32) {
    OBSERVERS.with(|entries| {
        if let Some(observer) = entries.borrow().get(label) {
            observer.frame.borrow_mut().prepared = Some((width, height));
        }
    });
    view.size_allocate(&gtk::Allocation::new(0, 0, width, height));
}

/// Cover only the renderer's short allocation-to-paint gap with its last frame.
/// All callbacks stay asynchronous: no nested GTK loop or wait on the UI thread.
pub(super) fn observe(view: &webkit2gtk::WebView, label: &str) {
    OBSERVERS.with(|entries| {
        let mut entries = entries.borrow_mut();
        if entries.contains_key(label) {
            return;
        }
        let Some(window) = view
            .toplevel()
            .and_then(|widget| widget.downcast::<gtk::Window>().ok())
        else {
            return;
        };
        let frame = Rc::new(RefCell::new(Frame {
            cache_until: Some(std::time::Instant::now() + std::time::Duration::from_millis(200)),
            ..Frame::default()
        }));
        let active = Rc::new(Cell::new(true));
        let capturing = Rc::new(Cell::new(false));
        let Some(parent) = view.parent() else {
            return;
        };
        // GTK's parent can allocate again while a growing viewport is being
        // prepared. Keep that viewport until the native window consumes it.
        let parent_allocate = parent.connect_size_allocate({
            let frame = frame.clone();
            let weak = view.downgrade();
            move |_, allocation| {
                let target = frame.borrow().prepared;
                if let Some((width, height)) = target {
                    if allocation.width() == width && allocation.height() == height {
                        frame.borrow_mut().prepared = None;
                    } else if let Some(view) = weak.upgrade() {
                        let current = view.allocation();
                        if current.width() != width || current.height() != height {
                            view.size_allocate(&gtk::Allocation::new(0, 0, width, height));
                        }
                    }
                }
            }
        });
        // Paint the retained image after WebKit's own draw. Its default handler
        // must run so the compositor can acknowledge and deliver the new frame.
        let draw = view.connect_local("draw", true, {
            let frame = frame.clone();
            let capturing = capturing.clone();
            move |values| {
                let view = values[0].get::<webkit2gtk::WebView>().ok()?;
                let context = values[1].get::<gtk::cairo::Context>().ok()?;
                if capturing.get() {
                    return Some(false.to_value());
                }
                let mut frame = frame.borrow_mut();
                let Some(image) = frame.image.as_ref() else {
                    if frame
                        .cache_until
                        .is_some_and(|until| std::time::Instant::now() <= until)
                    {
                        if frame.previous.is_none() {
                            frame.previous = copy_painted_frame(&view, &context);
                        }
                    } else {
                        frame.previous = None;
                    }
                    return Some(false.to_value());
                };
                let allocation = view.allocation();
                if context.save().is_ok() {
                    let (sx, sy) = image.device_scale();
                    context.scale(
                        f64::from(allocation.width()) * sx / f64::from(image.width()),
                        f64::from(allocation.height()) * sy / f64::from(image.height()),
                    );
                    if context.set_source_surface(image, 0.0, 0.0).is_ok() {
                        context.source().set_extend(gtk::cairo::Extend::Pad);
                        let _ = context.paint();
                    }
                    let _ = context.restore();
                }
                if frame.release_after_draw {
                    frame.previous = frame.image.take();
                    frame.release_after_draw = false;
                }
                Some(false.to_value())
            }
        });
        let configure = window.connect_configure_event({
            let view = view.downgrade();
            let frame = frame.clone();
            let capturing = capturing.clone();
            move |_, event| {
                let Some(view) = view.upgrade().filter(|view| view.is_mapped()) else {
                    return false;
                };
                let allocation = view.allocation();
                let old = (
                    allocation.width().max(0) as u32,
                    allocation.height().max(0) as u32,
                );
                let size = event.size();
                if frame
                    .borrow()
                    .prepared
                    .is_some_and(|(w, h)| size == (w as u32, h as u32))
                {
                    return false;
                }
                if size == old || frame.borrow().image.is_some() || old.0 <= 1 || old.1 <= 1 {
                    return false;
                }
                let previous = {
                    let frame = frame.borrow();
                    frame
                        .cache_until
                        .filter(|until| std::time::Instant::now() <= *until)
                        .and_then(|_| frame.previous.clone())
                };
                frame.borrow_mut().cache_until =
                    Some(std::time::Instant::now() + std::time::Duration::from_millis(200));
                if let Some(previous) = previous {
                    frame.borrow_mut().image = Some(previous);
                    return false;
                }
                let scale = view.scale_factor().max(1);
                if u64::from(old.0) * u64::from(old.1) * (scale as u64).pow(2) > 16_777_216 {
                    return false;
                }
                if let Ok(image) = gtk::cairo::ImageSurface::create(
                    gtk::cairo::Format::ARgb32,
                    allocation.width().saturating_mul(scale),
                    allocation.height().saturating_mul(scale),
                ) {
                    image.set_device_scale(f64::from(scale), f64::from(scale));
                    if let Ok(context) = gtk::cairo::Context::new(&image) {
                        // Growing windows still contain the old visible pixels.
                        // When shrinking, the native surface is already clipped;
                        // ask WebKit to draw its retained backing instead.
                        let pixels = if size.0 >= old.0 && size.1 >= old.1 {
                            view.window().and_then(|window| {
                                window.pixbuf(
                                    allocation.x(),
                                    allocation.y(),
                                    allocation.width(),
                                    allocation.height(),
                                )
                            })
                        } else {
                            None
                        };
                        if let Some(pixels) = pixels {
                            use gtk::gdk::prelude::GdkContextExt;
                            context.scale(
                                f64::from(allocation.width()) / f64::from(pixels.width()),
                                f64::from(allocation.height()) / f64::from(pixels.height()),
                            );
                            context.set_source_pixbuf(&pixels, 0.0, 0.0);
                            let _ = context.paint();
                        } else {
                            capturing.set(true);
                            view.draw(&context);
                            capturing.set(false);
                        }
                        frame.borrow_mut().image = Some(image);
                    }
                }
                false
            }
        });
        let allocate = view.connect_size_allocate({
            let frame = frame.clone();
            let active = active.clone();
            move |view, allocation| {
                if allocation.width() <= 0 || allocation.height() <= 0 {
                    return;
                }
                if frame.borrow().image.is_none() {
                    return;
                }
                let generation = {
                    let mut frame = frame.borrow_mut();
                    frame.generation = frame.generation.wrapping_add(1);
                    frame.release_after_draw = false;
                    if let Some(timeout) = frame.timeout.take() {
                        timeout.remove();
                    }
                    frame.generation
                };
                let width = allocation.width();
                let height = allocation.height();
                let weak = view.downgrade();
                let timeout_frame = frame.clone();
                let timeout_active = active.clone();
                let timeout_view = weak.clone();
                frame.borrow_mut().timeout = Some(gtk::glib::timeout_add_local_once(
                    std::time::Duration::from_millis(180),
                    move || {
                        let mut frame = timeout_frame.borrow_mut();
                        if frame.generation == generation {
                            frame.timeout.take();
                            frame.image = None;
                            frame.release_after_draw = false;
                            frame.generation = frame.generation.wrapping_add(1);
                            drop(frame);
                            if timeout_active.get() {
                                if let Some(view) = timeout_view.upgrade() {
                                    view.queue_draw();
                                }
                            }
                        }
                    },
                ));
                let frame = frame.clone();
                let active = active.clone();
                view.snapshot(
                    webkit2gtk::SnapshotRegion::Visible,
                    webkit2gtk::SnapshotOptions::NONE,
                    None::<&webkit2gtk::gio::Cancellable>,
                    move |reply| {
                        if !active.get() {
                            return;
                        }
                        let Ok(surface) = reply else {
                            return;
                        };
                        let Ok(image) = gtk::cairo::ImageSurface::try_from(surface) else {
                            return;
                        };
                        let mut frame = frame.borrow_mut();
                        if frame.generation != generation {
                            return;
                        }
                        if let Some(timeout) = frame.timeout.take() {
                            timeout.remove();
                        }
                        image.set_device_scale(
                            f64::from(image.width()) / f64::from(width),
                            f64::from(image.height()) / f64::from(height),
                        );
                        frame.image = Some(image);
                        frame.release_after_draw = true;
                        drop(frame);
                        if let Some(view) = weak.upgrade() {
                            view.queue_draw();
                        }
                    },
                );
            }
        });
        let widget: gtk::Widget = view.clone().upcast();
        let parent: gtk::Widget = window.upcast();
        entries.insert(
            label.into(),
            ResizeObserver {
                handlers: vec![
                    (widget.downgrade(), draw),
                    (widget.downgrade(), allocate),
                    (parent.downgrade(), configure),
                    (view.parent().unwrap().downgrade(), parent_allocate),
                ],
                frame,
                active,
            },
        );
    });
}
fn copy_painted_frame(
    view: &webkit2gtk::WebView,
    context: &gtk::cairo::Context,
) -> Option<gtk::cairo::ImageSurface> {
    let allocation = view.allocation();
    let scale = view.scale_factor().max(1);
    let width = allocation.width().checked_mul(scale)?;
    let height = allocation.height().checked_mul(scale)?;
    if width <= 0
        || height <= 0
        || u64::try_from(width).ok()? * u64::try_from(height).ok()? > 16_777_216
    {
        return None;
    }
    let image = gtk::cairo::ImageSurface::create(gtk::cairo::Format::ARgb32, width, height).ok()?;
    image.set_device_scale(f64::from(scale), f64::from(scale));
    let copy = gtk::cairo::Context::new(&image).ok()?;
    copy.set_source_surface(context.target(), 0.0, 0.0).ok()?;
    copy.paint().ok()?;
    Some(image)
}

pub(super) fn fit(
    view: &impl IsA<gtk::Widget>,
    width: i32,
    height: i32,
) -> Result<bool, &'static str> {
    let view = view.as_ref();
    let parent = view
        .parent()
        .and_then(|parent| parent.downcast::<gtk::Box>().ok())
        .ok_or("Unexpected main WebKitGTK container")?;
    // Let GTK distribute the entire client area during its native allocation
    // phase. Imposing a size request here would prevent subsequent shrinking.
    if !view.hexpands() {
        view.set_hexpand(true);
    }
    if !view.vexpands() {
        view.set_vexpand(true);
    }
    if view.halign() != gtk::Align::Fill {
        view.set_halign(gtk::Align::Fill);
    }
    if view.valign() != gtk::Align::Fill {
        view.set_valign(gtk::Align::Fill);
    }
    let (expand, fill, padding, _) = parent.query_child_packing(view);
    if !expand || !fill || padding != 0 {
        parent.set_child_packing(view, true, true, 0, gtk::PackType::Start);
    }
    let allocation = view.allocation();
    let ready = width > 0
        && height > 0
        && allocation.x() == 0
        && allocation.y() == 0
        && allocation.width() == width
        && allocation.height() == height;
    if !ready {
        // A configure event may precede GTK's allocation. Request that native
        // pass; do not force an obsolete window size into the child widget.
        parent.queue_resize();
    }
    Ok(ready)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spin_until(ready: impl Fn() -> bool) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !ready() {
            while gtk::events_pending() {
                gtk::main_iteration_do(false);
            }
            assert!(
                std::time::Instant::now() < deadline,
                "WebKit did not present its viewport"
            );
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }

    fn green_edge(window: &gtk::Window) -> bool {
        let (width, height) = window.size();
        window
            .window()
            .and_then(|surface| surface.pixbuf(width - 1, height - 1, 1, 1))
            .is_some_and(|pixel| {
                let bytes = pixel.read_pixel_bytes();
                let color = bytes.as_ref();
                color.len() >= 3 && color[1] > 180 && u16::from(color[1]) > u16::from(color[0]) + 40
            })
    }

    #[test]
    #[ignore = "Requires a Linux WebKitGTK display; CI runs this test under Xvfb"]
    fn webkit_resize_retains_painted_edges_until_new_frames_arrive() {
        gtk::init().expect("GTK display unavailable");
        let window = gtk::Window::new(gtk::WindowType::Toplevel);
        let container = gtk::Box::new(gtk::Orientation::Vertical, 0);
        let view = webkit2gtk::WebView::new();
        container.pack_start(&view, true, true, 0);
        window.add(&container);
        window.resize(880, 540);
        window.show_all();
        view.load_html("<html><style>html,body{margin:0;width:100%;height:100%;box-sizing:border-box;background:#282a3b}body{border:12px solid #20e070}header{height:38px;background:#403350}aside{width:270px;height:calc(100% - 38px);background:#242533}</style><body><header>Project</header><aside>Files</aside></body></html>", None);
        spin_until(|| green_edge(&window));
        observe(&view, "resize-test");
        let blank = Rc::new(Cell::new(0));
        let gap = Rc::new(Cell::new(0));
        let longest = Rc::new(Cell::new(0));
        let sampled = Rc::new(Cell::new(0));
        let clock = window.frame_clock().unwrap();
        let listener = clock.connect_after_paint({
            let weak = window.downgrade();
            let blank = blank.clone();
            let gap = gap.clone();
            let longest = longest.clone();
            let sampled = sampled.clone();
            move |_| {
                if let Some(window) = weak.upgrade() {
                    sampled.set(sampled.get() + 1);
                    if !green_edge(&window) {
                        blank.set(blank.get() + 1);
                        gap.set(gap.get() + 1);
                        longest.set(longest.get().max(gap.get()));
                    } else {
                        gap.set(0);
                    }
                }
            }
        });
        for (width, height) in [
            (1600, 900),
            (880, 540),
            (1200, 760),
            (1800, 1000),
            (880, 540),
        ] {
            window.resize(width, height);
            spin_until(|| fit(&view, width, height).unwrap());
            spin_until(|| {
                OBSERVERS.with(|entries| {
                    entries
                        .borrow()
                        .get("resize-test")
                        .unwrap()
                        .frame
                        .borrow()
                        .image
                        .is_none()
                })
            });
            let finished = Rc::new(Cell::new(false));
            let result = finished.clone();
            view.evaluate_javascript(
                &format!("if (Math.abs(innerWidth-{width})>1 || Math.abs(innerHeight-{height})>1) throw new Error('Stale viewport'); true"),
                None, None,
                None::<&webkit2gtk::gio::Cancellable>, move |reply| { assert!(reply.is_ok()); result.set(true); },
            );
            spin_until(|| finished.get());
        }
        clock.disconnect(listener);
        forget("resize-test");
        assert!(sampled.get() >= 5, "Must sample intermediate presentations");
        assert!(
            longest.get() <= 1,
            "Resize exposed {} consecutive empty frames ({} total)",
            longest.get(),
            blank.get()
        );
        assert!(OBSERVERS.with(|entries| !entries.borrow().contains_key("resize-test")));
        window.close();
    }

    #[test]
    #[ignore = "Requires a Linux GTK display; run under Xvfb"]
    fn main_view_follows_gtk_allocation_when_growing_and_shrinking() {
        gtk::init().expect("GTK display unavailable");
        let window = gtk::Window::new(gtk::WindowType::Toplevel);
        let container = gtk::Box::new(gtk::Orientation::Vertical, 0);
        let view = gtk::DrawingArea::new();
        container.pack_start(&view, false, false, 8);
        view.set_halign(gtk::Align::Start);
        view.set_valign(gtk::Align::Start);
        window.add(&container);
        window.show_all();
        assert!(!fit(&view, 1200, 760).unwrap());
        for (width, height) in [(1200, 760), (880, 540), (1600, 1000), (800, 480)] {
            window.resize(width, height);
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            loop {
                while gtk::events_pending() {
                    gtk::main_iteration_do(false);
                }
                if fit(&view, width, height).unwrap() {
                    break;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "GTK did not fit {width}x{height}"
                );
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            assert_eq!(window.size(), (width, height));
            assert_eq!(view.size_request(), (-1, -1));
        }
        assert!(!fit(&view, 0, 0).unwrap());
        window.close();
    }
}
