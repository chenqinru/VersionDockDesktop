use super::*;
use serde_json::json;
#[test]
fn merge_requires_complete_unique_index_coverage_and_marker_free_text() {
    assert!(resolutions(
        &json!({"resolutions":[{"index":0,"content":"resolved"}]}),
        &[0, 1]
    )
    .is_err());
    assert!(resolutions(
        &json!({"resolutions":[{"index":0,"content":"a"},{"index":0,"content":"b"}]}),
        &[0]
    )
    .is_err());
    assert!(resolutions(&json!({"resolutions":[{"index":99,"content":"a"}]}), &[0]).is_err());
    assert!(resolutions(
        &json!({"resolutions":[{"index":0,"content":"<<<<<<< ours"}]}),
        &[0]
    )
    .is_err());
    assert_eq!(
        resolutions(&json!({"resolutions":[{"index":0,"content":""}]}), &[0]).unwrap()[0]
            .lines
            .len(),
        0
    );
}
#[test]
fn review_rejects_unknown_anchor_and_inconsistent_verdict() {
    let anchor = AiAnchor {
        id: "A1".into(),
        repo_id: "r".into(),
        repo_name: "r".into(),
        file_path: "f".into(),
        staged: false,
        old_line: None,
        new_line: Some(2),
        fingerprint: "hash".into(),
    };
    let anchors = HashMap::from([("A1".into(), anchor)]);
    let mut report = json!({"verdict":"warning","summary":"summary","findings":[{"id":"f1","severity":"high","anchorId":"A1","title":"bug","evidence":"e","impact":"i","suggestion":"s"}]});
    assert!(review(&report, &anchors).is_err());
    report["verdict"] = json!("block");
    assert!(review(&report, &anchors).is_ok());
    report["findings"][0]["anchorId"] = json!("unknown");
    assert!(review(&report, &anchors).is_err());
    assert!(json_response("```json\n{\"groups\":[]}\n```").is_ok());
    assert!(json_response("{partial").is_err());
}

#[test]
fn merge_accepts_plugin_compatible_embedded_arrays_and_literal_marker_prefixes() {
    let text = r#"Here is the result: ```json
    [{"index":" 0 ","content":["=======literal", "ok\r\nnext"]}]
    ``` Additional {} commentary."#;
    let parsed = merge_response(text, &[0]).unwrap();
    assert_eq!(parsed[0].lines, ["=======literal", "ok", "next"]);
    assert_eq!(
        merge_response(
            r#"{"resolutions":[{"index":0,"lines":["======= branch"]}]}"#,
            &[0]
        )
        .unwrap_err()
        .code,
        "AI_MERGE_INVALID"
    );
    assert_eq!(
        merge_response(r#"{"resolutions":[{"index":4,"lines":["ok"]}]}"#, &[0])
            .unwrap_err()
            .code,
        "AI_MERGE_INVALID"
    );
    assert_eq!(
        merge_response(r#"{"resolutions":[{"index":0,"content":123}]}"#, &[0])
            .unwrap_err()
            .code,
        "AI_JSON_INVALID"
    );
    assert!(merge_response(
        r#"Example {}. Actual {"resolutions":[{"index":0,"content":"{ quoted }"}]}"#,
        &[0]
    )
    .is_ok());
}

#[test]
fn merge_corrects_only_unambiguous_closed_cross_assignments() {
    let conflicts = vec![
        crate::models::ConflictBlock {
            index: 0,
            ours_label: "ours".into(),
            theirs_label: "theirs".into(),
            ours_lines: vec!["first".into()],
            theirs_lines: vec!["first alternative".into()],
            base_lines: vec![],
            start_line: 0,
            end_line: 4,
        },
        crate::models::ConflictBlock {
            index: 1,
            ours_label: "ours".into(),
            theirs_label: "theirs".into(),
            ours_lines: vec!["second".into()],
            theirs_lines: vec!["second alternative".into()],
            base_lines: vec![],
            start_line: 6,
            end_line: 10,
        },
    ];
    let mut resolutions = vec![
        AiResolution {
            index: 0,
            lines: vec!["second".into()],
        },
        AiResolution {
            index: 1,
            lines: vec!["first".into()],
        },
    ];
    correct_cross_assignments(&mut resolutions, &conflicts);
    assert_eq!(resolutions[0].lines, ["first"]);
    assert_eq!(resolutions[1].lines, ["second"]);
    let mut ambiguous = vec![
        AiResolution {
            index: 0,
            lines: vec!["second".into()],
        },
        AiResolution {
            index: 1,
            lines: vec!["new combination".into()],
        },
    ];
    correct_cross_assignments(&mut ambiguous, &conflicts);
    assert_eq!(ambiguous[0].lines, ["second"]);
}
