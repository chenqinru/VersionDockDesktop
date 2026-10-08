use gtk::prelude::*;

// Called only on the GTK thread. Realizing allocates the native input surface
// without mapping the preview, so prewarming a tab never flashes a window.
pub fn prepare_cursor_passthrough(window: &impl IsA<gtk::Widget>) -> Result<(), &'static str> {
    window.realize();
    let surface = window
        .window()
        .ok_or("Unable to realize tab preview input surface")?;
    let region = gtk::cairo::Region::create_rectangle(&gtk::cairo::RectangleInt::new(0, 0, 1, 1));
    surface.input_shape_combine_region(&region, 0, 0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "Requires a Linux GTK display; CI runs this test under Xvfb"]
    fn hidden_preview_cursor_passthrough_preserves_visibility() {
        gtk::init().expect("GTK display unavailable");
        let window = gtk::Window::new(gtk::WindowType::Toplevel);
        assert!(!window.is_visible());
        assert!(window.window().is_none());

        prepare_cursor_passthrough(&window).unwrap();
        assert!(window.window().is_some());
        assert!(!window.is_visible());
        assert!(!window.is_mapped());

        window.show();
        assert!(window.is_visible());
        window.hide();
        prepare_cursor_passthrough(&window).unwrap();
        assert!(!window.is_visible());
        assert!(!window.is_mapped());
        window.close();
    }
}
