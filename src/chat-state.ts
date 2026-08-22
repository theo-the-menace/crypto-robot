import type { ChatMessage } from './chat-ui';

export type ChatDraft = { messages: ChatMessage[]; streaming: boolean; error: string };
export type ChatDrafts = Record<string, ChatDraft>;
export type ChatDraftAction =
  | { type: 'start'; sessionId: string; messages: ChatMessage[] }
  | { type: 'delta'; sessionId: string; messageId: string; delta: string }
  | { type: 'fail'; sessionId: string; messageId: string; error: string }
  | { type: 'finish'; sessionId: string }
  | { type: 'remove'; sessionId: string };

export function reduceChatDrafts(state: ChatDrafts, action: ChatDraftAction): ChatDrafts {
  if (action.type === 'start') return { ...state, [action.sessionId]: { messages: action.messages, streaming: true, error: '' } };
  if (action.type === 'finish' || action.type === 'remove') {
    const { [action.sessionId]: _, ...remaining } = state;
    return remaining;
  }
  const draft = state[action.sessionId];
  if (!draft) return state;
  if (action.type === 'delta') return { ...state, [action.sessionId]: { ...draft, messages: draft.messages.map((message) => message.id === action.messageId ? { ...message, content: message.content + action.delta } : message) } };
  return { ...state, [action.sessionId]: { messages: draft.messages.filter((message) => message.id !== action.messageId || message.content), streaming: false, error: action.error } };
}
