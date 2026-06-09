#[cfg(any(target_os = "macos", test))]
#[allow(dead_code)]
#[derive(Debug, Clone, Copy)]
pub struct NativeStrings {
    pub app_menu: &'static str,
    pub about_comments: &'static str,
    pub edit_menu: &'static str,
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub undo: &'static str,
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub redo: &'static str,
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub cut: &'static str,
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub copy: &'static str,
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub paste: &'static str,
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub select_all: &'static str,
    pub view_menu: &'static str,
    pub window_menu: &'static str,
    pub toggle_sidebar: &'static str,
    pub toggle_git_panel: &'static str,
    pub toggle_focus_mode: &'static str,
    pub toggle_fullscreen: &'static str,
    pub search: &'static str,
    pub toggle_terminal: &'static str,
    pub close: &'static str,
}

#[cfg(any(target_os = "macos", test))]
pub fn native_strings() -> NativeStrings {
    NativeStrings {
        app_menu: "Panes",
        about_comments: "The open-source cockpit for AI-assisted coding",
        edit_menu: "Edit",
        undo: "Undo",
        redo: "Redo",
        cut: "Cut",
        copy: "Copy",
        paste: "Paste",
        select_all: "Select All",
        view_menu: "View",
        window_menu: "Window",
        toggle_sidebar: "Toggle Sidebar",
        toggle_git_panel: "Toggle Git Panel",
        toggle_focus_mode: "Toggle Focus Mode",
        toggle_fullscreen: "Toggle Full Screen",
        search: "Search Workspace",
        toggle_terminal: "Toggle Terminal",
        close: "Close",
    }
}

#[cfg(test)]
mod tests {
    use super::native_strings;

    #[test]
    fn returns_english_native_strings() {
        let strings = native_strings();

        assert_eq!(strings.edit_menu, "Edit");
        assert_eq!(strings.close, "Close");
    }
}
