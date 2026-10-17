//! Reserve one read slot for visible interactions. All reads remain bounded to
//! four; fair shared slots let background work progress during interaction bursts.
use tokio::sync::{Semaphore, SemaphorePermit};
use tokio_util::sync::CancellationToken;

use crate::models::{DesktopError, ReadPriority};

pub(crate) struct ReadScheduler {
    shared: Semaphore,
    interactive: Semaphore,
}

impl Default for ReadScheduler {
    fn default() -> Self {
        Self {
            shared: Semaphore::new(3),
            interactive: Semaphore::new(1),
        }
    }
}

impl ReadScheduler {
    pub(crate) async fn acquire(
        &self,
        priority: ReadPriority,
        cancellation: &CancellationToken,
    ) -> Result<SemaphorePermit<'_>, DesktopError> {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err(DesktopError::new("REQUEST_CANCELLED", "Operation cancelled", true)),
            permit = self.interactive.acquire(), if priority == ReadPriority::Interactive => permit.map_err(|_| Self::closed()),
            permit = self.shared.acquire() => permit.map_err(|_| Self::closed()),
        }
    }

    fn closed() -> DesktopError {
        DesktopError::new("APP_CLOSING", "Application is closing", true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{future::Future, pin::pin, time::Duration};

    async fn pending<T>(future: &mut std::pin::Pin<&mut impl Future<Output = T>>) {
        tokio::select! {
            biased;
            _ = future => panic!("request should still be queued"),
            _ = tokio::task::yield_now() => {}
        }
    }

    #[tokio::test]
    async fn background_saturation_keeps_one_slot_available_for_interaction() {
        let reads = ReadScheduler::default();
        let token = CancellationToken::new();
        let mut running = Vec::new();
        for _ in 0..3 {
            running.push(
                reads
                    .acquire(ReadPriority::Background, &token)
                    .await
                    .unwrap(),
            );
        }
        let mut background = pin!(reads.acquire(ReadPriority::Background, &token));
        pending(&mut background).await;
        let interactive = tokio::time::timeout(
            Duration::from_secs(1),
            reads.acquire(ReadPriority::Interactive, &token),
        )
        .await
        .unwrap()
        .unwrap();
        pending(&mut background).await;
        drop(interactive);
        pending(&mut background).await;
        running.pop();
        assert!(background.await.is_ok());
    }

    #[tokio::test]
    async fn interactions_borrow_shared_capacity_but_keep_total_reads_bounded_and_background_fair()
    {
        let reads = ReadScheduler::default();
        let token = CancellationToken::new();
        let mut running = Vec::new();
        for _ in 0..4 {
            running.push(
                reads
                    .acquire(ReadPriority::Interactive, &token)
                    .await
                    .unwrap(),
            );
        }
        assert_eq!(reads.shared.available_permits(), 0);
        assert_eq!(reads.interactive.available_permits(), 0);
        let mut background = pin!(reads.acquire(ReadPriority::Background, &token));
        pending(&mut background).await;
        let mut interactive = pin!(reads.acquire(ReadPriority::Interactive, &token));
        pending(&mut interactive).await;
        // The oldest background waiter still receives the next shared slot.
        drop(running.remove(1));
        let background = background.await.unwrap();
        pending(&mut interactive).await;
        // The reserved slot is exclusively available to the interactive waiter.
        drop(running.remove(0));
        assert!(interactive.await.is_ok());
        drop(background);
    }

    #[tokio::test]
    async fn queued_and_already_cancelled_reads_release_all_waiters() {
        for priority in [ReadPriority::Background, ReadPriority::Interactive] {
            let reads = ReadScheduler::default();
            let token = CancellationToken::new();
            let mut running = Vec::new();
            for _ in 0..4 {
                running.push(
                    reads
                        .acquire(ReadPriority::Interactive, &token)
                        .await
                        .unwrap(),
                );
            }
            let cancelled = CancellationToken::new();
            let mut queued = pin!(reads.acquire(priority, &cancelled));
            pending(&mut queued).await;
            cancelled.cancel();
            assert_eq!(queued.await.unwrap_err().code, "REQUEST_CANCELLED");
            drop(running);
            assert_eq!(reads.shared.available_permits(), 3);
            assert_eq!(reads.interactive.available_permits(), 1);
            assert_eq!(
                reads.acquire(priority, &cancelled).await.unwrap_err().code,
                "REQUEST_CANCELLED"
            );
            assert_eq!(reads.shared.available_permits(), 3);
            assert_eq!(reads.interactive.available_permits(), 1);
        }
    }

    #[tokio::test]
    async fn dropping_an_interactive_waiter_does_not_leak_either_pool() {
        let reads = ReadScheduler::default();
        let token = CancellationToken::new();
        let mut running = Vec::new();
        for _ in 0..4 {
            running.push(
                reads
                    .acquire(ReadPriority::Interactive, &token)
                    .await
                    .unwrap(),
            );
        }
        {
            let mut queued = pin!(reads.acquire(ReadPriority::Interactive, &token));
            pending(&mut queued).await;
        }
        drop(running);
        assert_eq!(reads.shared.available_permits(), 3);
        assert_eq!(reads.interactive.available_permits(), 1);
        assert!(reads
            .acquire(ReadPriority::Background, &token)
            .await
            .is_ok());
    }

    #[test]
    fn older_envelopes_default_to_background_without_changing_progress_visibility() {
        let request: crate::models::RequestEnvelope = serde_json::from_value(serde_json::json!({
            "requestId": "legacy", "command": { "type": "bootstrap" },
            "context": { "generation": 1, "domain": "application", "visibility": "foreground" }
        }))
        .unwrap();
        assert_eq!(request.read_priority, ReadPriority::Background);
        assert_eq!(
            request.context.visibility,
            crate::models::OperationVisibility::Foreground
        );
    }
}
