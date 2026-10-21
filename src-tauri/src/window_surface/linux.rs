//! Main WebKitGTK views follow their GTK Box allocation, not Wry's Fixed bounds.
use gtk::prelude::*;

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
