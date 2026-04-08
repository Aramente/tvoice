// AI output rendering layer. Scans the xterm buffer for Claude Code tool-call
// blocks and maintains an overlay of collapsible summaries. Also detects the
// "awaiting input" state (confirm prompts) so the toolbar can highlight.
//
// Heuristics (intentionally loose — the plan is to refine against real output
// once Kevin runs this against a live Claude Code session):
//
//   - Tool call start: line begins with "⏵" or matches /^\s*\w+\(.*\)\s*$/ in
//     a Claude-detected block
//   - Tool call end: blank line, or the next "⏵" line
//   - Awaiting input: /Do you want to proceed\?|\[y\/n\]|\(y\/N\)/i
//
// This module is invoked from app.js whenever the active terminal emits new
// data (the TerminalSession exposes a data hook via the websocket message).

const TOOL_CALL_START = /(^|\n)\s*(⏵|⏺|●|>)\s+\w+\(/;
const TOOL_CALL_HEADER = /^\s*(⏵|⏺|●|>)\s+(\w+)\(([^)]*)\)/;
const AWAIT_PROMPT = /Do you want to (proceed|continue)\?|\[y\/n\]|\(y\/N\)|\(yes\/no\)/i;
const CLAUDE_MARKER = /Claude Code|claude > |claude-code|Welcome to Claude/i;

export class AIRenderer {
  constructor({ terminalSession, onAIChange, onAwaiting }) {
    this.session = terminalSession;
    this.onAIChange = onAIChange || (() => {});
    this.onAwaiting = onAwaiting || (() => {});
    this.detected = false;
    this.awaiting = false;
    this.buffer = '';
    this.tailLimit = 16 * 1024;
    this.collapsedByDefault = true;
  }

  // Called from the app when new data arrives.
  feed(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > this.tailLimit) {
      this.buffer = this.buffer.slice(-this.tailLimit);
    }

    if (!this.detected && CLAUDE_MARKER.test(this.buffer)) {
      this.detected = true;
      this.onAIChange({ detected: true, awaiting: this.awaiting });
    }

    const awaiting = AWAIT_PROMPT.test(this.buffer.slice(-1024));
    if (awaiting !== this.awaiting) {
      this.awaiting = awaiting;
      this.onAwaiting(awaiting);
    }
  }

  reset() {
    this.buffer = '';
    this.detected = false;
    this.awaiting = false;
  }
}
