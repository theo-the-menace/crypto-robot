import { Children, isValidElement, useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowDown, ChevronDown, Copy, MoreHorizontal, PanelLeftClose, Pencil, Pin, Plus, Quote, SendHorizontal, Settings2, Trash2, X } from 'lucide-react';
import { normalizeChatMarkdown } from './markdown';
import { reduceChatDrafts } from './chat-state';
import { quoteChatPrompt } from './quote';
export { normalizeChatMarkdown } from './markdown';
export { reduceChatDrafts } from './chat-state';
export { quoteChatPrompt } from './quote';

export type ChatMessage = { id: string; role: 'user' | 'assistant'; content: string; createdAt?: string };
export type ChatSession = { id: string; title: string; pinned?: boolean; createdAt?: string; updatedAt?: string; messages: ChatMessage[] };
export type ChatModelOption = { id: string; name: string; detail?: string };
export type ChatTheme = 'light' | 'dark' | 'system';
export type ChatAdapter<Session extends ChatSession> = {
  listSessions: () => Promise<Session[]>;
  createSession: () => Promise<Session>;
  updateSession: (sessionId: string, values: Partial<Pick<Session, 'title' | 'pinned'>>) => Promise<Session>;
  deleteSession: (sessionId: string) => Promise<void>;
  send: (request: { sessionId: string; content: string; model: string; context?: unknown; replaceFromMessageId?: string; signal: AbortSignal; onDelta: (delta: string) => void }) => Promise<void>;
};

export async function readChatStream(response: Response, onDelta: (delta: string) => void) {
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error || `Chat service error (${response.status})`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  const consume = (line: string) => {
    if (!line.startsWith('data:')) return false;
    const data = line.slice(5).trim();
    if (data === '[DONE]') return true;
    if (!data) return false;
    const payload = JSON.parse(data);
    if (payload.error) throw new Error(payload.error);
    if (typeof payload.delta === 'string') onDelta(payload.delta);
    return false;
  };
  while (true) {
    const { value, done } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) if (consume(line)) return;
    if (done) break;
  }
  if (pending) consume(pending);
}

export function useChatController<Session extends ChatSession>(adapter: ChatAdapter<Session>, model: string) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [newChatActive, setNewChatActive] = useState(false);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [drafts, dispatchDraft] = useReducer(reduceChatDrafts, {});
  const inputKey = newChatActive || !activeSessionId ? '__new__' : activeSessionId;
  const input = inputs[inputKey] ?? '';
  const setInput = (value: string) => setInputs((current) => ({ ...current, [inputKey]: value }));
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null;
  const activeDraft = activeSessionId ? drafts[activeSessionId] : null;
  const messages = activeDraft?.messages ?? (newChatActive ? [] : activeSession?.messages ?? []);
  const streaming = activeDraft?.streaming ?? false;
  const activeError = activeDraft?.error || error;

  const refreshSessions = useCallback(async (preferredId?: string) => {
    try {
      const next = await adapter.listSessions();
      setSessions(next);
      setActiveSessionId((current) => preferredId ?? (current && next.some((session) => session.id === current) ? current : next[0]?.id ?? null));
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to load conversations.'); }
  }, [adapter]);

  useEffect(() => { void refreshSessions(); }, [refreshSessions]);
  function newChat() { setInputs((current) => ({ ...current, __new__: '' })); setNewChatActive(true); setActiveSessionId(null); setError(''); }
  function selectSession(id: string) { setNewChatActive(false); setActiveSessionId(id); setError(''); }

  async function send(contentOverride?: string, replaceFromMessageId?: string, context?: unknown) {
    const content = (contentOverride ?? input).trim();
    if (!content) return;
    let sessionId = newChatActive ? null : activeSessionId;
    if (!sessionId) {
      try {
        const session = await adapter.createSession();
        sessionId = session.id;
        setSessions((current) => [session, ...current]);
        setActiveSessionId(session.id);
        setNewChatActive(false);
      } catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to create conversation.'); return; }
    }
    if (drafts[sessionId]?.streaming) return;
    const createdAt = new Date().toISOString();
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: 'user', content, createdAt };
    const answerMessage: ChatMessage = { id: crypto.randomUUID(), role: 'assistant', content: '', createdAt };
    const branchIndex = replaceFromMessageId ? activeSession?.messages.findIndex((message) => message.id === replaceFromMessageId) ?? -1 : -1;
    const branchMessages = branchIndex >= 0 ? activeSession?.messages.slice(0, branchIndex) ?? [] : activeSession?.messages ?? [];
    dispatchDraft({ type: 'start', sessionId, messages: [...branchMessages, userMessage, answerMessage] });
    setInputs((current) => ({ ...current, [inputKey]: '', [sessionId]: '' })); setError('');
    try {
      await adapter.send({ sessionId, content, model, context, replaceFromMessageId, signal: new AbortController().signal, onDelta: (delta) => dispatchDraft({ type: 'delta', sessionId, messageId: answerMessage.id, delta }) });
      await refreshSessions();
      dispatchDraft({ type: 'finish', sessionId });
    } catch (caught) {
      dispatchDraft({ type: 'fail', sessionId, messageId: answerMessage.id, error: caught instanceof Error ? caught.message : 'Chat request failed.' });
    }
  }

  async function updateSession(session: Session, values: Partial<Pick<Session, 'title' | 'pinned'>>) {
    try { await adapter.updateSession(session.id, values); await refreshSessions(activeSessionId || undefined); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to update conversation.'); }
  }

  async function deleteSession(session: Session) {
    try { await adapter.deleteSession(session.id); dispatchDraft({ type: 'remove', sessionId: session.id }); setInputs((current) => { const { [session.id]: _, ...remaining } = current; return remaining; }); if (activeSessionId === session.id) newChat(); await refreshSessions(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to delete conversation.'); }
  }

  return { sessions, activeSessionId, newChatActive, input, streaming, error: activeError, messages, setInput, setError, newChat, selectSession, refreshSessions, send, updateSession, deleteSession };
}

export function useChatPreferences<Model extends string>({ themeKey, modelKey, sidebarWidthKey, defaultTheme, defaultModel, parseModel }: {
  themeKey: string; modelKey: string; sidebarWidthKey: string; defaultTheme: ChatTheme; defaultModel: Model; parseModel: (stored: string | null) => Model;
}) {
  const [theme, setTheme] = useState<ChatTheme>(() => { const stored = window.localStorage.getItem(themeKey); return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : defaultTheme; });
  const [model, setModel] = useState<Model>(() => parseModel(window.localStorage.getItem(modelKey)) || defaultModel);
  const [sidebarWidth, setSidebarWidth] = useState(() => { const saved = Number(window.localStorage.getItem(sidebarWidthKey)); return Number.isFinite(saved) && saved > 0 ? Math.min(420, Math.max(240, saved)) : 280; });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.matchMedia('(max-width: 780px)').matches);
  useEffect(() => { document.documentElement.dataset.theme = theme; window.localStorage.setItem(themeKey, theme); }, [theme, themeKey]);
  useEffect(() => { window.localStorage.setItem(modelKey, model); }, [model, modelKey]);
  useEffect(() => { const timer = window.setTimeout(() => window.localStorage.setItem(sidebarWidthKey, String(sidebarWidth)), 120); return () => window.clearTimeout(timer); }, [sidebarWidth, sidebarWidthKey]);
  return { theme, setTheme, model, setModel, sidebarWidth, setSidebarWidth, sidebarCollapsed, setSidebarCollapsed };
}

export function MarkdownText({ content }: { content: string }) {
  return <div className="chat-rich-text"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    p: ({ children }) => {
      const items = Children.toArray(children).filter((child) => typeof child !== 'string' || child.trim());
      const standaloneStrong = items.length === 1 && isValidElement(items[0]) && items[0].type === 'strong';
      return <p className={standaloneStrong ? 'standalone-strong' : undefined}>{children}</p>;
    },
    table: ({ children }) => <div className="chat-table-scroll"><table>{children}</table></div>,
  }}>{normalizeChatMarkdown(content)}</ReactMarkdown></div>;
}
export function ThinkingIndicator() { return <span className="chat-thinking" role="status" aria-label="Thinking"><span>Thinking</span><i /><i /><i /></span>; }

// TODO: Add notebook creation and persistence when the shared notebook domain is ready.
export function ChatNotebookNav() {
  return <section className="chat-notebooks" aria-label="Notebooks"><div>Notebooks</div><button type="button" disabled title="Notebook creation is coming soon"><Plus size={25} />New notebook</button></section>;
}

export function ChatSidebar(props: { brand: string; brandIcon: ReactNode; sessions: ChatSession[]; interviews?: Array<{ id: string; jd: string; createdAt: string }>; activeInterviewId?: string | null; onSelectInterview?: (id: string) => void; activeSessionId: string | null; width: number; onWidthChange: (width: number) => void; onCollapse: () => void; onNewChat: () => void; onSelectSession: (id: string) => void; onSettings: () => void; nav?: ReactNode; status?: ReactNode; onPin?: (session: ChatSession) => void; onRename?: (session: ChatSession) => void; onDelete?: (session: ChatSession) => void }) {
  const [menu, setMenu] = useState<string | null>(null); const drag = useRef<{ x: number; width: number; next: number } | null>(null); const frame = useRef<number | null>(null); const sidebar = useRef<HTMLElement | null>(null);
  const sessions = [...props.sessions].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  function flushWidth() { if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null; } if (drag.current) props.onWidthChange(drag.current.next); drag.current = null; }
  return <aside ref={sidebar} className="chat-sidebar" style={{ width: props.width }}><div className="chat-brand">{props.brandIcon}<span>{props.brand}</span><button className="chat-icon chat-sidebar-close" title="Collapse sidebar" onClick={props.onCollapse}><PanelLeftClose size={19} /></button></div><nav className="chat-nav"><button onClick={props.onNewChat}><Plus size={25} />New chat</button>{props.nav}</nav><ChatNotebookNav /><div className="chat-recents"><div className="chat-recents-title">Recents</div>{sessions.length ? sessions.map((session) => <div className={session.id === props.activeSessionId ? 'chat-session active' : 'chat-session'} key={session.id}><button onClick={() => props.onSelectSession(session.id)}>{session.pinned && <Pin size={12} fill="currentColor" />}<span>{session.title}</span></button>{(props.onPin || props.onRename || props.onDelete) && <div className="chat-session-more"><button title="Conversation options" onClick={() => setMenu(menu === session.id ? null : session.id)}><MoreHorizontal size={17} /></button>{menu === session.id && <div className="chat-session-menu">{props.onPin && <button onClick={() => props.onPin?.(session)}><Pin size={15} />{session.pinned ? 'Unpin' : 'Pin'}</button>}{props.onRename && <button onClick={() => props.onRename?.(session)}><Pencil size={15} />Rename</button>}{props.onDelete && <button className="danger" onClick={() => props.onDelete?.(session)}><Trash2 size={15} />Delete</button>}</div>}</div>}</div>) : <p>No conversations yet.</p>}{props.interviews?.length ? <><div className="chat-recents-title chat-interviews-title">Interviews</div>{props.interviews.map((interview) => <button className={interview.id === props.activeInterviewId ? 'chat-interview active' : 'chat-interview'} key={interview.id} onClick={() => props.onSelectInterview?.(interview.id)}><span>{interview.jd.split(/\s+/).slice(0, 5).join(' ') || 'Live interview'}</span><small>{new Date(interview.createdAt).toLocaleDateString()}</small></button>)}</> : null}</div><div className="chat-sidebar-footer"><span>{props.status}</span><button className="chat-icon" title="Settings" onClick={props.onSettings}><Settings2 size={18} /></button></div><div className="chat-resize" onPointerDown={(event) => { drag.current = { x: event.clientX, width: props.width, next: props.width }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={(event) => { if (!drag.current) return; drag.current.next = Math.min(420, Math.max(240, drag.current.width + event.clientX - drag.current.x)); if (frame.current !== null) return; frame.current = requestAnimationFrame(() => { const width = drag.current?.next; const shell = sidebar.current?.parentElement; if (width !== undefined) { sidebar.current?.style.setProperty('width', `${width}px`); if (shell?.style.getPropertyValue('--app-sidebar-width')) shell.style.setProperty('--app-sidebar-width', `${width}px`); else if (shell?.classList.contains('app-shell')) shell.style.gridTemplateColumns = `${width}px minmax(0, 1fr)`; } frame.current = null; }); }} onPointerUp={flushWidth} onLostPointerCapture={flushWidth} /></aside>;
}

export function ChatConversation(props: { messages: ChatMessage[]; input: string; streaming: boolean; error?: string; model: string; models: ChatModelOption[]; placeholder: string; empty: ReactNode; askTarget?: string; onInputChange: (value: string) => void; onModelChange: (id: string) => void; onSend: (content: string, replaceFromMessageId?: string) => void; renderContent?: (content: string) => ReactNode; leading?: ReactNode; onEdit?: (message: ChatMessage, content: string) => void }) {
  const [modelOpen, setModelOpen] = useState(false); const [editing, setEditing] = useState<ChatMessage | null>(null); const [showLatest, setShowLatest] = useState(false); const [expanded, setExpanded] = useState(false); const [selectionMenu, setSelectionMenu] = useState<{ text: string; messageId: string; x: number; y: number } | null>(null); const [quote, setQuote] = useState<{ text: string; messageId: string } | null>(null); const list = useRef<HTMLDivElement>(null); const input = useRef<HTMLTextAreaElement>(null); const modelMenu = useRef<HTMLDivElement>(null); const following = useRef(true);
  useLayoutEffect(() => { if (following.current && list.current) list.current.scrollTop = list.current.scrollHeight; }, [props.messages, props.streaming]);
  useLayoutEffect(() => { if (!input.current) return; input.current.style.height = 'auto'; const height = Math.min(input.current.scrollHeight, 144); input.current.style.height = `${height}px`; setExpanded(Boolean(props.input) && height > 28); }, [props.input]);
  useEffect(() => {
    if (!modelOpen) return;
    const close = (event: MouseEvent) => { if (!modelMenu.current?.contains(event.target as Node)) setModelOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [modelOpen]);
  useEffect(() => {
    if (!selectionMenu) return;
    const close = (event: MouseEvent) => { if (!(event.target instanceof Element) || !event.target.closest('.chat-selection-ask')) setSelectionMenu(null); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [selectionMenu]);
  useEffect(() => { if (quote && !props.messages.some((message) => message.id === quote.messageId)) setQuote(null); }, [props.messages, quote]);
  function readSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return setSelectionMenu(null);
    const anchor = (selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement)?.closest<HTMLElement>('.chat-message.assistant');
    const focus = (selection.focusNode instanceof Element ? selection.focusNode : selection.focusNode?.parentElement)?.closest<HTMLElement>('.chat-message.assistant');
    if (!anchor || anchor !== focus || !list.current?.contains(anchor)) return setSelectionMenu(null);
    const text = selection.toString().trim().replace(/\s+/g, ' ');
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    if (!text || !rect.width) return setSelectionMenu(null);
    setSelectionMenu({ text: text.slice(0, 4000), messageId: anchor.dataset.messageId || '', x: Math.min(window.innerWidth - 90, Math.max(90, rect.left + rect.width / 2)), y: Math.max(8, rect.top - 8) });
  }
  function askSelection() { if (!selectionMenu) return; setQuote({ text: selectionMenu.text, messageId: selectionMenu.messageId }); setSelectionMenu(null); window.getSelection()?.removeAllRanges(); requestAnimationFrame(() => input.current?.focus()); }
  function send(content: string) { const question = content.trim(); if (!question || props.streaming) return; props.onSend(quoteChatPrompt(quote?.text || '', question)); setQuote(null); }
  const composerClass = `chat-composer${expanded ? ' expanded' : ''}${quote ? ' quoted' : ''}`;
  return <section className="chat-conversation"><div className="chat-transcript" ref={list} onMouseUp={() => requestAnimationFrame(readSelection)} onKeyUp={readSelection} onScroll={() => { setSelectionMenu(null); if (!list.current) return; following.current = list.current.scrollHeight - list.current.scrollTop - list.current.clientHeight <= 24; setShowLatest(!following.current); }}>{props.messages.length ? props.messages.map((message) => <article className={`chat-message ${message.role}`} data-message-id={message.id} key={message.id}>{editing?.id === message.id ? <div className="chat-editor"><textarea autoFocus value={editing.content} onChange={(e) => setEditing({ ...editing, content: e.target.value })} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { props.onEdit?.(message, editing.content); setEditing(null); } if (e.key === 'Escape') setEditing(null); }} /><div><button onClick={() => setEditing(null)}>Cancel</button><button disabled={!editing.content.trim() || props.streaming} onClick={() => { props.onEdit?.(message, editing.content); setEditing(null); }}>Send</button></div></div> : <><div className="chat-message-body">{message.content ? (props.renderContent?.(message.content) || <MarkdownText content={message.content} />) : props.streaming && message.role === 'assistant' ? <ThinkingIndicator /> : null}</div>{message.content && <div className="chat-message-actions"><button title="Copy message" aria-label="Copy message" onClick={() => navigator.clipboard.writeText(message.content)}><Copy size={16} /></button>{message.role === 'user' && props.onEdit && <button title="Edit message" aria-label="Edit message" onClick={() => setEditing(message)}><Pencil size={16} /></button>}</div>}</>}</article>) : <div className="chat-empty">{props.empty}</div>}{props.error && <div className="chat-error">{props.error}</div>}</div>{selectionMenu && <button className="chat-selection-ask" style={{ left: selectionMenu.x, top: selectionMenu.y }} onMouseDown={(event) => event.preventDefault()} onClick={askSelection}><Quote size={15} />Ask {props.askTarget || 'Assistant'}</button>}<button className={showLatest ? 'chat-scroll-latest visible' : 'chat-scroll-latest'} title="Back to latest message" aria-label="Back to latest message" onClick={() => { following.current = true; list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' }); setShowLatest(false); }}><ArrowDown size={18} /></button><div className={composerClass}>{quote && <div className="chat-composer-quote"><Quote size={15} /><span>{quote.text}</span><button title="Remove quote" aria-label="Remove quote" onClick={() => setQuote(null)}><X size={16} /></button></div>}{props.leading}<textarea ref={input} rows={1} value={props.input} onChange={(e) => props.onInputChange(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(props.input); } }} placeholder={props.placeholder} /><div ref={modelMenu} className={modelOpen ? 'chat-model open' : 'chat-model'}><button type="button" aria-haspopup="menu" aria-expanded={modelOpen} onClick={() => setModelOpen(!modelOpen)}>{props.models.find((item) => item.id === props.model)?.name || props.model}<ChevronDown size={16} /></button>{modelOpen && <div className="chat-model-menu" role="menu">{props.models.map((option) => <button role="menuitem" className={option.id === props.model ? 'selected' : ''} key={option.id} onClick={() => { props.onModelChange(option.id); setModelOpen(false); }}><strong>{option.name}</strong>{option.detail && <span>{option.detail}</span>}</button>)}</div>}</div><button className="chat-send" title="Send" aria-label="Send" disabled={!props.input.trim() || props.streaming} onClick={() => send(props.input)}><SendHorizontal size={19} /></button></div></section>;
}
