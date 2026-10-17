use crate::core::AppCore;
use std::sync::Arc;

#[cfg(windows)]
pub fn register_emergency(core: Arc<AppCore>) {
    std::thread::spawn(move || unsafe {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
            RegisterHotKey, UnregisterHotKey, MOD_CONTROL, MOD_SHIFT, VK_F10,
        };
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetMessageW, MSG, WM_HOTKEY};
        const ID: i32 = 0x5A59;
        if RegisterHotKey(std::ptr::null_mut(), ID, MOD_CONTROL | MOD_SHIFT, VK_F10 as u32) == 0 { return; }
        let mut message: MSG = std::mem::zeroed();
        while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 { if message.message == WM_HOTKEY && message.wParam == ID as usize { core.emergency_stop(); } }
        UnregisterHotKey(std::ptr::null_mut(), ID);
    });
}

#[cfg(not(windows))]
pub fn register_emergency(_: Arc<AppCore>) {}
