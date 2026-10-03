/// Keep changed rows and bounded neighboring context, retaining original line coordinates.
/// The caller fingerprints the full Diff before compacting it.
pub fn compact(diff: &str) -> String {
    let lines: Vec<_> = diff.lines().collect();
    let mut output = String::new();
    let mut index = 0;
    while index < lines.len() {
        let header = lines[index];
        if !header.starts_with("@@ ") {
            output.push_str(header);
            output.push('\n');
            index += 1;
            continue;
        }
        let mut fields = header.split_whitespace();
        fields.next();
        let coordinate = |s: Option<&str>| {
            s.and_then(|s| s.get(1..))
                .and_then(|s| s.split(',').next())
                .and_then(|s| s.parse::<u32>().ok())
                .unwrap_or(0)
        };
        let mut old = coordinate(fields.next());
        let mut new = coordinate(fields.next());
        let suffix = header.split("@@").nth(2).unwrap_or("");
        index += 1;
        let mut rows = Vec::new();
        while index < lines.len()
            && !lines[index].starts_with("@@ ")
            && !lines[index].starts_with("diff --")
        {
            let text = lines[index];
            let old_count = u32::from(text.starts_with(' ') || text.starts_with('-'));
            let new_count = u32::from(text.starts_with(' ') || text.starts_with('+'));
            rows.push((text, old, new, old_count, new_count));
            old += old_count;
            new += new_count;
            index += 1;
        }
        let mut included = vec![false; rows.len()];
        for (i, row) in rows
            .iter()
            .enumerate()
            .filter(|(_, r)| r.0.starts_with('+') || r.0.starts_with('-'))
        {
            let _ = row;
            for include in included
                .iter_mut()
                .take((i + 4).min(rows.len()))
                .skip(i.saturating_sub(3))
            {
                *include = true;
            }
        }
        let mut start = 0;
        while start < rows.len() {
            if !included[start] {
                start += 1;
                continue;
            }
            let mut end = start + 1;
            while end < rows.len() && included[end] {
                end += 1;
            }
            let old_count: u32 = rows[start..end].iter().map(|r| r.3).sum();
            let new_count: u32 = rows[start..end].iter().map(|r| r.4).sum();
            let old_start = if old_count == 0 {
                rows[start].1.saturating_sub(1)
            } else {
                rows[start].1
            };
            let new_start = if new_count == 0 {
                rows[start].2.saturating_sub(1)
            } else {
                rows[start].2
            };
            output.push_str(&format!(
                "@@ -{old_start},{old_count} +{new_start},{new_count} @@{suffix}\n"
            ));
            for row in &rows[start..end] {
                output.push_str(row.0);
                output.push('\n');
            }
            start = end;
        }
    }
    output
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn late_changes_are_preserved_with_original_coordinates() {
        let mut diff = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,1000 +1,1000 @@\n".to_string();
        for line in 1..=1000 {
            if line == 990 {
                diff.push_str("-old\n+new\n");
            } else {
                diff.push_str(&format!(" line {line}\n"));
            }
        }
        let text = compact(&diff);
        assert!(text.contains("@@ -987,7 +987,7 @@"));
        assert!(text.contains("-old\n+new"));
        assert!(text.lines().count() < 20);
    }
    #[test]
    fn insertions_and_deletions_retain_zero_count_ranges() {
        assert_eq!(
            compact("@@ -0,0 +1,2 @@\n+a\n+b\n"),
            "@@ -0,0 +1,2 @@\n+a\n+b\n"
        );
        assert_eq!(
            compact("@@ -1,2 +0,0 @@\n-a\n-b\n"),
            "@@ -1,2 +0,0 @@\n-a\n-b\n"
        );
    }
}
