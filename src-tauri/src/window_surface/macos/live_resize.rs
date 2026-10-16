use std::cell::Cell;

/// Per-window guard for the native resize notification's nested run loop.
/// A timed-out callback owns its own result cell and cannot resume this gate.
pub(super) struct LiveResize {
    active: Cell<bool>,
    busy: Cell<bool>,
    suspended: Cell<bool>,
    generation: Cell<u64>,
}

impl Default for LiveResize {
    fn default() -> Self {
        Self {
            active: Cell::new(true),
            busy: Cell::new(false),
            suspended: Cell::new(false),
            generation: Cell::new(0),
        }
    }
}

impl LiveResize {
    pub fn start(&self) {
        self.generation.set(self.generation.get().wrapping_add(1));
        self.suspended.set(false);
    }

    pub fn active(&self) -> bool {
        self.active.get()
    }

    pub fn presenting(&self) -> bool {
        self.busy.get()
    }

    pub fn cancel(&self) {
        self.active.set(false);
    }

    pub fn begin(&self) -> Option<Frame<'_>> {
        if !self.active.get() || self.suspended.get() || self.busy.replace(true) {
            return None;
        }
        Some(Frame(self, self.generation.get()))
    }
}

pub(super) struct Frame<'a>(&'a LiveResize, u64);

impl Frame<'_> {
    pub fn complete(&self, presented: bool, still_resizing: bool) {
        if !presented && still_resizing && self.0.generation.get() == self.1 {
            self.0.suspended.set(true);
        }
    }
}

impl Drop for Frame<'_> {
    fn drop(&mut self) {
        self.0.busy.set(false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_nested_notification_cannot_start_another_frame_wait() {
        let resize = LiveResize::default();
        let frame = resize.begin().unwrap();
        assert!(resize.presenting());
        assert!(resize.begin().is_none());
        drop(frame);
        assert!(!resize.presenting());
        assert!(resize.begin().is_some());
    }

    #[test]
    fn an_unresponsive_renderer_is_only_waited_for_once_per_drag() {
        let resize = LiveResize::default();
        let frame = resize.begin().unwrap();
        frame.complete(false, true);
        drop(frame);
        assert!(resize.begin().is_none());
        resize.start();
        assert!(resize.begin().is_some());
    }

    #[test]
    fn ending_a_drag_while_waiting_does_not_suspend_the_next_titlebar_zoom() {
        let resize = LiveResize::default();
        let frame = resize.begin().unwrap();
        resize.start(); // AppKit's did-end notification can arrive in the wait.
        frame.complete(false, false);
        drop(frame);
        assert!(resize.begin().is_some());
    }

    #[test]
    fn a_late_timeout_from_the_previous_drag_cannot_suspend_a_new_resize() {
        let resize = LiveResize::default();
        let frame = resize.begin().unwrap();
        resize.start();
        frame.complete(false, true);
        drop(frame);
        assert!(resize.begin().is_some());
    }

    #[test]
    fn destroying_the_window_cancels_a_wait_and_cannot_be_restarted() {
        let resize = LiveResize::default();
        let frame = resize.begin().unwrap();
        resize.cancel();
        assert!(!resize.active());
        drop(frame);
        resize.start();
        assert!(resize.begin().is_none());
    }
}
