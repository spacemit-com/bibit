use super::placement::Point;

pub const FOCUS_LOSS_SUPPRESSION_MS: u64 = 300;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PopupLifecycle {
    #[default]
    NotCreated,
    Hidden,
    Visible,
    DegradedHidden,
    DegradedVisible,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PopupDecision {
    CreateAndShow,
    Show,
    Hide,
    Ignore,
}

#[derive(Debug, Default)]
pub struct PopupState {
    lifecycle: PopupLifecycle,
    last_ref_pos: Option<Point>,
    last_focus_loss_hide_ms: Option<u64>,
}

impl PopupState {
    pub fn activate(&mut self, now_ms: u64, ref_pos: Option<Point>) -> PopupDecision {
        if let Some(ref_pos) = ref_pos {
            self.last_ref_pos = Some(ref_pos);
        }

        if matches!(
            self.lifecycle,
            PopupLifecycle::Hidden | PopupLifecycle::DegradedHidden
        ) && self
            .last_focus_loss_hide_ms
            .is_some_and(|hidden_at| now_ms.saturating_sub(hidden_at) <= FOCUS_LOSS_SUPPRESSION_MS)
        {
            return PopupDecision::Ignore;
        }

        self.last_focus_loss_hide_ms = None;
        match self.lifecycle {
            PopupLifecycle::NotCreated => PopupDecision::CreateAndShow,
            PopupLifecycle::Hidden | PopupLifecycle::DegradedHidden => PopupDecision::Show,
            PopupLifecycle::Visible | PopupLifecycle::DegradedVisible => PopupDecision::Hide,
        }
    }

    pub fn focus_lost(&mut self, now_ms: u64) -> PopupDecision {
        if !matches!(
            self.lifecycle,
            PopupLifecycle::Visible | PopupLifecycle::DegradedVisible
        ) {
            return PopupDecision::Ignore;
        }

        self.last_focus_loss_hide_ms = Some(now_ms);
        self.mark_hidden();
        PopupDecision::Hide
    }

    pub fn mark_shown(&mut self, degraded: bool) {
        self.lifecycle = if degraded {
            PopupLifecycle::DegradedVisible
        } else {
            PopupLifecycle::Visible
        };
    }

    pub fn mark_hidden(&mut self) {
        self.lifecycle = match self.lifecycle {
            PopupLifecycle::DegradedHidden | PopupLifecycle::DegradedVisible => {
                PopupLifecycle::DegradedHidden
            }
            _ => PopupLifecycle::Hidden,
        };
    }

    pub fn lifecycle(&self) -> PopupLifecycle {
        self.lifecycle
    }

    pub fn last_ref_pos(&self) -> Option<Point> {
        self.last_ref_pos
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_activation_creates_and_shows_then_next_activation_hides() {
        let mut state = PopupState::default();
        assert_eq!(
            state.activate(1_000, Some(Point::new(100, 100))),
            PopupDecision::CreateAndShow
        );
        state.mark_shown(false);
        assert_eq!(
            state.activate(1_100, Some(Point::new(100, 100))),
            PopupDecision::Hide
        );
    }

    #[test]
    fn focus_loss_activation_within_300ms_is_suppressed() {
        let mut state = PopupState::default();
        state.mark_shown(false);
        assert_eq!(state.focus_lost(2_000), PopupDecision::Hide);
        assert_eq!(
            state.activate(2_299, Some(Point::new(10, 10))),
            PopupDecision::Ignore
        );
        assert_eq!(
            state.activate(2_300, Some(Point::new(10, 10))),
            PopupDecision::Ignore
        );
        assert_eq!(
            state.activate(2_301, Some(Point::new(10, 10))),
            PopupDecision::Show
        );
    }

    #[test]
    fn activation_keeps_negative_reference_coordinates() {
        let mut state = PopupState::default();
        state.activate(10, Some(Point::new(2500, -3)));
        assert_eq!(state.last_ref_pos(), Some(Point::new(2500, -3)));
    }

    #[test]
    fn degraded_lifecycle_is_preserved_when_hidden() {
        let mut state = PopupState::default();
        state.mark_shown(true);
        state.mark_hidden();
        assert_eq!(state.lifecycle(), PopupLifecycle::DegradedHidden);
        assert_eq!(state.activate(500, None), PopupDecision::Show);
    }
}
