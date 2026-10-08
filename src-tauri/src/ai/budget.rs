use super::models::AiTask;

// Same conservative text estimate as the plugin's inputTokenBudget.ts.
pub fn tokens(text: &str) -> usize {
    let mut total = 0;
    let mut chars = text.chars().peekable();
    while let Some(first) = chars.next() {
        let kind = |c: char| {
            if c.is_ascii_alphanumeric() || c == '_' {
                0
            } else if (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}' {
                1
            } else {
                2
            }
        };
        let group = kind(first);
        let mut count = first.len_utf16();
        let mut ascii = first.is_ascii();
        while chars.peek().is_some_and(|c| kind(*c) == group) {
            let c = chars.next().unwrap();
            count += c.len_utf16();
            ascii &= c.is_ascii();
        }
        total += match group {
            0 => count.div_ceil(3),
            1 => count.div_ceil(4),
            _ if ascii => count.div_ceil(2),
            _ => count,
        };
    }
    total
}

pub fn input(max: u32) -> usize {
    let max = max as usize;
    max.saturating_sub((max / 20).clamp(64, 512)).max(1)
}

fn rounded(value: usize, minimum: usize, ceiling: u32) -> u32 {
    value
        .max(minimum)
        .div_ceil(256)
        .saturating_mul(256)
        .min(ceiling as usize) as u32
}

pub fn output(
    task: AiTask,
    prompt: &str,
    commits: usize,
    files: usize,
    unit_ids: &[&str],
    ceiling: u32,
) -> u32 {
    let input = tokens(prompt);
    let (estimate, minimum) = match task {
        AiTask::CommitMessage => (1024 + input.div_ceil(40), 2048),
        AiTask::CommitExplanation => (2048 + input.div_ceil(20) + commits * 256 + files * 64, 8192),
        AiTask::CodeReview => (2048 + (input * 6).div_ceil(100) + files * 192, 8192),
        AiTask::CommitComposer => (
            2048 + input.div_ceil(25) + tokens(&unit_ids.join("\n")) + unit_ids.len() * 160,
            8192,
        ),
        // Conflict evidence includes all three versions. Preserve Desktop's conservative bound.
        AiTask::MergeConflict => (input.saturating_mul(2).saturating_add(2048), 8192),
    };
    rounded(estimate, minimum, ceiling)
}

pub fn expanded(current: u32, ceiling: u32) -> u32 {
    rounded(
        (current as usize + 2048).max((current as usize * 3).div_ceil(2)),
        1024,
        ceiling,
    )
}

pub fn repair(prompt: &str, response: &str, minimum: usize, ceiling: u32) -> u32 {
    rounded(
        1024 + tokens(prompt).div_ceil(50) + (tokens(response) * 5).div_ceil(4),
        minimum,
        ceiling,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn budgets_preserve_plugin_headroom_and_user_limits() {
        for task in [
            AiTask::CommitExplanation,
            AiTask::CodeReview,
            AiTask::CommitComposer,
            AiTask::MergeConflict,
        ] {
            assert_eq!(output(task, "small diff", 1, 1, &["u1"], 128000), 8192);
            assert_eq!(output(task, "small diff", 1, 1, &["u1"], 1024), 1024);
        }
        assert_eq!(
            output(AiTask::CommitMessage, "small diff", 1, 1, &[], 128000),
            2048
        );
        assert_eq!(expanded(8192, 128000), 12288);
        assert_eq!(expanded(8192, 9000), 9000);
        assert_eq!(expanded(9000, 9000), 9000);
        let many_ids: Vec<_> = (0..100).map(|_| "unit-id").collect();
        assert!(output(AiTask::CommitComposer, "diff", 1, 1, &many_ids, 128000) > 8192);
    }

    #[test]
    fn token_estimate_covers_code_punctuation_unicode_and_request_reserve() {
        // Values verified against the plugin's actual estimateTokenCount implementation.
        assert_eq!(tokens("export const retries = 3;"), 14);
        assert_eq!(tokens("你好🌍"), 4);
        assert_eq!(tokens("a b c d e"), 9);
        assert_eq!(input(4096), 3892);
        assert_eq!(input(128000), 127488);
    }
}
