// ============================================================================
// Codex auto-importer — CLIENT half: control panel inside the cordis_run card.
// ============================================================================
return {
  inject: ['timer'],
  apply(ctx) {
    const slots = ctx.get('slots');
    if (slots === undefined) return;
    slots.inject('tool.view.cordis', () => slots.register(
      { name: 'tool.view.cordis', key: 'self' },
      (props) => {
        const [status, setStatus] = React.useState(null);
        const [root, setRoot] = React.useState('');
        const [busy, setBusy] = React.useState(false);

        React.useEffect(() => {
          let alive = true;
          const refresh = () => {
            host.call('codex.status', {}).then((s) => {
              if (!alive || s === null || typeof s !== 'object') return;
              setStatus(s);
              if (s.codexRoot) setRoot(s.codexRoot);
            }).catch((e) => console.error('codex status', e));
          };
          refresh();
          let disposer = null;
          try { disposer = ctx.interval(refresh, 5000); } catch (e) { /* timer unavailable */ }
          return () => { alive = false; if (disposer) disposer(); };
        }, []);

        const run = (fn) => {
          setBusy(true);
          fn().then((s) => { if (s && typeof s === 'object') setStatus(s); })
            .catch((e) => console.error(e))
            .then(() => setBusy(false));
        };
        const doScan = () => run(() => host.call('codex.scan', {}));
        const doSetRoot = () => run(() => host.call('codex.setRoot', { path: root }));
        const doForget = () => run(() => host.call('codex.forget', {}));

        const s = status || {};
        const lastScan = s.lastScan || null;
        const recent = Array.isArray(s.recent) ? s.recent : [];
        const style = { fontFamily: 'system-ui, sans-serif', fontSize: 13, lineHeight: 1.55, color: 'inherit' };
        const row = { margin: '4px 0' };
        const muted = { opacity: 0.55 };
        const badge = { background: 'rgba(128,128,128,0.18)', borderRadius: 4, padding: '1px 6px', fontSize: 12 };
        const err = { color: '#c0392b', whiteSpace: 'pre-wrap' };
        const btn = { padding: '3px 10px', borderRadius: 4, border: '1px solid rgba(128,128,128,0.4)', background: 'transparent', cursor: 'pointer', fontSize: 12 };
        const input = { flex: 1, minWidth: 0, padding: '3px 6px', borderRadius: 4, border: '1px solid rgba(128,128,128,0.4)', background: 'transparent', color: 'inherit', fontSize: 12 };

        const files = s.totalFiles;
        return React.createElement('div', { style },
          React.createElement('div', { style: { fontWeight: 600, marginBottom: 4 } }, 'Codex 对话自动导入'),
          React.createElement('div', { style: row },
            '数据源: ',
            React.createElement('code', { style: { wordBreak: 'break-all' } }, s.codexRoot || '…'),
            s.manualRoot ? React.createElement('span', { style: muted }, ' (手动)') : null,
          ),
          React.createElement('div', { style: row },
            React.createElement('span', { style: badge }, s.scanning ? '扫描中…' : '待机'),
            s.lastScanAt ? ' 上次扫描 ' + new Date(s.lastScanAt).toLocaleTimeString() : '',
            lastScan ? (' · 新导入 ' + lastScan.created + ' · 更新 ' + lastScan.updated + ' · 跳过 ' + lastScan.skipped + ' · 错误 ' + lastScan.errors) : '',
            files !== undefined ? React.createElement('span', { style: muted }, ' (扫描 ' + files + ' 个文件 / ' + (lastScan ? lastScan.threads : '?') + ' 个线程)') : null,
            s.ignoredCount ? React.createElement('span', { style: muted }, ' · 已忽略 ' + s.ignoredCount) : null,
          ),
          s.lastError ? React.createElement('div', { style: { ...err, marginTop: 4 } }, String(s.lastError)) : null,
          recent.length > 0 ? React.createElement('div', { style: { ...row, marginTop: 6 } },
            React.createElement('div', { style: muted }, '最近导入:'),
            recent.map((it) => React.createElement('div', { key: it.id, style: row },
              '• ',
              React.createElement('span', { style: { fontWeight: 500 } }, it.title || it.id),
              React.createElement('span', { style: muted }, ' (' + (it.kind === 'created' ? '新建' : '更新') + ' ' + it.count + ' 条)'),
            )),
          ) : null,
          React.createElement('div', { style: { ...row, display: 'flex', gap: 6, marginTop: 8 } },
            React.createElement('input', {
              value: root,
              onChange: (e) => setRoot(e.target.value),
              placeholder: 'Codex 目录（默认 ~/.codex）',
              style: input,
            }),
            React.createElement('button', { onClick: doSetRoot, disabled: busy, style: btn }, '应用'),
            React.createElement('button', { onClick: doScan, disabled: busy, style: btn }, busy ? '…' : '立即扫描'),
          ),
          s.ignoredCount ? React.createElement('div', { style: { ...row, display: 'flex', gap: 6 } },
            React.createElement('span', { style: { ...muted, flex: 1 } }, '已忽略 ' + s.ignoredCount + ' 个被删除的会话，不再重新导入'),
            React.createElement('button', { onClick: doForget, disabled: busy, style: btn }, '恢复全部'),
          ) : null,
        );
      },
    ));
  },
};
