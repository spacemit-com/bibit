#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

impl Point {
    pub const fn new(x: i32, y: i32) -> Self {
        Self { x, y }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Size {
    pub width: i32,
    pub height: i32,
}

impl Size {
    pub const fn new(width: i32, height: i32) -> Self {
        Self { width, height }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl Rect {
    pub const fn new(x: i32, y: i32, width: i32, height: i32) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ScreenGeometry {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub primary: bool,
}

impl ScreenGeometry {
    fn contains(self, point: Point) -> bool {
        let point_x = i64::from(point.x);
        let point_y = i64::from(point.y);
        let left = i64::from(self.x);
        let top = i64::from(self.y);
        let right = left + i64::from(self.width);
        let bottom = top + i64::from(self.height);

        self.width > 0
            && self.height > 0
            && point_x >= left
            && point_x < right
            && point_y >= top
            && point_y < bottom
    }

    fn distance_squared(self, point: Point) -> i64 {
        let point_x = i64::from(point.x);
        let point_y = i64::from(point.y);
        let left = i64::from(self.x);
        let top = i64::from(self.y);
        let right = left + i64::from(self.width.max(0));
        let bottom = top + i64::from(self.height.max(0));

        let dx = if point_x < left {
            left - point_x
        } else if point_x > right {
            point_x - right
        } else {
            0
        };
        let dy = if point_y < top {
            top - point_y
        } else if point_y > bottom {
            point_y - bottom
        } else {
            0
        };

        dx.saturating_mul(dx).saturating_add(dy.saturating_mul(dy))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PopupPlacement {
    pub screen_index: usize,
    pub right_margin: i32,
    pub bottom_margin: i32,
}

pub fn restore_popup_placement(
    screens: &[ScreenGeometry],
    preferred_screen: usize,
    popup_size: Size,
    right_margin: i32,
    bottom_margin: i32,
) -> Option<PopupPlacement> {
    let screen_index = screens
        .get(preferred_screen)
        .filter(|screen| screen.width > 0 && screen.height > 0)
        .map(|_| preferred_screen)
        .or_else(|| {
            screens
                .iter()
                .position(|screen| screen.primary && screen.width > 0 && screen.height > 0)
        })
        .or_else(|| {
            screens
                .iter()
                .position(|screen| screen.width > 0 && screen.height > 0)
        })?;
    let screen = screens[screen_index];
    Some(PopupPlacement {
        screen_index,
        right_margin: right_margin.clamp(0, (screen.width - popup_size.width).max(0)),
        bottom_margin: bottom_margin.clamp(0, (screen.height - popup_size.height).max(0)),
    })
}

pub fn resolve_popup_placement(
    screens: &[ScreenGeometry],
    ref_pos: Option<Point>,
    popup_width: i32,
    gap_right: i32,
    gap_bottom: i32,
) -> Option<PopupPlacement> {
    let screen_index = match ref_pos {
        Some(point) => screens
            .iter()
            .position(|screen| screen.contains(point))
            .or_else(|| {
                screens
                    .iter()
                    .enumerate()
                    .filter(|(_, screen)| screen.width > 0 && screen.height > 0)
                    .min_by_key(|(_, screen)| screen.distance_squared(point))
                    .map(|(index, _)| index)
            }),
        None => screens
            .iter()
            .position(|screen| screen.primary && screen.width > 0 && screen.height > 0)
            .or_else(|| {
                screens
                    .iter()
                    .position(|screen| screen.width > 0 && screen.height > 0)
            }),
    }?;

    let screen = screens[screen_index];
    let right_margin = ref_pos
        .map(|point| {
            let screen_right = i64::from(screen.x) + i64::from(screen.width);
            let desired = i64::from(gap_right)
                .max(screen_right - i64::from(point.x) - i64::from(popup_width.max(0)) / 2);
            let max_margin =
                i64::from((screen.width - popup_width.max(0) - gap_right).max(gap_right));
            desired.min(max_margin).clamp(0, i64::from(i32::MAX)) as i32
        })
        .unwrap_or(gap_right.max(0));

    Some(PopupPlacement {
        screen_index,
        right_margin,
        bottom_margin: gap_bottom.max(0),
    })
}

pub fn x11_top_left(
    work_area: Rect,
    popup_size: Size,
    right_margin: i32,
    bottom_margin: i32,
) -> Point {
    let min_x = i64::from(work_area.x);
    let min_y = i64::from(work_area.y);
    let max_x = (min_x + i64::from(work_area.width) - i64::from(popup_size.width)).max(min_x);
    let max_y = (min_y + i64::from(work_area.height) - i64::from(popup_size.height)).max(min_y);
    let desired_x =
        min_x + i64::from(work_area.width) - i64::from(popup_size.width) - i64::from(right_margin);
    let desired_y = min_y + i64::from(work_area.height)
        - i64::from(popup_size.height)
        - i64::from(bottom_margin);

    Point::new(
        desired_x.clamp(min_x, max_x) as i32,
        desired_y.clamp(min_y, max_y) as i32,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn screens() -> Vec<ScreenGeometry> {
        vec![
            ScreenGeometry {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
                primary: true,
            },
            ScreenGeometry {
                x: 1920,
                y: 0,
                width: 2560,
                height: 1440,
                primary: false,
            },
        ]
    }

    #[test]
    fn resolves_right_screen_and_centers_on_activation_x() {
        let result =
            resolve_popup_placement(&screens(), Some(Point::new(4300, 1438)), 420, 16, 8).unwrap();
        assert_eq!(result.screen_index, 1);
        assert_eq!(result.right_margin, 16);
        assert_eq!(result.bottom_margin, 8);
    }

    #[test]
    fn out_of_bounds_top_point_uses_nearest_rectangle() {
        let result =
            resolve_popup_placement(&screens(), Some(Point::new(2500, -3)), 420, 16, 8).unwrap();
        assert_eq!(result.screen_index, 1);
        assert_eq!(result.right_margin, 1770);
    }

    #[test]
    fn negative_x_monitor_is_selected_without_primary_fallback() {
        let input = vec![
            ScreenGeometry {
                x: -1280,
                y: 0,
                width: 1280,
                height: 1024,
                primary: false,
            },
            ScreenGeometry {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
                primary: true,
            },
        ];
        assert_eq!(
            resolve_popup_placement(&input, Some(Point::new(-30, 1000)), 420, 16, 8)
                .unwrap()
                .screen_index,
            0
        );
    }

    #[test]
    fn missing_reference_uses_primary_with_default_gaps() {
        let result = resolve_popup_placement(&screens(), None, 420, 16, 8).unwrap();
        assert_eq!(result.screen_index, 0);
        assert_eq!((result.right_margin, result.bottom_margin), (16, 8));
    }

    #[test]
    fn horizontal_margin_keeps_popup_inside_target_screen() {
        let result =
            resolve_popup_placement(&screens(), Some(Point::new(1920, 720)), 420, 16, 8).unwrap();
        assert_eq!(result.screen_index, 1);
        assert_eq!(result.right_margin, 2124);
    }

    #[test]
    fn x11_top_left_is_clamped_to_work_area() {
        let work_area = Rect::new(1920, 24, 2560, 1376);
        assert_eq!(
            x11_top_left(work_area, Size::new(420, 600), 3000, 8),
            Point::new(1920, 792)
        );
    }

    #[test]
    fn saved_placement_falls_back_from_removed_screen_and_stays_visible() {
        let result =
            restore_popup_placement(&screens()[..1], 1, Size::new(600, 800), 5_000, 5_000).unwrap();
        assert_eq!(result.screen_index, 0);
        assert_eq!(result.right_margin, 1_320);
        assert_eq!(result.bottom_margin, 280);
    }

    #[test]
    fn saved_placement_uses_valid_requested_screen() {
        let result = restore_popup_placement(&screens(), 1, Size::new(420, 600), 120, 80).unwrap();
        assert_eq!(result.screen_index, 1);
        assert_eq!((result.right_margin, result.bottom_margin), (120, 80));
    }
}
