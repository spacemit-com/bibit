use gtk::{glib::translate::ToGlibPtr, prelude::*};
use libloading::Library;
use std::{ffi::CString, os::raw::c_char};

pub const LAYER_SHELL_SONAME: &str = "libgtk-layer-shell.so.0";

const LAYER_OVERLAY: i32 = 3;
pub const EDGE_LEFT: i32 = 0;
pub const EDGE_RIGHT: i32 = 1;
pub const EDGE_TOP: i32 = 2;
pub const EDGE_BOTTOM: i32 = 3;
const KEYBOARD_ON_DEMAND: i32 = 2;

type IsSupported = unsafe extern "C" fn() -> gtk::glib::ffi::gboolean;
type InitForWindow = unsafe extern "C" fn(*mut gtk::ffi::GtkWindow);
type SetNamespace = unsafe extern "C" fn(*mut gtk::ffi::GtkWindow, *const c_char);
type SetInt = unsafe extern "C" fn(*mut gtk::ffi::GtkWindow, i32);
type SetAnchor = unsafe extern "C" fn(*mut gtk::ffi::GtkWindow, i32, gtk::glib::ffi::gboolean);
type SetMargin = unsafe extern "C" fn(*mut gtk::ffi::GtkWindow, i32, i32);
type SetMonitor = unsafe extern "C" fn(*mut gtk::ffi::GtkWindow, *mut gtk::gdk::ffi::GdkMonitor);

pub struct GtkLayerShellBridge {
    _library: Library,
    is_supported: IsSupported,
    init_for_window: InitForWindow,
    set_namespace: SetNamespace,
    set_layer: SetInt,
    set_anchor: SetAnchor,
    set_margin: SetMargin,
    set_monitor: SetMonitor,
    set_exclusive_zone: SetInt,
    set_keyboard_mode: SetInt,
}

impl GtkLayerShellBridge {
    pub fn load() -> Result<Self, String> {
        unsafe {
            let library = Library::new(LAYER_SHELL_SONAME)
                .map_err(|error| format!("无法加载 {LAYER_SHELL_SONAME}: {error}"))?;
            let is_supported = load_symbol(&library, b"gtk_layer_is_supported\0")?;
            let init_for_window = load_symbol(&library, b"gtk_layer_init_for_window\0")?;
            let set_namespace = load_symbol(&library, b"gtk_layer_set_namespace\0")?;
            let set_layer = load_symbol(&library, b"gtk_layer_set_layer\0")?;
            let set_anchor = load_symbol(&library, b"gtk_layer_set_anchor\0")?;
            let set_margin = load_symbol(&library, b"gtk_layer_set_margin\0")?;
            let set_monitor = load_symbol(&library, b"gtk_layer_set_monitor\0")?;
            let set_exclusive_zone = load_symbol(&library, b"gtk_layer_set_exclusive_zone\0")?;
            let set_keyboard_mode = load_symbol(&library, b"gtk_layer_set_keyboard_mode\0")?;

            Ok(Self {
                _library: library,
                is_supported,
                init_for_window,
                set_namespace,
                set_layer,
                set_anchor,
                set_margin,
                set_monitor,
                set_exclusive_zone,
                set_keyboard_mode,
            })
        }
    }

    pub fn is_supported(&self) -> bool {
        unsafe { (self.is_supported)() != gtk::glib::ffi::GFALSE }
    }

    pub fn initialize(&self, window: &gtk::ApplicationWindow) -> Result<(), String> {
        if !gtk::is_initialized_main_thread() {
            return Err("GTK Layer Shell 初始化必须在 GTK 主线程执行".to_owned());
        }
        if window.is_realized() {
            return Err("GTK 窗口已经 realize，不能再挂载 Layer Shell".to_owned());
        }
        if !self.is_supported() {
            return Err("当前 Wayland 合成器不支持 GTK Layer Shell".to_owned());
        }

        let namespace = CString::new("bibit-status-popup")
            .map_err(|error| format!("Layer Shell namespace 无效: {error}"))?;
        let app_window_ptr: *mut gtk::ffi::GtkApplicationWindow = window.to_glib_none().0;
        let window_ptr = app_window_ptr.cast::<gtk::ffi::GtkWindow>();

        unsafe {
            (self.init_for_window)(window_ptr);
            (self.set_namespace)(window_ptr, namespace.as_ptr());
            (self.set_layer)(window_ptr, LAYER_OVERLAY);
            (self.set_anchor)(window_ptr, EDGE_LEFT, gtk::glib::ffi::GFALSE);
            (self.set_anchor)(window_ptr, EDGE_RIGHT, gtk::glib::ffi::GTRUE);
            (self.set_anchor)(window_ptr, EDGE_TOP, gtk::glib::ffi::GFALSE);
            (self.set_anchor)(window_ptr, EDGE_BOTTOM, gtk::glib::ffi::GTRUE);
            (self.set_exclusive_zone)(window_ptr, 0);
            (self.set_keyboard_mode)(window_ptr, KEYBOARD_ON_DEMAND);
        }

        Ok(())
    }

    pub fn set_margins(
        &self,
        window: &gtk::ApplicationWindow,
        right_margin: i32,
        bottom_margin: i32,
    ) -> Result<(), String> {
        if !gtk::is_initialized_main_thread() {
            return Err("GTK Layer Shell 边距更新必须在 GTK 主线程执行".to_owned());
        }

        let app_window_ptr: *mut gtk::ffi::GtkApplicationWindow = window.to_glib_none().0;
        let window_ptr = app_window_ptr.cast::<gtk::ffi::GtkWindow>();
        unsafe {
            (self.set_margin)(window_ptr, EDGE_LEFT, 0);
            (self.set_margin)(window_ptr, EDGE_RIGHT, right_margin.max(0));
            (self.set_margin)(window_ptr, EDGE_TOP, 0);
            (self.set_margin)(window_ptr, EDGE_BOTTOM, bottom_margin.max(0));
        }
        window.queue_resize();
        Ok(())
    }

    pub fn set_anchor_edge(
        &self,
        window: &gtk::ApplicationWindow,
        edge: i32,
        anchor: bool,
    ) -> Result<(), String> {
        if !gtk::is_initialized_main_thread() {
            return Err("GTK Layer Shell anchor 更新必须在 GTK 主线程执行".to_owned());
        }
        let app_window_ptr: *mut gtk::ffi::GtkApplicationWindow = window.to_glib_none().0;
        let window_ptr = app_window_ptr.cast::<gtk::ffi::GtkWindow>();
        unsafe {
            (self.set_anchor)(
                window_ptr,
                edge,
                if anchor { gtk::glib::ffi::GTRUE } else { gtk::glib::ffi::GFALSE },
            );
        }
        Ok(())
    }

    pub fn set_monitor(
        &self,
        window: &gtk::ApplicationWindow,
        monitor: &gtk::gdk::Monitor,
    ) -> Result<(), String> {
        if !gtk::is_initialized_main_thread() {
            return Err("GTK Layer Shell 显示器更新必须在 GTK 主线程执行".to_owned());
        }
        let app_window_ptr: *mut gtk::ffi::GtkApplicationWindow = window.to_glib_none().0;
        let window_ptr = app_window_ptr.cast::<gtk::ffi::GtkWindow>();
        let monitor_ptr: *mut gtk::gdk::ffi::GdkMonitor = monitor.to_glib_none().0;
        unsafe { (self.set_monitor)(window_ptr, monitor_ptr) };
        Ok(())
    }
}

unsafe fn load_symbol<T: Copy>(library: &Library, symbol: &[u8]) -> Result<T, String> {
    library
        .get::<T>(symbol)
        .map(|symbol| *symbol)
        .map_err(|error| {
            let name = String::from_utf8_lossy(symbol)
                .trim_end_matches('\0')
                .to_owned();
            format!("无法解析 {name}: {error}")
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layer_shell_constants_match_gtk_header() {
        assert_eq!(LAYER_OVERLAY, 3);
        assert_eq!(EDGE_RIGHT, 1);
        assert_eq!(EDGE_BOTTOM, 3);
        assert_eq!(KEYBOARD_ON_DEMAND, 2);
    }

    #[test]
    fn runtime_library_candidate_uses_soname() {
        assert_eq!(LAYER_SHELL_SONAME, "libgtk-layer-shell.so.0");
    }
}
