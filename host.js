// ============================================================================
// Codex (ChatGPT) conversation auto-importer 鈥?HOST half (pkg-13)
// Streaming window reads (no size cap), thread-aware merging, live-session
// skip, self-healing append conflicts, cross-platform paths.
// ============================================================================
const SEP = /[\\/]+/;
const dirname = (p) => {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i <= 0 ? p : p.slice(0, i);
};
const basename = (p) => {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i < 0 ? p : p.slice(i + 1);
};
const join = (a, b) => {
  if (!a) return b;
  if (!b) return a;
  const sep = a.indexOf('\\') >= 0 ? '\\' : '/';
  return a.replace(/[\\/]+$/, '') + sep + b.replace(/^[\\/]+/, '');
};
const isAbsolute = (p) => typeof p === 'string' && (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\'));

const MAX_RECORDS_PER_PASS = 30000;
const MAPPER_VERSION = 5;

const hashing = (s) => {
  let h = 5381;
  const t = String(s);
  for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};
const sanitizeId = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'unknown';
const capText = (s, max) => {
  const t = typeof s === 'string' ? s : String(s);
  if (t.length <= max) return t;
  return t.slice(0, max) + '\n鈥鍐呭宸叉埅鏂璢';
};
const parseTimestamp = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return Date.now();
};
const textOf = (b) => (b && typeof b === 'object' && typeof b.text === 'string') ? b.text : '';
const textFromBlocks = (blocks) => {
  if (!Array.isArray(blocks)) return '';
  const parts = [];
  for (const b of blocks) if (b && typeof b === 'object' && typeof b.text === 'string') parts.push(b.text);
  return parts.join('\n');
};
const extractMcpResult = (result) => {
  if (!result || typeof result !== 'object') return String(result);
  if (Object.hasOwn(result, 'Ok')) {
    const ok = result.Ok;
    if (ok && typeof ok === 'object' && Array.isArray(ok.content)) return textFromBlocks(ok.content);
    if (ok && typeof ok === 'object') {
      try { return JSON.stringify(ok); } catch (e) { return String(ok); }
    }
    return String(ok);
  }
  if (Object.hasOwn(result, 'Err')) return '閿欒: ' + String(result.Err);
  try { return JSON.stringify(result); } catch (e) { return String(result); }
};
const summarizeChanges = (changes) => {
  if (!changes || typeof changes !== 'object') return '';
  const names = Object.keys(changes);
  if (names.length === 0) return '';
  return '鏀瑰姩鏂囦欢: ' + names.join(', ');
};

return {
  inject: ['fs', 'sessionPersistence', 'settings', 'timer'],
  apply(ctx) {
    const fs = ctx.fs;
    const persistence = ctx.sessionPersistence;
    const settings = ctx.settings;
    const workspaceRegistry = ctx.get('workspaceRegistry');
    const timer = ctx.timer;
    console.log('codex-import host apply() started');

    const state = {
      codexRoot: null,
      manualRoot: false,
      scanning: null,
      lastScanAt: null,
      lastScan: null,
      recent: [],
      lastError: null,
      errors: [],
      files: new Map(),
      fileIds: new Map(),
      watermarkCache: new Map(),
    };

    const pushError = (entry) => {
      state.errors.push(entry);
      if (state.errors.length > 30) state.errors.shift();
    };

    async function deriveCodexRoot() {
      if (state.manualRoot) return state.codexRoot;
      let home = null;
      try {
        const docPath = settings.documentPath;
        console.log('codex derive: settings.documentPath =', String(docPath));
        if (typeof docPath === 'string' && docPath.length > 0) {
          home = dirname(dirname(docPath));
        }
      } catch (e) {
        console.log('codex derive: settings.documentPath error', String(e));
      }
      console.log('codex derive: home =', String(home));
      const candidates = [];
      if (home) candidates.push(join(home, '.codex'));
      for (const c of candidates) {
        try {
          const target = await fs.resolve(c);
          const info = await fs.stat(target);
          if (info && info.type === 'directory') {
            console.log('codex derive: found root', c);
            return c;
          }
          console.log('codex derive: candidate not a directory', c, info && info.type);
        } catch (e) {
          console.log('codex derive: candidate error', c, String(e));
        }
      }
      return candidates[0] || null;
    }

    async function collectSessionFiles(root) {
      const out = [];
      for (const dirName of ['sessions', 'archived_sessions', 'rollouts']) {
        try {
          const dirTarget = await fs.resolve(join(root, dirName));
          const info = await fs.stat(dirTarget);
          if (!info || info.type !== 'directory') continue;
          await walkDir(dirTarget, out, 0);
        } catch (e) { /* directory missing */ }
      }
      console.log('codex collect: found', out.length, 'jsonl files');
      return out;
    }
    async function walkDir(target, out, depth) {
      if (depth > 6) return;
      let entries;
      try { entries = await fs.listDir(target); } catch (e) { return; }
      for (const entry of entries) {
        if (entry.type === 'directory') await walkDir(entry.target, out, depth + 1);
        else if (entry.type === 'file' && /\.jsonl$/i.test(entry.name)) {
          out.push({ path: entry.target.displayPath, target: entry.target, size: entry.size });
        }
      }
    }

    async function extractFileId(file) {
      try {
        const stream = await fs.streamText(file.target);
        let buffer = '';
        for await (const chunk of stream) {
          buffer += chunk;
          for (const line of buffer.split('\n')) {
            if (!line.trim()) continue;
            try {
              const o = JSON.parse(line);
              if (o.type === 'session_meta') {
                const p = o.payload || {};
                return p.session_id || p.id || null;
              }
              if (o.type === 'session_start') return o.id || null;
            } catch (e) { /* partial tail line */ }
          }
          if (buffer.length > 512 * 1024) break;
        }
      } catch (e) { /* read failure */ }
      return null;
    }

    async function groupThreads(files) {
      const byId = new Map();
      const groups = [];
      for (const file of files) {
        let id = null;
        const cached = state.fileIds.get(file.path);
        if (cached !== undefined && cached.size === file.size) id = cached.id;
        else {
          id = await extractFileId(file);
          state.fileIds.set(file.path, { id, size: file.size });
        }
        if (id) {
          if (!byId.has(id)) byId.set(id, []);
          byId.get(id).push(file);
        } else {
          groups.push({ id: null, files: [file] });
        }
      }
      for (const [id, list] of byId) {
        list.sort((a, b) => basename(a.path).localeCompare(basename(b.path)));
        groups.push({ id, files: list });
      }
      return groups;
    }

    async function loadThreadTitles(root) {
      const titles = new Map();
      try {
        const target = await fs.resolve(join(root, 'session_index.jsonl'));
        const info = await fs.stat(target);
        if (!info || info.type !== 'file') return titles;
        const text = await fs.readText(target);
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try {
            const o = JSON.parse(line);
            if (o && typeof o.id === 'string' && typeof o.thread_name === 'string' && o.thread_name.trim()) {
              titles.set(o.id, o.thread_name.trim());
            }
          } catch (e) { /* skip */ }
        }
      } catch (e) { /* no index */ }
      return titles;
    }

    function extractMeta(parsed) {
      let id = null, cwd = null, createdAt = Date.now();
      let format = 'cli';
      let hasEventUser = false;
      for (let i = 0; i < parsed.length; i++) {
        const record = parsed[i].record;
        const t = record.type;
        if (t === 'session_meta') {
          const p = record.payload || {};
          if (id === null) id = typeof p.session_id === 'string' ? p.session_id : (typeof p.id === 'string' ? p.id : null);
          if (typeof p.cwd === 'string' && cwd === null) cwd = p.cwd;
          createdAt = parseTimestamp(p.timestamp);
          format = 'desktop';
        } else if (t === 'session_start') {
          if (id === null) id = typeof record.id === 'string' ? record.id : null;
          if (typeof record.cwd === 'string' && cwd === null) cwd = record.cwd;
          createdAt = parseTimestamp(record.timestamp);
          format = 'cli';
        }
        if (t === 'event_msg' || t === 'response_item' || t === 'turn_context') format = 'desktop';
        if (t === 'event_msg' && record.payload && record.payload.type === 'user_message') hasEventUser = true;
      }
      return { id, cwd, createdAt, format, useEventUserMessages: format === 'desktop' && hasEventUser };
    }

    function findWatermark(events) {
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        if (e.type === 'codex/import' && e.data && typeof e.data.line === 'number') return e.data;
      }
      return null;
    }
    function nextTurnFromLog(events) {
      let t = 1;
      for (const e of events) if (e.type === 'turn/end') t = e.data.turn + 1;
      return t;
    }

    async function readWindow(file, fromLine, maxRecords) {
      const parsed = [];
      let buf = '';
      let lineIndex = -1;
      let seen = 0;
      let done = false;
      const processLine = (raw) => {
        lineIndex++;
        const line = raw.trim();
        if (!line) return;
        let record;
        try { record = JSON.parse(line); } catch (e) { return; }
        seen++;
        if (seen > fromLine && parsed.length < maxRecords) parsed.push({ line: lineIndex, record });
      };
      try {
        const stream = await fs.streamText(file.target);
        for await (const chunk of stream) {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            processLine(buf.slice(0, idx));
            buf = buf.slice(idx + 1);
            if (parsed.length >= maxRecords) { done = true; break; }
          }
          if (done) break;
        }
        if (!done && buf.trim()) processLine(buf);
      } catch (e) {
        console.log('codex readWindow error:', file.path, String((e && e.message) || e));
      }
      return { parsed, eof: !done, nextLine: fromLine + parsed.length };
    }

    function mapSegment(parsed, fromLine, meta, turnState, maxRecords) {
      const events = [];
      let openTurn = null, openStep = null, step = 0;
      let currentTurnId = null;
      let pendingReasoning = [];
      let pendingResult = null;
      let lastCommandCallId = null;
      const stepCalls = new Set();
      const assistantSeen = new Set();
      let firstUserText = null;
      let curTime = Date.now();
      let lastLine = fromLine - 1;
      let processed = 0;
      const isDesktop = meta.format === 'desktop';

      const ev = (type, data) => ({ type, time: curTime, data });
      const closeStep = () => {
        if (openStep !== null) {
          events.push(ev('step/end', { turn: openTurn, step: openStep }));
          openStep = null;
        }
      };
      const ensureTurn = (tid, forceNew) => {
        if (!forceNew && openTurn !== null && (tid === undefined || tid === currentTurnId)) return;
        closeStep();
        if (openTurn !== null) events.push(ev('turn/end', { turn: openTurn, reason: { kind: 'completed' } }));
        openTurn = turnState.nextTurn++;
        currentTurnId = tid === undefined ? null : tid;
        events.push(ev('turn/start', { turn: openTurn }));
        step = 0;
        openStep = null;
        stepCalls.clear();
      };
      const closeTurn = () => {
        closeStep();
        if (openTurn !== null) {
          events.push(ev('turn/end', { turn: openTurn, reason: { kind: 'completed' } }));
          openTurn = null;
        }
      };
      const openStepIfNeeded = () => {
        if (openStep === null) {
          step += 1;
          events.push(ev('step/start', { turn: openTurn, step }));
          openStep = step;
        }
      };
      const flushResult = () => {
        if (pendingResult === null) return;
        openStepIfNeeded();
        const callId = pendingResult.callId;
        if (!stepCalls.has(callId)) {
          events.push(ev('tool/call', { turn: openTurn, step: openStep, callId, name: 'codex_tool', arguments: '{}' }));
          stepCalls.add(callId);
        }
        events.push({
          type: 'tool/result',
          time: curTime,
          data: {
            turn: openTurn,
            step: openStep,
            message: {
              id: 'codex-tr-' + hashing(callId + ':' + openTurn + ':' + openStep),
              role: 'user',
              content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: capText(pendingResult.text, 200000) }], isError: false }],
              source: { kind: 'tool', callId },
            },
          },
          surfaceOp: 'append',
        });
        pendingResult = null;
      };
      const emitUser = (text, id, tid, forceNew) => {
        ensureTurn(tid, forceNew);
        const t = capText(text, 120000);
        if (firstUserText === null && t) firstUserText = t;
        events.push({
          type: 'user/message',
          time: curTime,
          data: { id: id || ('codex-u-' + hashing(t)), role: 'user', content: [{ type: 'text', text: t }], source: { kind: 'user' } },
          surfaceOp: 'append',
        });
      };
      const emitAssistant = (text, id, provider, model, tid) => {
        ensureTurn(tid, false);
        openStepIfNeeded();
        const blocks = [];
        if (pendingReasoning.length > 0) {
          const r = pendingReasoning.join('\n\n');
          if (r.trim()) blocks.push({ type: 'reasoning', text: capText(r, 20000) });
          pendingReasoning = [];
        }
        const clean = typeof text === 'string' ? text : '';
        if (clean.trim()) blocks.push({ type: 'text', text: capText(clean, 120000) });
        if (blocks.length === 0) return;
        const key = clean.trim() ? hashing(clean) : null;
        if (key !== null && isDesktop && assistantSeen.has(key)) return;
        if (key !== null) assistantSeen.add(key);
        events.push({
          type: 'assistant/message',
          time: curTime,
          data: {
            turn: openTurn,
            step: openStep,
            message: {
              id: id || ('codex-a-' + (key || hashing(openTurn + ':' + step))),
              role: 'assistant',
              content: blocks,
              source: { kind: 'model', provider: provider || 'openai', model: model || 'codex' },
            },
          },
          surfaceOp: 'append',
        });
      };
      const emitToolCall = (name, args, callId) => {
        ensureTurn(undefined, false);
        openStepIfNeeded();
        flushResult();
        let a = args;
        if (typeof a !== 'string') { try { a = JSON.stringify(a); } catch (e) { a = String(a); } }
        events.push(ev('tool/call', { turn: openTurn, step: openStep, callId, name: name || 'tool', arguments: capText(a || '', 20000) }));
        stepCalls.add(callId);
      };
      const emitToolCallIfAbsent = (name, args, callId) => {
        if (stepCalls.has(callId)) return;
        emitToolCall(name, args, callId);
      };
      const enqueueResult = (callId, text) => {
        ensureTurn(undefined, false);
        if (pendingResult !== null && pendingResult.callId === callId) {
          pendingResult.text += '\n' + (text || '');
        } else {
          flushResult();
          pendingResult = { callId, text: text || '' };
        }
      };

      for (let pi = 0; pi < parsed.length; pi++) {
        const { line, record } = parsed[pi];
        if (line < fromLine) continue;
        if (processed >= maxRecords) break;
        processed++;
        lastLine = line;
        if (record && typeof record.timestamp !== 'undefined') curTime = parseTimestamp(record.timestamp);
        const t = record.type;
        if (isDesktop) {
          if (t === 'turn_context') {
            const tid = record.payload && record.payload.turn_id;
            if (typeof tid === 'string' && tid !== currentTurnId) ensureTurn(tid, false);
            continue;
          }
          if (t === 'event_msg') {
            const p = record.payload || {};
            if (p.type === 'user_message') emitUser(p.message || '', null, undefined, false);
            else if (p.type === 'agent_message') emitAssistant(p.message || '', null, null, null, undefined);
            else if (p.type === 'agent_reasoning' && typeof p.text === 'string' && p.text) pendingReasoning.push(p.text);
            else if (p.type === 'mcp_tool_call_end') {
              const inv = p.invocation || {};
              const server = typeof inv.server === 'string' && inv.server ? inv.server : 'mcp';
              const toolName = typeof inv.tool === 'string' && inv.tool ? inv.tool : 'tool';
              emitToolCallIfAbsent('mcp.' + server + '.' + toolName, inv.arguments, p.call_id);
              enqueueResult(p.call_id, extractMcpResult(p.result));
            } else if (p.type === 'patch_apply_end') {
              const parts = [];
              if (typeof p.stdout === 'string' && p.stdout) parts.push(p.stdout);
              if (typeof p.stderr === 'string' && p.stderr) parts.push(p.stderr);
              const ch = summarizeChanges(p.changes);
              if (ch) parts.push(ch);
              emitToolCallIfAbsent('apply_patch', JSON.stringify({ files: (p.changes && typeof p.changes === 'object') ? Object.keys(p.changes) : [] }), p.call_id);
              enqueueResult(p.call_id, parts.join('\n'));
            }
            continue;
          }
          if (t === 'response_item') {
            const p = record.payload || {};
            if (p.type === 'message') {
              if (p.role === 'assistant') emitAssistant(textFromBlocks(p.content), p.id, null, null, undefined);
              else if (p.role === 'user' && !meta.useEventUserMessages) emitUser(textFromBlocks(p.content), p.id, undefined, false);
            } else if (p.type === 'agent_message') {
              emitAssistant(textFromBlocks(p.content), p.id, null, null, undefined);
            } else if (p.type === 'reasoning') {
              if (Array.isArray(p.summary)) for (const s of p.summary) { const tx = textOf(s); if (tx) pendingReasoning.push(tx); }
            } else if (p.type === 'function_call') {
              emitToolCall(p.name, p.arguments, p.call_id);
            } else if (p.type === 'function_call_output') {
              enqueueResult(p.call_id, p.output || '');
            } else if (p.type === 'custom_tool_call') {
              emitToolCall(p.name, p.input, p.call_id);
            } else if (p.type === 'custom_tool_call_output') {
              enqueueResult(p.call_id, p.output || '');
            }
            continue;
          }
          continue;
        }
        if (t === 'user_message') {
          emitUser(textFromBlocks(record.content), record.id, undefined, true);
        } else if (t === 'agent_message') {
          const rs = record.reasoning_summary;
          if (typeof rs === 'string' && rs) pendingReasoning.push(rs);
          emitAssistant(textFromBlocks(record.content), record.id, record.provider, record.model, undefined);
        } else if (t === 'agent_reasoning') {
          const tx = (typeof record.message === 'string' && record.message) || (record.metadata && record.metadata.reasoning_summary) || '';
          if (tx) pendingReasoning.push(tx);
        } else if (t === 'tool_call') {
          emitToolCall(record.name, record.arguments, record.call_id);
        } else if (t === 'tool_call_output') {
          enqueueResult(record.call_id, record.output || '');
        } else if (t === 'command') {
          const callId = 'cmd-' + (record.id || hashing((record.command || '') + ':' + line));
          lastCommandCallId = callId;
          emitToolCall('run_shell', record.command, callId);
        } else if (t === 'command_output') {
          enqueueResult(lastCommandCallId || ('cmd-' + (record.id || hashing('out:' + line))), record.output || '');
        }
      }
      flushResult();
      closeTurn();
      return { events, nextTurn: turnState.nextTurn, firstUserText, lastLine };
    }

    function buildEvents(events, baseSeq) {
      return events.map((e, i) => Object.assign({}, e, { seq: baseSeq + i }));
    }

    async function importThread(group, titles, report) {
      const files = group.files;
      const sessionId = 'codex-' + (group.id ? sanitizeId(group.id) : 'file-' + sanitizeId(basename(files[0].path).replace(/\.jsonl$/i, '')));

      try {
        const liveStore = ctx.get('sessions');
        if (liveStore !== undefined && typeof liveStore.get === 'function' && liveStore.get(sessionId) !== undefined) {
          report.skipped++;
          return null;
        }
      } catch (e) { /* ignore */ }

      let entry = state.watermarkCache.get(sessionId);
      if (entry === undefined) {
        const headers = await persistence.list();
        const exists = headers.some((h) => h.id === sessionId);
        if (exists) {
          let inspected;
          try { inspected = await persistence.inspect(sessionId); } catch (e) {
            report.skipped++;
            return null;
          }
          const wm = findWatermark(inspected.events);
          if (!wm) {
            report.skipped++;
            return null;
          }
          let fi = typeof wm.fi === 'number' ? wm.fi : files.findIndex((f) => f.path === wm.src);
          if (fi < 0 || fi >= files.length) fi = 0;
          entry = { fi, line: wm.line, nextTurn: nextTurnFromLog(inspected.events), nextSeq: inspected.events.length, exists: true };
          state.watermarkCache.set(sessionId, entry);
        } else {
          entry = { fi: 0, line: 0, nextTurn: 1, nextSeq: 0, exists: false };
          state.watermarkCache.set(sessionId, entry);
        }
      }
      if (entry.fi < 0 || entry.fi >= files.length) entry.fi = files.length - 1;

      const lastFile = files[files.length - 1];
      const lastCached = state.files.get(lastFile.path);
      if (entry.fi >= files.length - 1 && lastCached !== undefined
        && lastCached.size !== undefined && lastFile.size !== undefined && lastCached.size === lastFile.size
        && lastCached.eof === true && entry.line >= (lastCached.nextLine ?? Infinity)) {
        report.skipped++;
        return null;
      }

      const turnState = { nextTurn: entry.nextTurn };
      const wasNew = !entry.exists;
      const events = [];
      let meta = null;
      let firstUserText = null;
      let fi = entry.fi;
      let line = entry.line;
      let consumedAll = false;

      while (fi < files.length) {
        const file = files[fi];
        const cached = state.files.get(file.path);
        if (cached !== undefined && cached.size !== undefined && file.size !== undefined
          && cached.size === file.size && cached.eof === true && line >= (cached.nextLine ?? Infinity)) {
          if (fi === files.length - 1) { consumedAll = true; break; }
          fi++;
          line = 0;
          continue;
        }
        const w = await readWindow(file, line, MAX_RECORDS_PER_PASS);
        state.files.set(file.path, { size: file.size, eof: w.eof, nextLine: w.nextLine });
        if (w.parsed.length === 0) {
          if (w.eof) { fi++; line = 0; continue; }
          break;
        }
        const m = extractMeta(w.parsed);
        if (meta === null) meta = m;
        const window = mapSegment(w.parsed, 0, m, turnState, MAX_RECORDS_PER_PASS);
        for (const e of window.events) events.push(e);
        if (firstUserText === null) firstUserText = window.firstUserText;
        line = w.nextLine;
        if (!w.eof) {
          consumedAll = false;
          break;
        }
        fi++;
        line = 0;
      }
      if (fi >= files.length) {
        fi = files.length - 1;
        consumedAll = true;
      }
      const finalFi = fi;
      const finalLine = consumedAll ? (state.files.get(files[files.length - 1].path)?.nextLine ?? line) : line;

      if (events.length === 0) {
        entry.fi = finalFi;
        entry.line = finalLine;
        state.watermarkCache.set(sessionId, entry);
        report.skipped++;
        return null;
      }

      const baseSeq = entry.exists ? entry.nextSeq : 0;
      const seqd = buildEvents(events, baseSeq);
      let title = null;
      if (wasNew) {
        title = (group.id && titles.get(group.id)) || firstUserText || basename(files[0].path).replace(/\.jsonl$/i, '');
        title = capText(String(title || '').replace(/\s+/g, ' ').trim(), 80);
        if (title) {
          seqd.push({ type: 'session/title', seq: baseSeq + seqd.length, time: Date.now(), data: { title, messageSeqs: [], source: { kind: 'user' } } });
        }
      }
      seqd.push({ type: 'codex/import', seq: baseSeq + seqd.length, time: Date.now(), data: { src: files[finalFi].path, line: finalLine, fi: finalFi, at: new Date().toISOString(), v: MAPPER_VERSION }, ignorable: true });

      if (wasNew) {
        const header = { version: 0, id: sessionId, createdAt: meta ? meta.createdAt : Date.now() };
        if (meta && isAbsolute(meta.cwd)) header.cwd = meta.cwd;
        try {
          await persistence.create(header);
        } catch (e) {
          console.log('codex create raced:', sessionId, String(e));
          try { const insp = await persistence.inspect(sessionId); entry.nextSeq = insp.events.length; entry.nextTurn = nextTurnFromLog(insp.events); entry.exists = true; } catch (e2) { /* ignore */ }
        }
      }
      try {
        await persistence.append(sessionId, seqd);
      } catch (e) {
        state.watermarkCache.delete(sessionId);
        report.skipped++;
        console.log('codex append skipped:', sessionId, String((e && e.message) || e));
        return null;
      }

      entry.exists = true;
      entry.nextSeq = baseSeq + seqd.length;
      entry.nextTurn = turnState.nextTurn;
      entry.fi = finalFi;
      entry.line = finalLine;
      state.watermarkCache.set(sessionId, entry);

      if (meta && isAbsolute(meta.cwd) && workspaceRegistry !== undefined) {
        try {
          const ws = await workspaceRegistry.create(meta.cwd);
          if (ws && typeof ws.attachSession === 'function') await ws.attachSession(sessionId);
        } catch (e) { /* workspace attach is best-effort */ }
      }

      if (wasNew) report.created++; else report.updated++;
      return { id: sessionId, title: title || null, kind: wasNew ? 'created' : 'updated', count: events.length, time: Date.now() };
    }

    async function scanOnce() {
      if (state.scanning !== null) return state.scanning;
      state.scanning = (async () => {
        state.lastError = null;
        const report = { scanned: 0, threads: 0, created: 0, updated: 0, skipped: 0, errors: 0, recent: [] };
        try {
          const root = await deriveCodexRoot();
          state.codexRoot = root;
          if (!root) {
            state.lastError = '鏈壘鍒?Codex 鏁版嵁鐩綍锛堥粯璁?~/.codex锛夈€傚彲鍦ㄤ笅鏂硅緭鍏ヨ矾寰勫悗鐐瑰嚮鈥滃簲鐢ㄢ€濄€?;
            console.log('codex scan: no root found');
            return;
          }
          console.log('codex scan start:', root);
          const files = await collectSessionFiles(root);
          const groups = await groupThreads(files);
          const titles = await loadThreadTitles(root);
          report.scanned = files.length;
          report.threads = groups.length;
          for (const group of groups) {
            try {
              const r = await importThread(group, titles, report);
              if (r !== null && (r.kind === 'created' || r.kind === 'updated')) report.recent.push(r);
            } catch (e) {
              report.errors++;
              const msg = String((e && e.message) || e);
              pushError({ file: group.files[0].path, message: msg });
              console.log('codex import error:', group.id, msg);
            }
          }
          state.recent = report.recent.slice(0, 20);
          state.lastScan = report;
          state.lastScanAt = Date.now();
          console.log('codex scan done:', JSON.stringify(report));
        } catch (e) {
          state.lastError = String((e && e.message) || e);
          console.log('codex scan fatal:', String(state.lastError));
        } finally {
          state.scanning = null;
        }
      })();
      return state.scanning;
    }

    function buildReport() {
      return {
        codexRoot: state.codexRoot,
        manualRoot: state.manualRoot,
        scanning: state.scanning !== null,
        lastScanAt: state.lastScanAt,
        lastScan: state.lastScan,
        recent: state.recent.slice(0, 20),
        lastError: state.lastError,
        errors: state.errors.slice(-10),
        totalFiles: state.lastScan ? state.lastScan.scanned : null,
      };
    }

    ctx.effect(() => harness.handle('codex.status', async () => buildReport()));
    ctx.effect(() => harness.handle('codex.scan', async () => { await scanOnce(); return buildReport(); }));
    ctx.effect(() => harness.handle('codex.setRoot', async (args) => {
      const p = args && typeof args.path === 'string' ? args.path.trim() : '';
      if (p) {
        try {
          const target = await fs.resolve(p);
          const info = await fs.stat(target);
          if (info && info.type === 'directory') {
            state.codexRoot = target.displayPath || p;
            state.manualRoot = true;
          } else {
            state.lastError = '璺緞涓嶆槸鐩綍: ' + p;
            return buildReport();
          }
        } catch (e) {
          state.lastError = '璺緞涓嶅彲鐢? ' + p;
          return buildReport();
        }
      } else {
        state.manualRoot = false;
        state.codexRoot = null;
      }
      await scanOnce();
      return buildReport();
    }));

    // ---- model-visible tools: query / trigger the import ----
    const statusTool = harness.defineTool({
      name: 'codex_import_status',
      description: '鏌ョ湅 Codex 瀵硅瘽鑷姩瀵煎叆鎻掍欢鐨勭姸鎬侊細鏁版嵁婧愩€佷笂娆℃壂鎻忕粨鏋滐紙鏂板鍏?鏇存柊/璺宠繃/閿欒锛夈€佹渶杩戝鍏ョ殑浼氳瘽涓庨敊璇垪琛ㄣ€?,
      parameters: { type: 'object', properties: {} },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
        },
      },
      async execute() {
        return buildReport();
      },
    });
    ctx.effect(() => harness.registerTool(ctx, statusTool));
    const scanTool = harness.defineTool({
      name: 'codex_import_now',
      description: '绔嬪嵆鎵ц涓€娆?Codex 浼氳瘽鎵弿瀵煎叆锛屽苟杩斿洖鎵弿鎶ュ憡锛堟柊瀵煎叆/鏇存柊/璺宠繃/閿欒鏁颁笌鏈€杩戝鍏ュ垪琛級銆?,
      parameters: { type: 'object', properties: {} },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
        },
      },
      async execute() {
        await scanOnce();
        return buildReport();
      },
    });
    ctx.effect(() => harness.registerTool(ctx, scanTool));

    const runScan = () => scanOnce().catch((e) => { state.lastError = String((e && e.message) || e); });
    ctx.effect(() => timer.timeout(runScan, 600));
    ctx.effect(() => timer.interval(runScan, 30000));
  },
};