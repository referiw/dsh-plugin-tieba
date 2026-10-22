window.__ModuleLoader__.load({
  id: 'dsh-plugin-tieba',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const inject = ['slots'];

    const API = {
      config: '/tieba/api/config',
      status: '/tieba/api/status',
      start: '/tieba/api/login/start',
      poll: '/tieba/api/login/poll',
      cancel: '/tieba/api/login/cancel',
    };

    const S = {
      wrap: { padding: '18px 20px', maxWidth: 760 },
      h: { fontSize: 15, fontWeight: 600, margin: '18px 0 8px' },
      row: { display: 'flex', alignItems: 'center', gap: 10, margin: '8px 0' },
      label: { width: 150, fontSize: 13, opacity: 0.85 },
      input: { width: 120, padding: '4px 8px', fontSize: 13, border: '1px solid rgba(128,128,128,.35)',
               borderRadius: 6, background: 'transparent', color: 'inherit' },
      select: { padding: '4px 8px', fontSize: 13, border: '1px solid rgba(128,128,128,.35)',
                borderRadius: 6, background: 'transparent', color: 'inherit' },
      btnMain: { padding: '5px 14px', fontSize: 13, borderRadius: 6, cursor: 'pointer',
                 border: 'none', background: '#2b6cff', color: '#fff' },
      badge: (ok) => ({ display: 'inline-block', padding: '2px 10px', borderRadius: 999, fontSize: 12,
                        background: ok ? 'rgba(40,167,69,.15)' : 'rgba(220,53,69,.15)',
                        color: ok ? '#28a745' : '#dc3545' }),
      hint: { fontSize: 12, opacity: 0.6, marginTop: 4 },
      qrBox: { marginTop: 12, padding: 12, border: '1px dashed rgba(128,128,128,.4)',
               borderRadius: 8, display: 'inline-block' },
      account: { display: 'flex', alignItems: 'center', gap: 12, margin: '6px 0 4px' },
      avatar: { width: 44, height: 44, borderRadius: '50%', objectFit: 'cover',
                border: '1px solid rgba(128,128,128,.3)', flex: '0 0 auto' },
      name: { fontSize: 14, fontWeight: 600, lineHeight: 1.3 },
      sub: { fontSize: 12, opacity: 0.6, lineHeight: 1.3 },
    };

    const fmt = (v) => (typeof v === 'number' ? String(v) : v == null ? '' : v);

    const FIELDS = [
      { k: 'sampleMode', t: 'select', label: '抽样方式',
        options: [['dynamic', '动态（越长比例越低）'], ['fixed', '固定层数'], ['ratio', '固定比例'], ['all', '全读']] },
      { k: 'sampleMin', t: 'number', label: '动态下限（层）', show: (c) => c.sampleMode === 'dynamic' },
      { k: 'sampleMax', t: 'number', label: '动态上限（层）', show: (c) => c.sampleMode === 'dynamic' },
      { k: 'sampleFixed', t: 'number', label: '固定层数', show: (c) => c.sampleMode === 'fixed' },
      { k: 'sampleRatio', t: 'number', label: '固定比例（0~1）', show: (c) => c.sampleMode === 'ratio' },
      { k: 'truncateText', t: 'checkbox', label: '截断过长楼层' },
      { k: 'maxTextChars', t: 'number', label: '每层保留字数', show: (c) => c.truncateText },
      { k: 'imageMaxArea', t: 'number', label: '图片像素面积上限' },
      { k: 'imageMaxWidth', t: 'number', label: '图片最大宽度' },
      { k: 'imageMaxHeight', t: 'number', label: '图片最大高度' },
      { k: 'gapMs', t: 'number', label: '请求间隔（毫秒）' },
      { k: 'cacheTtlMs', t: 'number', label: '缓存有效期（毫秒）' },
      { k: 'maxPages', t: 'number', label: '最多抓取页数' },
    ];

    function Page() {
      const h = React.createElement;
      const [cfg, setCfg] = React.useState(null);
      const [status, setStatus] = React.useState(null);
      const [msg, setMsg] = React.useState('');
      const [login, setLogin] = React.useState({ state: 'idle', tick: 0 });
      const [qrErr, setQrErr] = React.useState('');
      const [qr, setQr] = React.useState('');

      const loadCfg = React.useCallback(async () => {
        try {
          const r = await fetch(API.config, { credentials: 'include' });
          setCfg(await r.json());
        } catch (e) { setMsg('读取配置失败：' + e.message); }
      }, []);

      const loadStatus = React.useCallback(async () => {
        try {
          const r = await fetch(API.status, { credentials: 'include' });
          const s = await r.json().catch(() => ({}));
          const v = (!r.ok || s.error) ? { loggedIn: false, reason: 'status_error', hint: String(s.error || ('HTTP ' + r.status)) } : s;
          setStatus(v);
          return v;
        } catch (e) {
          setStatus({ loggedIn: false, reason: 'status_failed', hint: '检查登录态失败：' + e.message });
          return null;
        }
      }, []);

      React.useEffect(() => { loadCfg(); loadStatus(); }, [loadCfg, loadStatus]);

      React.useEffect(() => {
        if (login.state !== 'pending') return undefined;
        const started = Date.now();
        const t = setInterval(async () => {
          if (Date.now() - started > 150000) {
            clearInterval(t);
            setLogin({ state: 'idle', tick: 0 });
            setMsg('二维码可能已过期，点「重新扫码登录」重开');
            return;
          }
          try {
            const r = await fetch(API.poll, { credentials: 'include' });
            const s = await r.json().catch(() => ({}));
            // 服务端出错时必须显示出来：静默重试会让界面永远停在"未登录"
            if (!r.ok || s.error) {
              clearInterval(t);
              setLogin({ state: 'idle', tick: 0 });
              setMsg('登录轮询出错：' + String(s.error || ('HTTP ' + r.status)));
              return;
            }
            if (s.state === 'ok') {
              clearInterval(t);
              setLogin({ state: 'ok', tick: 0 });
              setMsg('登录成功，正在读取账号信息…');
              const st = await loadStatus();
              setMsg(st && st.loggedIn
                ? '已登录' + (st.nickname || st.user ? '：' + (st.nickname || st.user) : '')
                : 'cookie 已保存，但账号信息没读到，稍后刷新看看');
            } else if (s.state === 'idle') {
              clearInterval(t);
              setLogin({ state: 'idle', tick: 0 });
              setMsg('登录会话已结束');
              loadStatus();
            } else if (s.state === 'captcha') {
              clearInterval(t);
              setLogin({ state: 'idle', tick: 0 });
              setMsg('百度弹了图形验证码，这次扫码没通过——重试一次，或改用 node src/login.mjs');
            } else {
              // 二维码随轮询一起下发（只有画面变了才带），不再单独加载图片
              if (s.qr) setQr(s.qr);
              setLogin((p) => ({ state: 'pending', tick: p.tick + 1 }));
            }
          } catch (e) { /* 网络抖动：下一轮再试 */ }
        }, 2000);
        return () => clearInterval(t);
      }, [login.state, loadStatus]);

      const save = async (patch) => {
        try {
          const r = await fetch(API.config, {
            method: 'POST', credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          });
          setCfg(await r.json());
          setMsg('已保存');
          setTimeout(() => setMsg(''), 1500);
        } catch (e) { setMsg('保存失败：' + e.message); }
      };

      const startLogin = async () => {
        setMsg('启动登录浏览器…');
        setQrErr('');
        setQr('');
        try {
          const r = await fetch(API.start, { method: 'POST', credentials: 'include' });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) {
            // fetch 对 4xx/5xx 不抛异常：不看 r.ok 就会把失败当成"已就绪"，界面切到待扫码、二维码却是空的
            const detail = String(j.error || ('HTTP ' + r.status));
            setLogin({ state: 'idle', tick: 0 });
            setMsg('启动失败：' + detail);
            setQrErr(/Executable doesn't exist|playwright install/i.test(detail)
              ? '登录用的浏览器还没下载。在插件目录执行 npx playwright install chromium，然后重试。'
              : '登录浏览器启动失败：' + detail);
            return;
          }
          setLogin({ state: 'pending', tick: 0 });
          setMsg('请用百度 App 扫码');
        } catch (e) {
          setLogin({ state: 'idle', tick: 0 });
          setMsg('启动失败：' + e.message);
        }
      };

      if (!cfg) return h('div', { style: S.wrap }, '加载中…');

      const fieldRow = (f) => {
        if (f.show && !f.show(cfg)) return null;
        if (f.t === 'checkbox') {
          return h('div', { style: S.row, key: f.k },
            h('span', { style: S.label }, f.label),
            h('input', { type: 'checkbox', checked: !!cfg[f.k],
              onChange: (e) => save({ [f.k]: e.target.checked }) }));
        }
        if (f.t === 'select') {
          return h('div', { style: S.row, key: f.k },
            h('span', { style: S.label }, f.label),
            h('select', { style: S.select, value: cfg[f.k], onChange: (e) => save({ [f.k]: e.target.value }) },
              f.options.map(([v, t]) => h('option', { key: v, value: v }, t))));
        }
        return h('div', { style: S.row, key: f.k },
          h('span', { style: S.label }, f.label),
          h('input', { style: S.input, type: 'number', value: fmt(cfg[f.k]),
            onChange: (e) => setCfg(Object.assign({}, cfg, { [f.k]: e.target.value })),
            onBlur: (e) => save({ [f.k]: Number(e.target.value) }) }));
      };

      return h('div', { style: S.wrap },
        h('div', { style: S.h }, '账号'),
        h('div', { style: S.account },
          status && status.avatar
            ? h('img', { src: status.avatar, style: S.avatar, alt: '头像' })
            : h('div', { style: Object.assign({}, S.avatar, { background: 'rgba(128,128,128,.15)' }) }),
          h('div', { style: { display: 'flex', flexDirection: 'column', minWidth: 0 } },
            h('div', { style: S.name },
              status && (status.nickname || status.user) ? (status.nickname || status.user) : '未登录'),
            h('div', { style: S.sub },
              status && status.user ? '贴吧 ID：' + status.user : (status ? '—' : '检查中…'))),
          h('span', { style: S.badge(status && status.loggedIn) },
            status ? (status.loggedIn ? '已登录' : '未登录') : '…'),
          h('button', { style: S.btnMain, onClick: startLogin }, '重新扫码登录')),
        status && !status.loggedIn && status.hint ? h('div', { style: S.hint }, status.hint) : null,

        msg ? h('div', { style: Object.assign({}, S.hint, { marginTop: 8, color: '#2b6cff' }) }, msg) : null,

        login.state === 'pending'
          ? h('div', { style: S.qrBox },
              h('div', { style: { fontSize: 12, marginBottom: 8 } }, '用百度 App 扫码，扫完在手机上确认'),
              qr
                ? h('img', {
                    src: qr,
                    style: { width: 240, height: 'auto', display: 'block' },
                    alt: '登录二维码',
                  })
                : h('div', { style: S.hint }, '正在打开登录页，二维码马上出来…'),
              qrErr
                ? h('div', { style: { fontSize: 12, color: '#dc3545', marginTop: 8, lineHeight: 1.5 } }, qrErr)
                : null,
              h('div', { style: S.hint }, '二维码随轮询自动刷新；关掉页面即取消登录'))
          : null,

        qrErr && login.state !== 'pending'
          ? h('div', { style: { fontSize: 12, color: '#dc3545', marginTop: 8, lineHeight: 1.5 } }, qrErr)
          : null,

        h('div', { style: S.h }, '抽样'),
        FIELDS.filter((f) => ['sampleMode', 'sampleMin', 'sampleMax', 'sampleFixed', 'sampleRatio'].indexOf(f.k) >= 0).map(fieldRow),

        h('div', { style: S.h }, '输出'),
        FIELDS.filter((f) => ['truncateText', 'maxTextChars'].indexOf(f.k) >= 0).map(fieldRow),
        h('div', { style: S.hint }, '关掉截断时，超长楼层会完整返回（可能很占上下文）'),

        h('div', { style: S.h }, '图片'),
        FIELDS.filter((f) => ['imageMaxArea', 'imageMaxWidth', 'imageMaxHeight'].indexOf(f.k) >= 0).map(fieldRow),
        h('div', { style: S.hint }, '超过像素面积上限的图会等比缩小，原始尺寸记录在 .meta.json'),

        h('div', { style: S.h }, '网络与缓存'),
        FIELDS.filter((f) => ['gapMs', 'cacheTtlMs', 'maxPages'].indexOf(f.k) >= 0).map(fieldRow));
    }

    function apply(ctx) {
      try {
        const register = (id) => {
          try {
            const off = ctx.slots.register(
              { name: 'settings.section', id: id, order: 210, label: '贴吧' },
              Page
            );
            return typeof off === 'function' ? off : () => {};
          } catch (e) { return null; }
        };
        try {
          ctx.slots.inject('settings.section', () =>
            register('tieba') || register('tieba-config') || (() => {}));
        } catch (e) { /* 静默 */ }
      } catch (e) { /* 绝不把异常穿回宿主 */ }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
