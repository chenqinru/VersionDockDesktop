use crate::models::LanguagePreference;

pub(crate) fn is_chinese(preference: &LanguagePreference) -> bool {
    is_chinese_for_locale(preference, tauri_plugin_os::locale().as_deref())
}

pub(crate) fn is_chinese_for_locale(preference: &LanguagePreference, locale: Option<&str>) -> bool {
    match preference {
        LanguagePreference::ZhCn => true,
        LanguagePreference::En => false,
        LanguagePreference::System => {
            locale.is_some_and(|value| value.trim().to_ascii_lowercase().starts_with("zh"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn follows_native_windows_ui_language_without_unix_locale_variables() {
        for locale in ["zh-CN", "zh-Hans-CN", "ZH-Hans", "zh-TW", "zh_HK"] {
            assert!(is_chinese_for_locale(
                &LanguagePreference::System,
                Some(locale)
            ));
        }
        for locale in [Some("en-US"), Some("de-DE"), None] {
            assert!(!is_chinese_for_locale(&LanguagePreference::System, locale));
        }
    }

    #[test]
    fn explicit_application_language_overrides_the_system() {
        assert!(is_chinese_for_locale(
            &LanguagePreference::ZhCn,
            Some("en-US")
        ));
        assert!(!is_chinese_for_locale(
            &LanguagePreference::En,
            Some("zh-CN")
        ));
    }
}
