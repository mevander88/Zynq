use crate::model::{CommandError, TargetWindow};

#[cfg(windows)]
mod platform {
    use super::*;
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::core::BOOL;
    use windows_sys::Win32::Foundation::{CloseHandle, HWND, LPARAM};
    use windows_sys::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows_sys::Win32::UI::WindowsAndMessaging::{EnumWindows, GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindow, IsWindowVisible};

    struct EnumContext { own_pid: u32, foreground: HWND, windows: Vec<TargetWindow> }

    pub fn list_targets() -> Vec<TargetWindow> {
        let mut context = EnumContext { own_pid: std::process::id(), foreground: unsafe { GetForegroundWindow() }, windows: Vec::new() };
        unsafe { EnumWindows(Some(enum_window), &mut context as *mut EnumContext as LPARAM); }
        context.windows.sort_by(|a, b| b.foreground.cmp(&a.foreground).then_with(|| a.title.to_lowercase().cmp(&b.title.to_lowercase())));
        context.windows.truncate(200);
        context.windows
    }

    unsafe extern "system" fn enum_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let context = &mut *(lparam as *mut EnumContext);
        if IsWindowVisible(hwnd) == 0 { return 1; }
        let length = GetWindowTextLengthW(hwnd);
        if length <= 0 || length > 512 { return 1; }
        let mut buffer = vec![0u16; length as usize + 1];
        let read = GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32);
        if read <= 0 { return 1; }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == 0 || pid == context.own_pid { return 1; }
        let title = OsString::from_wide(&buffer[..read as usize]).to_string_lossy().trim().to_string();
        if title.is_empty() { return 1; }
        context.windows.push(TargetWindow { hwnd: hwnd as usize, pid, title, process_name: process_name(pid), foreground: hwnd == context.foreground });
        1
    }

    fn process_name(pid: u32) -> String {
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() { return format!("PID {pid}"); }
            let mut buffer = vec![0u16; 1024];
            let mut size = buffer.len() as u32;
            let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, buffer.as_mut_ptr(), &mut size);
            CloseHandle(handle);
            if ok == 0 { return format!("PID {pid}"); }
            let path = OsString::from_wide(&buffer[..size as usize]).to_string_lossy().to_string();
            path.rsplit(['\\', '/']).next().unwrap_or(&path).to_string()
        }
    }

    pub fn resolve_target(hwnd_value: usize) -> Result<TargetWindow, CommandError> {
        let item = list_targets().into_iter().find(|item| item.hwnd == hwnd_value).ok_or_else(|| CommandError::new("TARGET_NOT_FOUND", "Jendela target tidak lagi tersedia. Pindai ulang jendela."))?;
        Ok(item)
    }

    pub fn is_target_foreground(target: &TargetWindow) -> bool {
        unsafe {
            let hwnd = target.hwnd as HWND;
            if IsWindow(hwnd) == 0 || GetForegroundWindow() != hwnd { return false; }
            let mut pid = 0;
            GetWindowThreadProcessId(hwnd, &mut pid);
            pid == target.pid
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::*;
    pub fn list_targets() -> Vec<TargetWindow> { vec![] }
    pub fn resolve_target(_: usize) -> Result<TargetWindow, CommandError> { Err(CommandError::new("UNSUPPORTED_PLATFORM", "Target window hanya tersedia di Windows.")) }
    pub fn is_target_foreground(_: &TargetWindow) -> bool { false }
}

pub use platform::*;
