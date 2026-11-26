/**
 * Defensive shapes used only to parse sanitized runtime data returned through
 * the formal Conversation API. The browser has no direct runtime client.
 */
export interface RuntimeSession {
  id: string;
  title?: string;
  parentID?: string;
  [key: string]: unknown;
}

export interface RuntimeAgentConfig {
  description?: string;
  [key: string]: unknown;
}

export interface RuntimeConfig {
  agent?: Record<string, RuntimeAgentConfig>;
  [key: string]: unknown;
}

export interface RuntimeAgentInfo {
  name: string;
  description?: string;
  mode?: "primary" | "subagent" | "all";
  native?: boolean;
  hidden?: boolean;
  [key: string]: unknown;
}

export interface RuntimeQuestionOption {
  label: string;
  description?: string;
}

export interface RuntimeQuestionItem {
  header?: string;
  question: string;
  options: RuntimeQuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}

export interface RuntimeQuestionRequest {
  id: string;
  sessionID?: string;
  sessionId?: string;
  questions: RuntimeQuestionItem[];
}

export interface RuntimePermission {
  id: string;
  sessionID?: string;
  sessionId?: string;
  permission?: string;
  metadata?: Record<string, unknown>;
  patterns?: string[];
  [key: string]: unknown;
}
