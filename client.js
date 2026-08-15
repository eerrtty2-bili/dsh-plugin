// ============================================================================
// Codex auto-importer 鈥?CLIENT half: control panel inside the cordis_run card.
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
          React.createElement('div', { style: { fontWeight: 600, marginBottom: 4 } }, 'Codex 瀵硅瘽鑷姩瀵煎叆'),
          React.createElement('div', { style: row },
            '鏁版嵁婧? ',
            React.createElement('code', { style: { wordBreak: 'break-all' } }, s.codexRoot || '鈥?),
            s.manualRoot ? React.createElement('span', { style: muted }, ' (鎵嬪姩)') : null,
          ),
          React.createElement('div', { style: row },
            React.createElement('span', { style: badge }, s.scanning ? '鎵弿涓€? : '寰呮満'),
            s.lastScanAt ? ' 涓婃鎵弿 ' + new Date(s.lastScanAt).toLocaleTimeString() : '',
            lastScan ? (' 路 鏂板鍏?' + lastScan.created + ' 路 鏇存柊 ' + lastScan.updated + ' 路 璺宠繃 ' + lastScan.skipped + ' 路 閿欒 ' + lastScan.errors) : '',
            files !== undefined ? React.createElement('span', { style: muted }, ' (鎵弿 ' + files + ' 涓枃浠?/ ' + (lastScan ? lastScan.threads : '?') + ' 涓嚎绋?') : null,
          ),
          s.lastError ? React.createElement('div', { style: { ...err, marginTop: 4 } }, String(s.lastError)) : null,
          recent.length > 0 ? React.createElement('div', { style: { ...row, marginTop: 6 } },
            React.createElement('div', { style: muted }, '鏈€杩戝鍏?'),
            recent.map((it) => React.createElement('div', { key: it.id, style: row },
              '鈥?',
              React.createElement('span', { style: { fontWeight: 500 } }, it.title || it.id),
              React.createElement('span', { style: muted }, ' (' + (it.kind === 'created' ? '鏂板缓' : '鏇存柊') + ' ' + it.count + ' 鏉?'),
            )),
          ) : null,
          React.createElement('div', { style: { ...row, display: 'flex', gap: 6, marginTop: 8 } },
            React.createElement('input', {
              value: root,
              onChange: (e) => setRoot(e.target.value),
              placeholder: 'Codex 鐩綍锛堥粯璁?~/.codex锛?,
              style: input,
            }),
            React.createElement('button', { onClick: doSetRoot, disabled: busy, style: btn }, '搴旂敤'),
            React.createElement('button', { onClick: doScan, disabled: busy, style: btn }, busy ? '鈥? : '绔嬪嵆鎵弿'),
          ),
        );
      },
    ));
  },
};