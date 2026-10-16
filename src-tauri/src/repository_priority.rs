//! Foreground writes preempt automatic fetches, while the existing repository
//! lock still protects the entire operation, including child-process cleanup.
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct Activity {
    foreground: usize,
    fetches: HashMap<uuid::Uuid, CancellationToken>,
}

#[derive(Clone, Default)]
pub(crate) struct RepositoryPriority(Arc<Mutex<HashMap<String, Activity>>>);

pub(crate) struct ActivityGuard {
    registry: RepositoryPriority,
    repository: String,
    fetch_id: Option<uuid::Uuid>,
    pub(crate) preempted_fetch: bool,
}

impl RepositoryPriority {
    pub(crate) fn enter(
        &self,
        repository: &str,
        token: &CancellationToken,
        background_fetch: bool,
    ) -> ActivityGuard {
        let mut entries = self.0.lock().unwrap();
        let entry = entries.entry(repository.to_owned()).or_default();
        let preempted_fetch =
            !background_fetch && entry.fetches.values().any(|fetch| !fetch.is_cancelled());
        let fetch_id = if background_fetch {
            if entry.foreground > 0 {
                token.cancel();
            }
            let id = uuid::Uuid::new_v4();
            entry.fetches.insert(id, token.clone());
            Some(id)
        } else {
            entry.foreground += 1;
            for fetch in entry.fetches.values() {
                fetch.cancel();
            }
            None
        };
        ActivityGuard {
            registry: self.clone(),
            repository: repository.to_owned(),
            fetch_id,
            preempted_fetch,
        }
    }
}

impl Drop for ActivityGuard {
    fn drop(&mut self) {
        let mut entries = self.registry.0.lock().unwrap();
        if let Some(entry) = entries.get_mut(&self.repository) {
            if let Some(id) = self.fetch_id {
                entry.fetches.remove(&id);
            } else {
                entry.foreground -= 1;
            }
            if entry.foreground == 0 && entry.fetches.is_empty() {
                entries.remove(&self.repository);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn foreground_preempts_running_and_queued_fetches_only_in_the_same_repository() {
        let priority = RepositoryPriority::default();
        let first = CancellationToken::new();
        let second = CancellationToken::new();
        let other = CancellationToken::new();
        let _first = priority.enter("repo", &first, true);
        let _second = priority.enter("repo", &second, true);
        let _other = priority.enter("other", &other, true);
        let foreground = priority.enter("repo", &CancellationToken::new(), false);
        assert!(first.is_cancelled() && second.is_cancelled());
        assert!(!other.is_cancelled());
        let arriving = CancellationToken::new();
        let _arriving = priority.enter("repo", &arriving, true);
        assert!(arriving.is_cancelled());
        drop(foreground);
        let next = CancellationToken::new();
        let _next = priority.enter("repo", &next, true);
        assert!(!next.is_cancelled());
    }

    #[test]
    fn all_foreground_requests_must_finish_before_new_automatic_fetches() {
        let priority = RepositoryPriority::default();
        let first = priority.enter("repo", &CancellationToken::new(), false);
        let second = priority.enter("repo", &CancellationToken::new(), false);
        drop(first);
        let fetch = CancellationToken::new();
        let guard = priority.enter("repo", &fetch, true);
        assert!(fetch.is_cancelled());
        drop(guard);
        drop(second);
        assert!(priority.0.lock().unwrap().is_empty());
    }
}
