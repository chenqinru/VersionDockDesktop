import type { AiUnit, AiComposerSource, AiApplyResult, AiGroup, AiFinding } from '../bindings/generated';
export type ComposerChangeUnit = AiUnit;
export type ComposerPreparedSource = AiComposerSource;
export type ComposerCommitGroup = Omit<AiGroup, 'rationale'> & { rationale: string };
export type ComposerApplyResult = AiApplyResult;
export type CodeReviewSeverity = 'critical' | 'high' | 'medium' | 'low';
export type CodeReviewFinding = Omit<AiFinding, 'severity'> & {
  severity: CodeReviewSeverity;
  repoId: string;
  repoName: string;
  filePath: string;
  source: 'staged' | 'working';
  oldLine?: number;
  newLine?: number;
};
export type CodeReviewReport = {
  verdict: 'pass' | 'warning' | 'block';
  summary: string;
  findings: CodeReviewFinding[];
};
export type CodeReviewPhase = 'scanning' | 'analyzing' | 'validating' | 'completed' | 'error';
export type HostToComposerMsg =
  | { type: 'COMPOSER_PHASE'; phase: 'scanning' | 'analyzing' | 'validating' | 'applying'; detail?: string }
  | { type: 'COMPOSER_SOURCE'; source: ComposerPreparedSource }
  | { type: 'COMPOSER_PLAN'; groups: ComposerCommitGroup[]; provider: string; model?: string; promptSource: string }
  | { type: 'COMPOSER_MESSAGE_UPDATE'; requestId: string; groupId: string; message: string }
  | { type: 'COMPOSER_MESSAGE_RESULT'; requestId: string; groupId: string; message?: string; error?: string }
  | { type: 'COMPOSER_ERROR'; error: string }
  | { type: 'COMPOSER_APPLY_PROGRESS'; completed: number; total: number; message: string }
  | { type: 'COMPOSER_APPLY_RESULT'; result: ComposerApplyResult };
export type ComposerToHostMsg =
  | { type: 'COMPOSER_READY' | 'COMPOSER_REANALYZE' | 'COMPOSER_CANCEL' | 'COMPOSER_CLOSE' }
  | { type: 'COMPOSER_GENERATE_MESSAGE'; requestId: string; groupId: string; unitIds: string[] }
  | { type: 'COMPOSER_CANCEL_MESSAGE'; requestId: string }
  | { type: 'COMPOSER_APPLY'; groups: ComposerCommitGroup[] }
  | { type: 'COMPOSER_WEBVIEW_ERROR'; message: string; stack?: string };
export type HostToCodeReviewMsg =
  | {
      type: 'CODE_REVIEW_PHASE';
      phase: CodeReviewPhase;
      detail: string;
      fileCount?: number;
      repositoryCount?: number;
      truncated?: boolean;
      streamCharCount?: number;
    }
  | {
      type: 'CODE_REVIEW_RESULT';
      fileCount?: number;
      repositoryCount?: number;
      report: CodeReviewReport;
      provider: string;
      model?: string;
      promptSource: string;
      durationMs: number;
      truncated: boolean;
    }
  | { type: 'CODE_REVIEW_CANCELLED' }
  | { type: 'CODE_REVIEW_ERROR'; error: string }
  | { type: 'CODE_REVIEW_STALE'; finding: CodeReviewFinding };
export type CodeReviewToHostMsg =
  | { type: 'CODE_REVIEW_READY' | 'CODE_REVIEW_RERUN' | 'CODE_REVIEW_CANCEL' | 'CODE_REVIEW_CLOSE' }
  | { type: 'CODE_REVIEW_OPEN_DIFF'; finding: CodeReviewFinding }
  | { type: 'CODE_REVIEW_WEBVIEW_ERROR'; message: string; stack?: string };
