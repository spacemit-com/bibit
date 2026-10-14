//! Native (non-webview) text: tray menu items and popup window titles.
//!
//! The webview owns the resolved language and pushes it here on load and on
//! change (`set_tray_language`); before that push the labels stay Chinese, which
//! is what this side shipped with.

use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Labels {
    pub toggle_voice_ball: &'static str,
    pub open_main: &'static str,
    pub quit: &'static str,
    pub voice_overlay_title: &'static str,
    pub quick_chat_title: &'static str,
}

const ZH_CN: Labels = Labels {
    toggle_voice_ball: "显示/隐藏悬浮球",
    open_main: "打开主窗口",
    quit: "退出 BiBit",
    voice_overlay_title: "BiBit 输入弹窗",
    quick_chat_title: "BiBit 快速对话",
};

const EN: Labels = Labels {
    toggle_voice_ball: "Show / Hide Floating Ball",
    open_main: "Open Main Window",
    quit: "Quit BiBit",
    voice_overlay_title: "BiBit Voice Input",
    quick_chat_title: "BiBit Quick Chat",
};

static ENGLISH: AtomicBool = AtomicBool::new(false);

/// Map a BCP-47 tag onto the labels this side can render.
pub fn labels_for(language: &str) -> Labels {
    if language.trim().to_ascii_lowercase().starts_with("zh") {
        ZH_CN
    } else {
        EN
    }
}

pub fn set_language(language: &str) {
    ENGLISH.store(labels_for(language) == EN, Ordering::Relaxed);
}

pub fn current() -> Labels {
    if ENGLISH.load(Ordering::Relaxed) {
        EN
    } else {
        ZH_CN
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chinese_tags_keep_chinese_labels() {
        for tag in ["zh", "zh-CN", "zh-TW", " zh_CN "] {
            assert_eq!(labels_for(tag), ZH_CN, "tag={tag} 应走中文");
        }
    }

    #[test]
    fn every_other_language_falls_back_to_english() {
        for tag in ["en", "en-US", "", "fr-FR", "ja"] {
            assert_eq!(labels_for(tag), EN, "tag={tag} 应走英文");
        }
    }
}
