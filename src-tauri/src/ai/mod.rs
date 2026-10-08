mod agent_cli;
mod budget;
mod composer;
mod context;
mod credentials;
mod diff_context;
mod logging;
pub mod models;
mod prompts;
mod transport;
mod validation;
use crate::{
    logger::LogLevel,
    models::{DesktopError, LanguagePreference},
    state::AppState,
    vcs,
};
use models::*;
use serde_json::{json, Value};
use std::{collections::HashSet, time::Instant};
use tauri::{AppHandle, Emitter};
use tokio_util::sync::CancellationToken;
use transport::error;
fn emit(app: &AppHandle, id: &str, phase: &str, delta: &str) {
    if delta.is_empty() {
        logging::record(
            LogLevel::Info,
            "AI task phase",
            json!({"phase":phase}),
            None,
        );
    }
    let _ = app.emit(
        "versiondock://event",
        AiEvent {
            r#type: "aiProgress".into(),
            request_id: id.into(),
            phase: phase.into(),
            delta: delta.into(),
        },
    );
}
pub async fn runtime(state: &AppState, refresh_key: bool) -> AiRuntime {
    agent_cli::initialize(&state.config_dir);
    let c = state.app.read().await.settings.ai_config.clone();
    if c.execution_mode == "agent-cli" {
        return agent_cli::runtime(&c).await;
    }
    let saved = match credentials::key(&c, refresh_key).await {
        Ok(value) => !value.is_empty(),
        Err(error) => {
            return AiRuntime {
                configured: false,
                key_saved: false,
                provider: c.provider,
                available: false,
                message: if error.code == "AI_KEY_ACCESS_FAILED" {
                    error.message
                } else {
                    "Configure the API endpoint, model and API key".into()
                },
                version: None,
            }
        }
    };
    let available = saved && !c.model.is_empty() && transport::endpoint(&c).is_ok();
    AiRuntime {
        configured: available,
        key_saved: saved,
        provider: c.provider,
        available,
        message: if available {
            "AI provider configured"
        } else {
            "Configure the API endpoint, model and API key"
        }
        .into(),
        version: None,
    }
}
pub async fn save_key(
    provider: String,
    url: String,
    key: Option<String>,
) -> Result<(), DesktopError> {
    credentials::save_key(provider, url, key).await
}
pub fn reset_cli_session() {
    agent_cli::reset_sessions();
}
pub async fn prompt(
    state: &AppState,
    task: AiTask,
    workspace: Option<String>,
    repo: Option<String>,
    scope: String,
    action: String,
    text: Option<String>,
) -> Result<AiPrompt, DesktopError> {
    let chinese = is_chinese(state.app.read().await.settings.language.clone());
    let request = AiRequest {
        request_id: String::new(),
        task,
        workspace_id: workspace.unwrap_or_default(),
        candidates: Vec::new(),
        commits: Vec::new(),
        user_prompt: String::new(),
        repo_id: repo,
        path: None,
        conflict_indexes: Vec::new(),
        session_id: None,
        unit_ids: Vec::new(),
    };
    let root = context::prompt_root(state, &request).await;
    prompts::edit(
        &state.config_dir,
        root.as_deref(),
        task,
        chinese,
        &scope,
        &action,
        text,
    )
}
pub async fn prepare(
    state: &AppState,
    workspace: &str,
    repo_id: &str,
    paths: Vec<String>,
    staged: bool,
    hashes: Vec<String>,
    token: &CancellationToken,
) -> Result<AiComposerSource, DesktopError> {
    let started = Instant::now();
    logging::record(
        LogLevel::Info,
        "AI change-unit preparation started",
        json!({"pathCount":paths.len(),"commitCount":hashes.len(),"stagedOnly":staged}),
        None,
    );
    let result = prepare_inner(state, workspace, repo_id, paths, staged, hashes, token).await;
    match &result {
        Ok(source) => logging::record(
            LogLevel::Info,
            "AI change-unit preparation completed",
            json!({"unitCount":source.units.len()}),
            Some(logging::elapsed(started)),
        ),
        Err(err) => logging::record(
            if err.code == "CANCELLED" {
                LogLevel::Info
            } else {
                LogLevel::Error
            },
            "AI change-unit preparation stopped",
            json!({"errorCode":err.code}),
            Some(logging::elapsed(started)),
        ),
    }
    result
}

async fn prepare_inner(
    state: &AppState,
    workspace: &str,
    repo_id: &str,
    paths: Vec<String>,
    staged: bool,
    hashes: Vec<String>,
    token: &CancellationToken,
) -> Result<AiComposerSource, DesktopError> {
    let repo = context::repository(state, workspace, repo_id).await?;
    let lock = state.write_lock(repo_id).await;
    let _guard = tokio::select! {_=token.cancelled()=>return Err(error("CANCELLED","AI preparation cancelled")),g=lock.lock()=>g};
    composer::prepare(workspace, &repo, &paths, staged, &hashes, token).await
}
pub async fn apply(
    state: &AppState,
    workspace: &str,
    repo_id: &str,
    id: &str,
    groups: Vec<AiGroup>,
    no_verify: bool,
    token: &CancellationToken,
) -> Result<AiApplyResult, DesktopError> {
    let started = Instant::now();
    logging::record(
        LogLevel::Info,
        "AI commit-plan application started",
        json!({"groupCount":groups.len()}),
        None,
    );
    let result = apply_inner(state, workspace, repo_id, id, groups, no_verify, token).await;
    match &result {
        Ok(_) => logging::record(
            LogLevel::Info,
            "AI commit-plan application completed",
            json!({}),
            Some(logging::elapsed(started)),
        ),
        Err(err) => logging::record(
            if err.code == "CANCELLED" {
                LogLevel::Info
            } else {
                LogLevel::Error
            },
            "AI commit-plan application stopped",
            json!({"errorCode":err.code}),
            Some(logging::elapsed(started)),
        ),
    }
    result
}

async fn apply_inner(
    state: &AppState,
    workspace: &str,
    repo_id: &str,
    id: &str,
    groups: Vec<AiGroup>,
    no_verify: bool,
    token: &CancellationToken,
) -> Result<AiApplyResult, DesktopError> {
    let repo = context::repository(state, workspace, repo_id).await?;
    let session = composer::session(id, workspace, repo_id)?;
    if repo.root_path != session.repo.root_path {
        return Err(error("AI_COMPOSER_STALE", "Repository location changed"));
    }
    let lock = state.write_lock(repo_id).await;
    let _guard = tokio::select! {_=token.cancelled()=>return Err(error("CANCELLED","AI application cancelled")),g=lock.lock()=>g};
    let _permit = state.acquire_write(token).await?;
    let identity = if repo.kind == crate::models::VcsKind::Git {
        Some(
            crate::identity::state(&state.config_dir, workspace, Some(&repo), token)
                .await?
                .effective,
        )
    } else {
        None
    };
    composer::apply(session, groups, no_verify, identity.as_ref(), token).await
}
pub async fn locate(
    state: &AppState,
    workspace: &str,
    anchor: AiAnchor,
    token: &CancellationToken,
) -> Result<crate::models::DiffDocument, DesktopError> {
    let repo = context::repository(state, workspace, &anchor.repo_id).await?;
    let diff = vcs::diff(
        &repo,
        &anchor.file_path,
        anchor.staged,
        None,
        None,
        None,
        token,
    )
    .await?;
    if context::fingerprint(&diff.content) != anchor.fingerprint {
        return Err(error(
            "AI_REVIEW_STALE",
            "Changes have changed since this review. Re-review before locating this finding.",
        ));
    }
    Ok(diff)
}
fn schema(task: AiTask) -> Option<Value> {
    match task {
        AiTask::MergeConflict => Some(
            json!({"type":"object","additionalProperties":false,"required":["resolutions"],"properties":{"resolutions":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["index","content"],"properties":{"index":{"type":"integer"},"content":{"type":"string"}}}}}}),
        ),
        AiTask::CommitComposer => Some(
            json!({"type":"object","additionalProperties":false,"required":["groups"],"properties":{"groups":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["id","message","rationale","unitIds"],"properties":{"id":{"type":"string"},"message":{"type":"string"},"rationale":{"type":"string"},"unitIds":{"type":"array","items":{"type":"string"}}}}}}}),
        ),
        AiTask::CodeReview => Some(
            json!({"type":"object","additionalProperties":false,"required":["verdict","summary","findings"],"properties":{"verdict":{"type":"string","enum":["pass","warning","block"]},"summary":{"type":"string"},"findings":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["id","severity","title","anchorId","evidence","impact","suggestion"],"properties":{"id":{"type":"string"},"severity":{"type":"string","enum":["critical","high","medium","low"]},"title":{"type":"string"},"anchorId":{"type":"string"},"evidence":{"type":"string"},"impact":{"type":"string"},"suggestion":{"type":"string"}}}}}}),
        ),
        _ => None,
    }
}
pub async fn generate(
    state: &AppState,
    app: &AppHandle,
    request: AiRequest,
    token: &CancellationToken,
) -> Result<AiResult, DesktopError> {
    let context = request.clone();
    logging::with_request(&context, async {
        let start = Instant::now();
        logging::record(LogLevel::Info, "AI task started", json!({"candidateCount":request.candidates.len(),"commitCount":request.commits.len(),"conflictCount":request.conflict_indexes.len()}), None);
        let result = generate_inner(state, app, request, token).await;
        match &result {
            Ok(result) => logging::record(LogLevel::Info, "AI task completed", json!({"provider":result.provider,"model":result.model,"promptSource":result.prompt_source,"fileCount":result.file_count,"repositoryCount":result.repository_count,"inputTruncated":result.input_truncated,"outputCharCount":result.text.chars().count(),"findingCount":result.review.as_ref().map(|review|review.findings.len()),"groupCount":result.groups.len(),"resolutionCount":result.resolutions.len()}), Some(logging::elapsed(start))),
            Err(err) => logging::record(if err.code == "CANCELLED" {LogLevel::Info} else {LogLevel::Error}, if err.code == "CANCELLED" {"AI task cancelled"} else {"AI task failed"}, json!({"errorCode":err.code,"providerDetails":err.hint}), Some(logging::elapsed(start))),
        }
        result
    }).await
}

async fn generate_inner(
    state: &AppState,
    app: &AppHandle,
    request: AiRequest,
    token: &CancellationToken,
) -> Result<AiResult, DesktopError> {
    agent_cli::initialize(&state.config_dir);
    let start = Instant::now();
    let settings = state.app.read().await.settings.clone();
    let config = settings.ai_config;
    let chinese = is_chinese(settings.language);
    logging::record(
        LogLevel::Info,
        "AI execution configuration",
        logging::config(&config),
        None,
    );
    emit(
        app,
        &request.request_id,
        if request.task == AiTask::CommitExplanation {
            "reading"
        } else {
            "scanning"
        },
        "",
    );
    if request.task == AiTask::CommitExplanation {
        emit(app, &request.request_id, "analyzing", "");
    }
    let mut source = None;
    let evidence = if let Some(id) = &request.session_id {
        let repo = request
            .repo_id
            .as_deref()
            .ok_or_else(|| error("AI_CONTEXT_EMPTY", "Missing repository"))?;
        let session = composer::session(id, &request.workspace_id, repo)?;
        let units: Vec<_> = session
            .source
            .units
            .iter()
            .filter(|u| request.unit_ids.is_empty() || request.unit_ids.contains(&u.id))
            .cloned()
            .collect();
        let data = serde_json::to_string(&units)
            .map_err(|e| error("AI_CONTEXT_INVALID", e.to_string()))?;
        source = Some(session.source.clone());
        context::Context {
            text: format!(
                "Repository: {}\nChange units: {}\nUser request: {}",
                session.repo.name, data, request.user_prompt
            ),
            roots: vec![session.repo.root_path],
            anchors: Default::default(),
            truncated: false,
            file_count: units
                .iter()
                .map(|u| &u.file_path)
                .collect::<HashSet<_>>()
                .len() as u32,
            merge_fingerprint: None,
        }
    } else {
        context::build(state, &request, config.max_input_tokens, token).await?
    };
    let root = context::prompt_root(state, &request).await;
    let prompt = prompts::resolve(&state.config_dir, root.as_deref(), request.task, chinese);
    let mut system = prompt.text;
    if request.task == AiTask::CommitComposer {
        system.push_str("\n\n# Active system commit-message prompt\nThe following prompt applies only to each groups[].message field, including its language and format. Its instruction to output only a commit message must not replace the Composer JSON contract.\n<commit-message-prompt>\n");
        system.push_str(
            &prompts::resolve(
                &state.config_dir,
                root.as_deref(),
                AiTask::CommitMessage,
                chinese,
            )
            .text,
        );
    }
    if request.task == AiTask::CommitComposer {
        system.push_str("\n</commit-message-prompt>\n# Final output priority\nReturn only the Composer JSON contract. Include every input unit ID exactly once. Do not output a standalone commit message or text outside the JSON.");
    }
    let input_tokens = context::tokens(&evidence.text) + context::tokens(&system);
    if input_tokens > budget::input(config.max_input_tokens) {
        return Err(error(
            "AI_CONTEXT_TOO_LARGE",
            "Input exceeds the AI token budget. Reduce the selection or increase the input budget.",
        ));
    }
    let unit_ids: Vec<_> = source
        .as_ref()
        .map(|source| source.units.iter().map(|unit| unit.id.as_str()).collect())
        .unwrap_or_default();
    let output = budget::output(
        request.task,
        &format!("{system}\n{}", evidence.text),
        request.commits.len(),
        evidence.file_count as usize,
        &unit_ids,
        config.max_output_tokens,
    );
    let structured = schema(request.task);
    logging::record(
        LogLevel::Info,
        "AI context prepared",
        json!({"promptSource":prompt.source,"inputTokenCount":input_tokens,"inputTokenBudget":budget::input(config.max_input_tokens),"maxOutputTokens":output,"fileCount":evidence.file_count,"repositoryCount":evidence.roots.len(),"inputTruncated":evidence.truncated,"unitCount":unit_ids.len(),"structuredOutput":structured.is_some()}),
        None,
    );
    let key = if config.execution_mode == "agent-cli" {
        String::new()
    } else {
        credentials::key(&config, false).await?
    };
    emit(
        app,
        &request.request_id,
        if request.task == AiTask::CommitExplanation {
            "thinking"
        } else {
            "analyzing"
        },
        "",
    );
    let delta = |text: &str| {
        if request.task == AiTask::CommitComposer {
            return;
        }
        emit(
            app,
            &request.request_id,
            if request.task == AiTask::CommitExplanation {
                "writing"
            } else {
                "analyzing"
            },
            text,
        )
    };
    let mut text = transport::generate_for_task(
        &config,
        &key,
        &system,
        &evidence.text,
        &evidence.roots,
        structured.as_ref(),
        output,
        request.task,
        token,
        &delta,
    )
    .await?;
    let mut report = None;
    let mut resolutions = Vec::new();
    let mut groups = Vec::new();
    if structured.is_some() {
        emit(app, &request.request_id, "validating", "");
        let parse = |text: &str| {
            if request.task == AiTask::MergeConflict {
                validation::merge_response(text, &request.conflict_indexes)
                    .map(|result| json!({"resolutions":result}))
            } else {
                validation::json_response(text)
            }
        };
        let mut json = parse(&text);
        if json
            .as_ref()
            .is_err_and(|err| err.code == "AI_JSON_INVALID")
        {
            logging::record(
                LogLevel::Warn,
                "AI invalid JSON; attempting format repair",
                json!({"responseCharCount":text.chars().count()}),
                None,
            );
            emit(app, &request.request_id, "repairing", "");
            let repair=format!("Repair only JSON syntax of this response. Do not invent findings, indexes, IDs, messages or replacement code. Return only the repaired JSON.\n{text}");
            text = transport::generate(
                &config,
                &key,
                "Repair malformed JSON without changing its meaning.",
                &repair,
                &evidence.roots,
                structured.as_ref(),
                budget::repair(
                    &repair,
                    &text,
                    if request.task == AiTask::MergeConflict {
                        8192
                    } else {
                        2048
                    },
                    config.max_output_tokens,
                ),
                token,
                &|_| {},
            )
            .await?;
            json = parse(&text);
            logging::record(
                if json.is_ok() {
                    LogLevel::Info
                } else {
                    LogLevel::Error
                },
                if json.is_ok() {
                    "AI JSON format repair completed"
                } else {
                    "AI JSON format repair failed"
                },
                json!({"responseCharCount":text.chars().count()}),
                None,
            );
        }
        let value = json?;
        match request.task {
            AiTask::CodeReview => {
                report = Some(validation::review(&value, &evidence.anchors)?);
            }
            AiTask::MergeConflict => {
                resolutions = validation::resolutions(&value, &request.conflict_indexes)?;
                let repo = context::repository(
                    state,
                    &request.workspace_id,
                    request.repo_id.as_deref().unwrap_or(""),
                )
                .await?;
                let current =
                    vcs::conflict_versions(&repo, request.path.as_deref().unwrap_or(""), token)
                        .await?;
                if Some(current.fingerprint.clone()) != evidence.merge_fingerprint {
                    return Err(error(
                        "AI_CONFLICT_STALE",
                        "Conflict file changed while AI was running",
                    ));
                }
                validation::correct_cross_assignments(&mut resolutions, &current.conflicts);
            }
            AiTask::CommitComposer => {
                let units = &source
                    .as_ref()
                    .ok_or_else(|| {
                        error(
                            "AI_COMPOSER_SESSION_STALE",
                            "Prepare changes before analysis",
                        )
                    })?
                    .units;
                let value = repair_coverage(
                    &config,
                    &key,
                    &value,
                    units,
                    &evidence.roots,
                    output,
                    token,
                    app,
                    &request.request_id,
                )
                .await?;
                groups = validation::groups(
                    &value,
                    &source
                        .as_ref()
                        .ok_or_else(|| {
                            error(
                                "AI_COMPOSER_SESSION_STALE",
                                "Prepare changes before analysis",
                            )
                        })?
                        .units,
                )?;
            }
            _ => {}
        }
    } else {
        text = text.trim().into();
        if text.starts_with("```") && text.ends_with("```") {
            if let Some(start) = text.find('\n') {
                text = text[start + 1..text.len() - 3].trim().into();
            }
        }
    }
    emit(app, &request.request_id, "completed", "");
    Ok(AiResult {
        text,
        provider: if config.execution_mode == "agent-cli" {
            format!("{}-cli", config.cli_provider)
        } else {
            config.provider
        },
        model: if config.execution_mode == "agent-cli" {
            config.cli_model
        } else {
            config.model
        },
        prompt_source: prompt.source,
        input_truncated: evidence.truncated,
        duration_ms: start.elapsed().as_millis().min(u32::MAX as u128) as u32,
        review: report,
        resolutions,
        groups,
        file_count: evidence.file_count,
        repository_count: evidence.roots.len() as u32,
    })
}

fn is_chinese(language: LanguagePreference) -> bool {
    match language {
        LanguagePreference::ZhCn => true,
        LanguagePreference::En => false,
        LanguagePreference::System => {
            #[cfg(target_os = "macos")]
            if let Ok(out) = std::process::Command::new("defaults")
                .args(["read", "-g", "AppleLanguages"])
                .output()
            {
                let text = String::from_utf8_lossy(&out.stdout);
                if let Some(first) = text
                    .lines()
                    .map(str::trim)
                    .find(|s| *s != "(" && !s.is_empty())
                {
                    return first.trim_matches('"').starts_with("zh");
                }
            }
            ["LC_ALL", "LC_MESSAGES", "LANG"]
                .iter()
                .find_map(|key| std::env::var(key).ok().filter(|v| !v.is_empty()))
                .is_some_and(|value| value.starts_with("zh"))
        }
    }
}

async fn repair_coverage(
    config: &AiConfig,
    key: &str,
    value: &Value,
    units: &[AiUnit],
    roots: &[String],
    output: u32,
    token: &CancellationToken,
    app: &AppHandle,
    id: &str,
) -> Result<Value, DesktopError> {
    let mut groups: Vec<AiGroup> = serde_json::from_value(value["groups"].clone())
        .map_err(|_| error("AI_COMPOSER_INVALID", "Invalid commit plan"))?;
    let seen: HashSet<_> = groups
        .iter()
        .flat_map(|g| g.unit_ids.iter().cloned())
        .collect();
    let missing: Vec<_> = units
        .iter()
        .filter(|u| !seen.contains(&u.id))
        .map(|u| u.id.clone())
        .collect();
    if missing.is_empty() {
        return Ok(value.clone());
    }
    let assigned: Vec<_> = units
        .iter()
        .filter(|u| seen.contains(&u.id))
        .cloned()
        .collect();
    validation::validate_groups(&groups, &assigned)?;
    emit(app, id, "repairing", "");
    logging::record(
        LogLevel::Warn,
        "AI incomplete unit coverage; attempting repair",
        json!({"missingUnitCount":missing.len(),"unitCount":units.len(),"groupCount":groups.len()}),
        None,
    );
    let input = json!({"existingGroups":groups,"requiredUnitIds":missing,"units":units.iter().filter(|u| missing.contains(&u.id)).map(|u| json!({"id":u.id,"filePath":u.file_path,"title":u.title})).collect::<Vec<_>>()}).to_string();
    let text = transport::generate(config,key,"Assign each requiredUnitId exactly once to the closest existing group. Do not change messages or return other IDs. Return JSON only: {\"assignments\":[{\"unitId\":\"u1\",\"groupId\":\"group-1\"}]}",&input,roots,None,output,token,&|_|{}).await?;
    let repair = validation::json_response(&text)?;
    let mut repaired = HashSet::new();
    for assignment in repair["assignments"]
        .as_array()
        .ok_or_else(|| error("AI_COMPOSER_COVERAGE", "Invalid coverage repair"))?
    {
        let unit = assignment["unitId"].as_str().unwrap_or("");
        let group_id = assignment["groupId"].as_str().unwrap_or("");
        if !missing.iter().any(|id| id == unit) || !repaired.insert(unit) {
            return Err(error(
                "AI_COMPOSER_COVERAGE",
                "Unexpected or duplicate repair unit",
            ));
        }
        let group = groups
            .iter_mut()
            .find(|g| g.id == group_id)
            .ok_or_else(|| error("AI_COMPOSER_COVERAGE", "Unknown repair group"))?;
        group.unit_ids.push(unit.into());
    }
    validation::validate_groups(&groups, units)?;
    logging::record(
        LogLevel::Info,
        "AI unit coverage repair completed",
        json!({"repairedUnitCount":repaired.len(),"groupCount":groups.len()}),
        None,
    );
    Ok(json!({"groups":groups}))
}
