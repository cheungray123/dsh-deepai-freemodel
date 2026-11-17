window.__ModuleLoader__.load({
  id: "dsh-deepai-freemodel",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const NS = "dsh-deepai-freemodel";
    const API = "/api/deepai";
    const REQUEST_TIMEOUT_MS = 20_000;
    const POLL_IDLE_MS = 8_000;
    const POLL_LOGIN_MS = 1_200;

    // ------------------------------------------------------------ i18n

    const ZH = {
      nav: "DeepAI 免费模型",
      title: "DeepAI 免费模型",
      subtitle: "用 DeepAI Code 账号的免费额度直连上游模型，无需安装桌面客户端。",
      accountSection: "账号",
      signedOutHint: "还没有授权。点「用浏览器登录」完成一次授权，之后无需重复登录。",
      login: "用浏览器登录",
      loggingIn: "等待浏览器授权…",
      reauthorize: "重新授权",
      logout: "退出登录",
      signedInAs: "已登录",
      signedOut: "未登录",
      proPlan: "Pro",
      freePlan: "免费额度",
      obtainedAt: "授权于",
      keyLabel: "Key",
      manualKeyTitle: "手动填写 API Key",
      manualKeyHint: "浏览器授权走不通时的退路。填 deepai.org 控制台里的 Key，保存后立即验证。",
      manualKeyPlaceholder: "粘贴 API Key",
      save: "保存并验证",
      saving: "验证中…",
      cancel: "取消",
      copyLink: "复制链接",
      copied: "已复制",
      openLink: "在浏览器中打开",
      loginPending: "浏览器里完成 Google 登录后，这个页面会自动变好。",
      remaining: "剩余",
      diagSection: "连接诊断",
      lane: "车道",
      machine: "机器指纹",
      known: "已识别",
      unknown: "未识别",
      catalogSource: "目录来源",
      catalogLive: "上游实时",
      catalogCache: "本地缓存",
      catalogFallback: "内置快照",
      proxy: "出口代理",
      proxyOff: "未配置",
      proxyConfigured: "已设置但未启用",
      upstream: "上游地址",
      instance: "实例",
      lastError: "最近错误",
      selftest: "连通自检",
      selftestHint: "逐步跑一遍：指纹 → 凭据 → 车道 → 目录 → 推理。哪一步红了一目了然。",
      selftestRun: "运行自检",
      selftestRunning: "自检中…",
      selftestOk: "全部通过",
      selftestFail: "有步骤失败",
      modelSection: "可用模型",
      modelHint: "来自上游实时目录。名字带「免费」表示每次请求不扣 Theos。",
      modelSearch: "筛选模型…",
      modelEmpty: "没有匹配的模型",
      refreshModels: "刷新目录",
      refreshing: "刷新中…",
      free: "免费",
      paid: "付费",
      vision: "图像",
      thinking: "思考",
      contextWindow: "上下文",
      maxTokens: "最大输出",
      loading: "加载中…",
      retry: "重试",
      error: "错误",
      hint: "提示",
      yes: "是",
      no: "否",
      refresh: "刷新",
      close: "关闭",
      requestTimeout: "请求设置页接口超时，请重试",
      modelsCount: "共 {n} 个模型"
    };

    const EN = {
      nav: "DeepAI Free Models",
      title: "DeepAI Free Models",
      subtitle: "Talk to DeepAI Code models on the free tier, directly — no desktop app required.",
      accountSection: "Account",
      signedOutHint: "Not connected yet. Sign in through the browser once and you're set.",
      login: "Sign in with browser",
      loggingIn: "Waiting for browser…",
      reauthorize: "Re-authorize",
      logout: "Sign out",
      signedInAs: "Signed in as",
      signedOut: "Not connected",
      proPlan: "Pro",
      freePlan: "Free tier",
      obtainedAt: "Authorized",
      keyLabel: "Key",
      manualKeyTitle: "Paste an API key",
      manualKeyHint: "Fallback when browser sign-in cannot complete. Paste a key from the deepai.org console; it is verified on save.",
      manualKeyPlaceholder: "Paste API key",
      save: "Save and verify",
      saving: "Verifying…",
      cancel: "Cancel",
      copyLink: "Copy link",
      copied: "Copied",
      openLink: "Open in browser",
      loginPending: "Finish the Google sign-in in your browser; this page updates itself.",
      remaining: "left",
      diagSection: "Diagnostics",
      lane: "Lane",
      machine: "Machine ID",
      known: "detected",
      unknown: "missing",
      catalogSource: "Catalog",
      catalogLive: "live",
      catalogCache: "cached",
      catalogFallback: "built-in snapshot",
      proxy: "Egress proxy",
      proxyOff: "not configured",
      proxyConfigured: "set but inactive",
      upstream: "Upstream",
      instance: "Instance",
      lastError: "Last error",
      selftest: "Connection test",
      selftestHint: "Runs machine ID → credentials → lane → catalog → inference, timing each step.",
      selftestRun: "Run test",
      selftestRunning: "Testing…",
      selftestOk: "All steps passed",
      selftestFail: "Some steps failed",
      modelSection: "Models",
      modelHint: "Live upstream catalog. \"Free\" means no Theos charged per request.",
      modelSearch: "Filter models…",
      modelEmpty: "No matching model",
      refreshModels: "Refresh catalog",
      refreshing: "Refreshing…",
      free: "free",
      paid: "paid",
      vision: "vision",
      thinking: "thinking",
      contextWindow: "Context",
      maxTokens: "Max output",
      loading: "Loading…",
      retry: "Retry",
      error: "Error",
      hint: "Hint",
      yes: "yes",
      no: "no",
      refresh: "Refresh",
      close: "Close",
      requestTimeout: "Settings request timed out; try again",
      modelsCount: "{n} models"
    };

    let runtime;
    const setLocaleRuntime = (next) => {
      runtime = next;
    };
    const isZh = () => {
      try {
        const active = runtime?.getSnapshot?.()?.active ?? "";
        if (active === "") return true;
        return /^zh/i.test(active);
      } catch {
        return true;
      }
    };
    const text = (key, params) => {
      const dict = isZh() ? ZH : EN;
      let value = dict[key] ?? ZH[key] ?? key;
      if (params !== undefined) {
        for (const [k, v] of Object.entries(params)) value = value.replaceAll(`{${k}}`, String(v));
      }
      return value;
    };
    const useLocaleRevision = () =>
      React.useSyncExternalStore(
        (listener) => {
          try {
            const dispose = runtime?.subscribe?.(listener);
            return typeof dispose === "function" ? dispose : () => {};
          } catch {
            return () => {};
          }
        },
        () => {
          try {
            return runtime?.getSnapshot?.()?.revision ?? 0;
          } catch {
            return 0;
          }
        },
        () => 0
      );

    // ------------------------------------------------------------ 样式

    const S = {
      wrap: { display: "flex", flexDirection: "column", gap: 18, fontSize: 13 },
      header: { display: "flex", flexDirection: "column", gap: 4 },
      title: { fontSize: 15, fontWeight: 600, color: "var(--dsw-alias-label-primary)", margin: 0 },
      muted: { fontSize: 12, color: "var(--dsw-alias-label-secondary)", margin: 0, lineHeight: 1.65 },
      section: { display: "flex", flexDirection: "column", gap: 8 },
      h2: { fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)", margin: 0 },
      row: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
      card: {
        padding: "12px 14px",
        borderRadius: 10,
        border: "1px solid var(--dsw-alias-border-l2)",
        display: "flex",
        flexDirection: "column",
        gap: 8
      },
      cardWarn: {
        padding: "10px 12px",
        borderRadius: 10,
        border: "1px solid var(--dsw-alias-border-l2)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        background: "rgba(217, 83, 79, 0.06)"
      },
      code: {
        fontSize: 12,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        color: "var(--dsw-alias-label-secondary)",
        wordBreak: "break-all"
      },
      link: {
        fontSize: 12,
        color: "var(--dsw-alias-label-primary)",
        textDecoration: "underline",
        wordBreak: "break-all"
      },
      name: { fontSize: 13, color: "var(--dsw-alias-label-primary)" },
      tag: {
        padding: "1px 7px",
        borderRadius: 999,
        fontSize: 11,
        border: "1px solid var(--dsw-alias-border-l2)",
        color: "var(--dsw-alias-label-secondary)",
        whiteSpace: "nowrap"
      },
      tagOn: {
        padding: "1px 7px",
        borderRadius: 999,
        fontSize: 11,
        border: "1px solid var(--dsw-alias-border-l2)",
        color: "var(--dsw-alias-label-primary)",
        whiteSpace: "nowrap"
      },
      badgeOk: {
        padding: "2px 9px",
        borderRadius: 999,
        fontSize: 11,
        border: "1px solid rgba(31, 143, 78, 0.45)",
        color: "#1f8f4e"
      },
      badgeOff: {
        padding: "2px 9px",
        borderRadius: 999,
        fontSize: 11,
        border: "1px solid var(--dsw-alias-border-l2)",
        color: "var(--dsw-alias-label-secondary)"
      },
      badgeErr: {
        padding: "2px 9px",
        borderRadius: 999,
        fontSize: 11,
        border: "1px solid rgba(217, 83, 79, 0.45)",
        color: "#d9534f"
      },
      grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 },
      kv: {
        padding: "8px 10px",
        borderRadius: 8,
        border: "1px solid var(--dsw-alias-border-l2)",
        display: "flex",
        flexDirection: "column",
        gap: 2
      },
      kvKey: { fontSize: 11, color: "var(--dsw-alias-label-secondary)" },
      kvValue: { fontSize: 12, color: "var(--dsw-alias-label-primary)", wordBreak: "break-all" },
      input: {
        flex: 1,
        minWidth: 180,
        padding: "6px 9px",
        borderRadius: 8,
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "transparent",
        color: "var(--dsw-alias-label-primary)",
        fontSize: 12,
        outline: "none"
      },
      list: { display: "flex", flexDirection: "column", gap: 6, margin: 0, padding: 0, listStyle: "none" },
      item: {
        padding: "8px 10px",
        borderRadius: 8,
        border: "1px solid var(--dsw-alias-border-l2)",
        display: "flex",
        flexDirection: "column",
        gap: 3
      },
      step: {
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        padding: "7px 10px",
        borderRadius: 8,
        border: "1px solid var(--dsw-alias-border-l2)"
      },
      dotOk: { width: 7, height: 7, borderRadius: 999, background: "#1f8f4e", marginTop: 6, flex: "0 0 auto" },
      dotErr: { width: 7, height: 7, borderRadius: 999, background: "#d9534f", marginTop: 6, flex: "0 0 auto" }
    };

    // ------------------------------------------------------------ 组件

    function Btn(props) {
      const disabled = props.disabled === true;
      const style = {
        padding: "5px 12px",
        borderRadius: 8,
        fontSize: 12,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
        border: props.primary === true ? "none" : "1px solid var(--dsw-alias-border-l2)",
        background: props.primary === true ? "var(--dsw-alias-label-primary)" : "transparent",
        color: props.primary === true ? "var(--dsw-alias-bg-layer-1)" : "var(--dsw-alias-label-primary)"
      };
      return React.createElement(
        "button",
        { type: "button", onClick: props.onClick, disabled, style },
        props.children
      );
    }

    function Tag(props) {
      return React.createElement("span", { style: props.on === true ? S.tagOn : S.tag }, props.children);
    }

    function KV(props) {
      return React.createElement(
        "div",
        { style: S.kv },
        React.createElement("span", { style: S.kvKey }, props.label),
        React.createElement("span", { style: S.kvValue }, props.value)
      );
    }

    function formatTokens(value) {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "—";
      if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
      if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}K`;
      return String(value);
    }

    function formatRemaining(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return "0:00";
      const total = Math.floor(ms / 1000);
      const minutes = Math.floor(total / 60);
      const seconds = total % 60;
      return `${minutes}:${String(seconds).padStart(2, "0")}`;
    }

    async function request(path, method = "GET", body) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(path, {
          method,
          headers: body === undefined ? undefined : { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
          credentials: "same-origin"
        });
        const raw = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(raw?.error ?? `HTTP ${res.status}`);
        return raw;
      } catch (error) {
        // 超时的原始文案是 "The operation was aborted"，对用户没有意义
        if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
          throw new Error(text("requestTimeout"));
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }

    // ------------------------------------------------------------ 页面

    function DeepAISettings() {
      useLocaleRevision();
      const [status, setStatus] = React.useState(null);
      const [error, setError] = React.useState("");
      const [hint, setHint] = React.useState("");
      const [busy, setBusy] = React.useState("");
      const [manualKey, setManualKey] = React.useState("");
      const [showKey, setShowKey] = React.useState(false);
      const [copied, setCopied] = React.useState(false);
      const [probe, setProbe] = React.useState(null);
      const [filter, setFilter] = React.useState("");
      const [now, setNow] = React.useState(() => Date.now());
      const aliveRef = React.useRef(true);
      const timerRef = React.useRef();
      const pendingRef = React.useRef(false);

      const applyStatus = React.useCallback((next) => {
        if (next === null || typeof next !== "object") return;
        pendingRef.current = next.login?.pending === true;
        setStatus(next);
      }, []);

      const refresh = React.useCallback(async () => {
        try {
          const data = await request(`${API}/status`);
          applyStatus(data);
          return data;
        } catch (cause) {
          if (aliveRef.current) {
            setError(cause instanceof Error ? cause.message : String(cause));
          }
          return null;
        }
      }, [applyStatus]);

      React.useEffect(() => {
        aliveRef.current = true;
        let disposed = false;
        const loop = async () => {
          if (disposed) return;
          const data = await refresh();
          if (disposed) return;
          const delay = data?.login?.pending === true ? POLL_LOGIN_MS : POLL_IDLE_MS;
          timerRef.current = setTimeout(loop, delay);
        };
        void loop();
        return () => {
          disposed = true;
          aliveRef.current = false;
          clearTimeout(timerRef.current);
        };
      }, [refresh]);

      // 登录倒计时只在等待时跑，避免常驻 1s 定时器
      const loginPending = status?.login?.pending === true;
      React.useEffect(() => {
        if (!loginPending) return undefined;
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
      }, [loginPending]);

      const run = React.useCallback(
        async (name, fn) => {
          setBusy(name);
          setError("");
          setHint("");
          try {
            return await fn();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
            return undefined;
          } finally {
            if (aliveRef.current) setBusy("");
          }
        },
        []
      );

      const openAuthUrl = (url) => {
        const target = typeof url === "string" ? url : "";
        if (target === "") return false;
        try {
          const opened = window.open(target, "_blank", "noopener,noreferrer");
          return opened !== null;
        } catch {
          return false;
        }
      };

      const startLogin = () =>
        run("login", async () => {
          const res = await request(`${API}/login`, "POST", {});
          if (res.ok !== true) {
            setError(res.error ?? "发起授权失败");
            if (res.hint) setHint(res.hint);
            return;
          }
          const url = res.url || res?.login?.url || "";
          if (!openAuthUrl(url)) {
            setHint(isZh()
              ? "浏览器拦截了自动打开，请点下方「在浏览器中打开」或复制链接。"
              : "The browser blocked auto-open. Use “Open in browser” or copy the link below.");
          }
          await refresh();
        });

      const cancelLogin = () =>
        run("cancel", async () => {
          await request(`${API}/login/cancel`, "POST", {});
          await refresh();
        });

      const logout = () =>
        run("logout", async () => {
          await request(`${API}/logout`, "POST", {});
          setProbe(null);
          await refresh();
        });

      const saveKey = () =>
        run("key", async () => {
          const key = manualKey.trim();
          if (key === "") {
            setError(text("manualKeyPlaceholder"));
            return;
          }
          const res = await request(`${API}/key`, "POST", { apiKey: key });
          if (res.ok !== true) {
            setError(res.error ?? "保存失败");
            return;
          }
          setManualKey("");
          setShowKey(false);
          if (res.warning) setHint(res.warning);
          await refresh();
        });

      const refreshModels = () =>
        run("models", async () => {
          const res = await request(`${API}/models/refresh`, "POST", {});
          if (res.ok !== true && res.error) setError(res.error);
          await refresh();
        });

      const runSelftest = () =>
        run("selftest", async () => {
          setProbe({ pending: true });
          const res = await request(`${API}/selftest`, "POST", { probeChat: true });
          setProbe(res);
          await refresh();
        });

      const copyLink = async () => {
        const url = status?.login?.url ?? "";
        if (url === "") return;
        try {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          setError("复制失败，请手动选中链接复制");
        }
      };

      const signedIn = status?.signedIn === true;
      const account = status?.account ?? null;
      const loginUrl = status?.login?.url ?? "";
      const startedAt = status?.login?.startedAt ?? 0;
      const remaining = startedAt > 0 ? startedAt + 10 * 60 * 1000 - now : 0;

      const models = React.useMemo(() => {
        const list = Array.isArray(status?.models) ? status.models : [];
        const keyword = filter.trim().toLowerCase();
        if (keyword === "") return list;
        return list.filter(
          (model) =>
            String(model.id).toLowerCase().includes(keyword) ||
            String(model.name ?? "").toLowerCase().includes(keyword)
        );
      }, [status, filter]);

      const connectionBadge = () => {
        if (error !== "") return React.createElement("span", { style: S.badgeErr }, text("error"));
        if (signedIn) return React.createElement("span", { style: S.badgeOk }, text("signedInAs") + " " + (account?.username || "OK"));
        return React.createElement("span", { style: S.badgeOff }, text("signedOut"));
      };

      const catalogLabel = () => {
        if (status?.catalogLive === true) return text("catalogLive");
        if (status?.catalogSource === "cache") return text("catalogCache");
        return text("catalogFallback");
      };

      const children = [];

      // 头部
      children.push(
        React.createElement(
          "div",
          { style: S.header, key: "head" },
          React.createElement(
            "div",
            { style: S.row },
            React.createElement("h1", { style: S.title }, text("title")),
            connectionBadge()
          ),
          React.createElement("p", { style: S.muted }, text("subtitle"))
        )
      );

      // 错误条
      if (error !== "" || hint !== "") {
        children.push(
          React.createElement(
            "div",
            { style: S.cardWarn, key: "err" },
            error !== "" &&
              React.createElement(
                "p",
                { style: { ...S.muted, color: "#d9534f" } },
                `${text("error")}：${error}`
              ),
            hint !== "" && React.createElement("p", { style: S.muted }, `${text("hint")}：${hint}`),
            React.createElement(
              "div",
              { style: S.row },
              React.createElement(
                Btn,
                {
                  onClick: () => {
                    setError("");
                    setHint("");
                  }
                },
                text("close")
              )
            )
          )
        );
      }

      // 账号
      const accountChildren = [];
      if (status === null) {
        accountChildren.push(React.createElement("p", { style: S.muted, key: "loading" }, text("loading")));
      } else if (!signedIn) {
        accountChildren.push(React.createElement("p", { style: S.muted, key: "hint" }, text("signedOutHint")));
        accountChildren.push(
          React.createElement(
            "div",
            { style: S.row, key: "actions" },
            React.createElement(
              Btn,
              { primary: true, disabled: busy !== "" || loginPending, onClick: startLogin },
              loginPending ? text("loggingIn") : text("login")
            ),
            React.createElement(
              Btn,
              { disabled: busy !== "" || loginPending, onClick: () => setShowKey((v) => !v) },
              text("manualKeyTitle")
            )
          )
        );
      } else {
        accountChildren.push(
          React.createElement(
            "div",
            { style: S.row, key: "who" },
            React.createElement("span", { style: S.name }, `${text("signedInAs")} ${account?.username || "—"}`),
            React.createElement(
              Tag,
              { on: account?.isPro === true },
              account?.isPro === true ? text("proPlan") : text("freePlan")
            ),
            account?.keyMask ? React.createElement("span", { style: S.code }, `${text("keyLabel")} ${account.keyMask}`) : null
          )
        );
        if (account?.obtainedAt) {
          accountChildren.push(
            React.createElement("span", { style: S.code, key: "at" }, `${text("obtainedAt")} ${account.obtainedAt}`)
          );
        }
        accountChildren.push(
          React.createElement(
            "div",
            { style: S.row, key: "actions" },
            React.createElement(Btn, { disabled: busy !== "" || loginPending, onClick: startLogin }, text("reauthorize")),
            React.createElement(
              Btn,
              { disabled: busy !== "", onClick: refreshModels },
              busy === "models" ? text("refreshing") : text("refreshModels")
            ),
            React.createElement(Btn, { disabled: busy !== "", onClick: logout }, text("logout"))
          )
        );
      }

      // 手动 Key 表单
      if (showKey) {
        accountChildren.push(
          React.createElement(
            "div",
            { style: { ...S.card, marginTop: 2 }, key: "keyform" },
            React.createElement("p", { style: S.muted }, text("manualKeyHint")),
            React.createElement(
              "div",
              { style: S.row },
              React.createElement("input", {
                style: S.input,
                type: "password",
                value: manualKey,
                placeholder: text("manualKeyPlaceholder"),
                autoComplete: "off",
                spellCheck: false,
                onChange: (event) => setManualKey(event.target.value)
              }),
              React.createElement(Btn, { primary: true, disabled: busy !== "", onClick: saveKey }, busy === "key" ? text("saving") : text("save")),
              React.createElement(Btn, { disabled: busy !== "", onClick: () => setShowKey(false) }, text("cancel"))
            )
          )
        );
      }

      children.push(
        React.createElement(
          "div",
          { style: S.section, key: "account" },
          React.createElement("h2", { style: S.h2 }, text("accountSection")),
          React.createElement("div", { style: S.card }, accountChildren)
        )
      );

      // 登录等待
      if (loginPending && loginUrl !== "") {
        children.push(
          React.createElement(
            "div",
            { style: S.card, key: "wait" },
            React.createElement("p", { style: S.muted }, text("loginPending")),
            React.createElement(
              "a",
              { href: loginUrl, target: "_blank", rel: "noreferrer", style: S.link },
              loginUrl
            ),
            React.createElement(
              "div",
              { style: S.row },
              React.createElement(
                Btn,
                { primary: true, onClick: () => openAuthUrl(loginUrl) },
                text("openLink")
              ),
              React.createElement(Btn, { onClick: copyLink }, copied ? text("copied") : text("copyLink")),
              React.createElement(Btn, { disabled: busy !== "", onClick: cancelLogin }, text("cancel")),
              remaining > 0 &&
                React.createElement(
                  "span",
                  { style: S.muted },
                  `${text("remaining")} ${formatRemaining(remaining)}`
                )
            )
          )
        );
      }

      // 诊断
      if (status !== null) {
        children.push(
          React.createElement(
            "div",
            { style: S.section, key: "diag" },
            React.createElement("h2", { style: S.h2 }, text("diagSection")),
            React.createElement(
              "div",
              { style: S.grid },
              React.createElement(KV, { label: text("lane"), value: status.lane || "—" }),
              React.createElement(KV, {
                label: text("machine"),
                value: status.machineReady ? `${text("known")} ${status.machineMasked ?? ""}` : text("unknown")
              }),
              React.createElement(KV, {
                label: text("catalogSource"),
                value: `${catalogLabel()} · ${status.catalogCount ?? 0}`
              }),
              React.createElement(KV, {
                label: text("proxy"),
                value: status.proxy?.enabled
                  ? status.proxy.url || "system"
                  : status.proxy?.configured
                    ? text("proxyConfigured")
                    : text("proxyOff")
              }),
              React.createElement(KV, { label: text("upstream"), value: status.upstream ?? "—" }),
              React.createElement(KV, { label: text("instance"), value: status.instance ?? "—" })
            ),
            status.lastError
              ? React.createElement("p", { style: { ...S.muted, color: "#d9534f" } }, `${text("lastError")}：${status.lastError}`)
              : null
          )
        );
      }

      // 自检
      const probeChildren = [
        React.createElement("p", { style: S.muted, key: "hint" }, text("selftestHint")),
        React.createElement(
          "div",
          { style: S.row, key: "actions" },
          React.createElement(
            Btn,
            { primary: true, disabled: busy !== "", onClick: runSelftest },
            busy === "selftest" ? text("selftestRunning") : text("selftestRun")
          ),
          probe?.steps
            ? React.createElement(
                "span",
                { style: S.tagOn },
                probe.ok === true ? text("selftestOk") : text("selftestFail")
              )
            : null
        )
      ];
      if (Array.isArray(probe?.steps)) {
        probeChildren.push(
          React.createElement(
            "div",
            { style: S.list, key: "steps" },
            ...probe.steps.map((step) =>
              React.createElement(
                "div",
                { style: S.step, key: step.id },
                React.createElement("span", { style: step.ok === true ? S.dotOk : S.dotErr }),
                React.createElement(
                  "div",
                  { style: { display: "flex", flexDirection: "column", gap: 2, flex: 1 } },
                  React.createElement(
                    "div",
                    { style: S.row },
                    React.createElement("span", { style: S.name }, step.label),
                    React.createElement("span", { style: S.code }, `${step.ms} ms`),
                    step.ok !== true ? React.createElement("span", { style: S.tag }, "failed") : null
                  ),
                  step.detail ? React.createElement("span", { style: S.code }, step.detail) : null,
                  step.hint ? React.createElement("span", { style: S.muted }, step.hint) : null
                )
              )
            )
          )
        );
      }
      children.push(
        React.createElement(
          "div",
          { style: S.section, key: "selftest" },
          React.createElement("h2", { style: S.h2 }, text("selftest")),
          React.createElement("div", { style: S.card }, probeChildren)
        )
      );

      // 模型
      const modelChildren = [
        React.createElement(
          "div",
          { style: S.row, key: "tools" },
          React.createElement("input", {
            style: S.input,
            value: filter,
            placeholder: text("modelSearch"),
            onChange: (event) => setFilter(event.target.value)
          }),
          React.createElement(
            "span",
            { style: S.muted },
            text("modelsCount", { n: status?.models?.length ?? 0 })
          )
        )
      ];
      if (models.length === 0) {
        modelChildren.push(
          React.createElement("p", { style: S.muted, key: "empty" }, status === null ? text("loading") : text("modelEmpty"))
        );
      } else {
        modelChildren.push(
          React.createElement(
            "div",
            { style: S.list, key: "list" },
            ...models.map((model) =>
              React.createElement(
                "div",
                { style: S.item, key: model.id },
                React.createElement(
                  "div",
                  { style: S.row },
                  React.createElement("span", { style: S.name }, model.name ?? model.id),
                  React.createElement(Tag, { on: model.free === true }, model.free === true ? text("free") : text("paid")),
                  model.vision === true ? React.createElement(Tag, null, text("vision")) : null,
                  model.reasoning === true ? React.createElement(Tag, null, text("thinking")) : null
                ),
                React.createElement(
                  "span",
                  { style: S.code },
                  `${model.id} · ${text("contextWindow")} ${formatTokens(model.contextWindow)} · ${text("maxTokens")} ${formatTokens(model.maxTokens)}`
                )
              )
            )
          )
        );
      }
      children.push(
        React.createElement(
          "div",
          { style: S.section, key: "models" },
          React.createElement("h2", { style: S.h2 }, text("modelSection")),
          React.createElement("p", { style: S.muted }, text("modelHint")),
          React.createElement("div", { style: S.card }, modelChildren)
        )
      );

      return React.createElement("div", { style: S.wrap }, ...children);
    }

    // ------------------------------------------------------------ 注册

    function registerDictionaries(ctx) {
      try {
        ctx.locale.register(NS, { zh: ZH, en: EN });
        return;
      } catch {
        /* 老版本 API 是逐语言注册 */
      }
      try {
        ctx.locale.register(NS, "zh", ZH);
        ctx.locale.register(NS, "en", EN);
      } catch {
        /* 没有 locale 服务也不致命 */
      }
    }

    function apply(ctx) {
      setLocaleRuntime(ctx.locale);
      if (typeof ctx.effect === "function") {
        try {
          ctx.effect(
            () => {
              registerDictionaries(ctx);
              return () => setLocaleRuntime(undefined);
            },
            "dsh-deepai-freemodel: locale dictionaries"
          );
        } catch {
          registerDictionaries(ctx);
        }
      } else {
        registerDictionaries(ctx);
      }
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: NS,
            order: 14,
            locale: NS,
            label: () => text("nav")
          },
          DeepAISettings
        )
      );
    }

    const inject = ["slots", "locale"];

    exports.NS = NS;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
