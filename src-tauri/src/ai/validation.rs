use super::{models::*, transport::error};
use crate::models::DesktopError;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
fn json_candidates(text: &str) -> Vec<Value> {
    let mut values = Vec::new();
    if let Ok(value) = serde_json::from_str(text.trim().trim_start_matches('\u{feff}')) {
        values.push(value);
    }
    let mut start = None;
    let mut closings = Vec::new();
    let mut in_string = false;
    let mut escaped = false;
    for (index, character) in text.char_indices() {
        if start.is_none() {
            if character == '{' || character == '[' {
                start = Some(index);
                closings.push(if character == '{' { '}' } else { ']' });
            }
            continue;
        }
        if in_string {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
            continue;
        }
        match character {
            '"' => in_string = true,
            '{' => closings.push('}'),
            '[' => closings.push(']'),
            '}' | ']' => {
                if closings.last() != Some(&character) {
                    start = None;
                    closings.clear();
                    continue;
                }
                closings.pop();
                if closings.is_empty() {
                    if let Ok(value) = serde_json::from_str(&text[start.unwrap()..index + 1]) {
                        values.push(value);
                    }
                    start = None;
                }
            }
            _ => {}
        }
    }
    values
}
pub fn json_response(text: &str) -> Result<Value, DesktopError> {
    let values = json_candidates(text);
    values
        .iter()
        .find(|value| {
            ["groups", "findings", "resolutions", "assignments"]
                .iter()
                .any(|key| value.get(key).is_some())
        })
        .or_else(|| values.first())
        .cloned()
        .ok_or_else(|| error("AI_JSON_INVALID", "Invalid structured AI response"))
}
pub fn merge_response(text: &str, expected: &[u32]) -> Result<Vec<AiResolution>, DesktopError> {
    let mut semantic_error = None;
    for value in json_candidates(text) {
        match resolutions(&value, expected) {
            Ok(result) => return Ok(result),
            Err(err) if err.code == "AI_MERGE_INVALID" => semantic_error = Some(err),
            Err(_) => {}
        }
    }
    Err(semantic_error
        .unwrap_or_else(|| error("AI_JSON_INVALID", "Invalid conflict resolution format")))
}
fn required(v: &Value, key: &str) -> Result<String, DesktopError> {
    v[key]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| error("AI_RESULT_INVALID", format!("AI response is missing {key}")))
}
pub fn review(v: &Value, anchors: &HashMap<String, AiAnchor>) -> Result<AiReview, DesktopError> {
    let mut findings = Vec::new();
    let mut ids = HashSet::new();
    for item in v["findings"]
        .as_array()
        .ok_or_else(|| error("AI_REVIEW_INVALID", "AI review must contain findings"))?
    {
        let id = required(item, "id")?;
        if !ids.insert(id.clone()) {
            return Err(error("AI_REVIEW_INVALID", "Duplicate review finding"));
        }
        let anchor_id = required(item, "anchorId")?;
        let anchor = anchors
            .get(&anchor_id)
            .ok_or_else(|| {
                error(
                    "AI_REVIEW_INVALID",
                    "AI finding refers to an unknown diff anchor",
                )
            })?
            .clone();
        let severity = required(item, "severity")?;
        if !["critical", "high", "medium", "low"].contains(&severity.as_str()) {
            return Err(error("AI_REVIEW_INVALID", "Invalid finding severity"));
        }
        findings.push(AiFinding {
            id,
            severity,
            title: required(item, "title")?,
            anchor_id,
            evidence: required(item, "evidence")?,
            impact: required(item, "impact")?,
            suggestion: required(item, "suggestion")?,
            anchor,
        });
    }
    let verdict = required(v, "verdict")?;
    let expected = if findings.is_empty() {
        "pass"
    } else if findings
        .iter()
        .any(|f| ["critical", "high"].contains(&f.severity.as_str()))
    {
        "block"
    } else {
        "warning"
    };
    if verdict != expected {
        return Err(error(
            "AI_REVIEW_INVALID",
            "Review verdict does not match finding severity",
        ));
    }
    Ok(AiReview {
        verdict,
        summary: required(v, "summary")?,
        findings,
    })
}
pub fn resolutions(v: &Value, expected: &[u32]) -> Result<Vec<AiResolution>, DesktopError> {
    let mut seen = HashSet::new();
    let expected: HashSet<u32> = expected.iter().copied().collect();
    let mut result = Vec::new();
    for item in v
        .as_array()
        .or_else(|| v["resolutions"].as_array())
        .ok_or_else(|| error("AI_JSON_INVALID", "AI merge must contain resolutions"))?
    {
        let index = item["index"]
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .or_else(|| {
                item["index"].as_str().and_then(|n| {
                    let n = n.trim();
                    if n.is_empty() || !n.bytes().all(|c| c.is_ascii_digit()) {
                        None
                    } else {
                        n.parse().ok()
                    }
                })
            })
            .ok_or_else(|| error("AI_JSON_INVALID", "Invalid conflict index"))?;
        if !expected.contains(&index) || !seen.insert(index) {
            return Err(error(
                "AI_MERGE_INVALID",
                "Unexpected or duplicate conflict index",
            ));
        }
        let text = item["content"]
            .as_str()
            .map(str::to_owned)
            .or_else(|| {
                item["content"]
                    .as_array()
                    .or_else(|| item["lines"].as_array())
                    .and_then(|lines| {
                        lines
                            .iter()
                            .map(|v| v.as_str())
                            .collect::<Option<Vec<_>>>()
                            .map(|lines| lines.join("\n"))
                    })
            })
            .ok_or_else(|| error("AI_JSON_INVALID", "Missing resolution text"))?;
        let text = text.replace("\r\n", "\n");
        if text.lines().any(|line| {
            ["<<<<<<<", "|||||||", "=======", ">>>>>>>"]
                .iter()
                .any(|marker| {
                    line.strip_prefix(marker).is_some_and(|suffix| {
                        suffix.is_empty() || suffix.starts_with(char::is_whitespace)
                    })
                })
        }) {
            return Err(error(
                "AI_MERGE_INVALID",
                "AI resolution contains conflict markers",
            ));
        }
        result.push(AiResolution {
            index,
            lines: if text.is_empty() {
                Vec::new()
            } else {
                text.split('\n').map(str::to_owned).collect()
            },
        });
    }
    if seen != expected {
        return Err(error(
            "AI_MERGE_INVALID",
            "AI resolution does not cover every requested conflict",
        ));
    }
    result.sort_by_key(|resolution| resolution.index);
    Ok(result)
}
pub fn groups(v: &Value, units: &[AiUnit]) -> Result<Vec<AiGroup>, DesktopError> {
    let groups: Vec<AiGroup> = serde_json::from_value(v["groups"].clone())
        .map_err(|_| error("AI_COMPOSER_INVALID", "Invalid commit plan"))?;
    validate_groups(&groups, units)?;
    Ok(groups)
}
pub fn validate_groups(groups: &[AiGroup], units: &[AiUnit]) -> Result<(), DesktopError> {
    let expected: HashSet<&str> = units.iter().map(|u| u.id.as_str()).collect();
    let mut seen = HashSet::new();
    let mut group_ids = HashSet::new();
    if groups.is_empty() {
        return Err(error("AI_COMPOSER_INVALID", "The commit plan is empty"));
    }
    for group in groups {
        if group.id.trim().is_empty()
            || group.message.trim().is_empty()
            || group.unit_ids.is_empty()
            || !group_ids.insert(&group.id)
        {
            return Err(error(
                "AI_COMPOSER_INVALID",
                "Every group needs a unique ID, message and changes",
            ));
        }
        for id in &group.unit_ids {
            if !expected.contains(id.as_str()) || !seen.insert(id.as_str()) {
                return Err(error(
                    "AI_COMPOSER_COVERAGE",
                    "Every change unit must be assigned exactly once",
                ));
            }
        }
    }
    if seen != expected {
        return Err(error(
            "AI_COMPOSER_COVERAGE",
            "The commit plan omits selected changes",
        ));
    }
    Ok(())
}

#[cfg(test)]
#[path = "validation_tests.rs"]
mod tests;

pub fn correct_cross_assignments(
    resolutions: &mut [AiResolution],
    conflicts: &[crate::models::ConflictBlock],
) {
    fn normalized(lines: &[String]) -> String {
        let start = lines
            .iter()
            .position(|line| !line.trim().is_empty())
            .unwrap_or(lines.len());
        let end = lines
            .iter()
            .rposition(|line| !line.trim().is_empty())
            .map_or(start, |index| index + 1);
        lines[start..end].join("\n").replace("\r\n", "\n")
    }
    let mut owners: HashMap<String, HashSet<u32>> = HashMap::new();
    for conflict in conflicts {
        for lines in [&conflict.ours_lines, &conflict.theirs_lines] {
            let content = normalized(lines);
            if !content.trim().is_empty() {
                owners.entry(content).or_default().insert(conflict.index);
            }
        }
    }
    let remaps: HashMap<u32, u32> = resolutions
        .iter()
        .filter_map(|resolution| {
            let candidates = owners.get(&normalized(&resolution.lines))?;
            if candidates.len() != 1 || candidates.contains(&resolution.index) {
                return None;
            }
            Some((resolution.index, *candidates.iter().next().unwrap()))
        })
        .collect();
    let targets: HashSet<u32> = remaps.values().copied().collect();
    if remaps.len() < 2
        || targets.len() != remaps.len()
        || remaps.keys().any(|index| !targets.contains(index))
    {
        return;
    }
    for resolution in resolutions.iter_mut() {
        if let Some(index) = remaps.get(&resolution.index) {
            resolution.index = *index;
        }
    }
    resolutions.sort_by_key(|resolution| resolution.index);
}
