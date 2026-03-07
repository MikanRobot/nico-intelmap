// ==UserScript==
// @name         Ingress Intel ニコニコ風コメント
// @namespace    https://github.com/MikanRobot/nico-intelmap
// @version      1.1.4
// @description  Ingress Intel Map上にニコニコ動画風のスクロールコメントを表示する（OpenAI AIツッコミ機能付き）
// @updateURL    https://raw.githubusercontent.com/MikanRobot/nico-intelmap/main/ingress_niconico_comments.user.js
// @downloadURL  https://raw.githubusercontent.com/MikanRobot/nico-intelmap/main/ingress_niconico_comments.user.js
// @match        https://intel.ingress.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // =============================================
    // 設定値
    // =============================================
    const CONFIG = {
        // コメントのスクロール速度 (px/秒)
        scrollSpeed: 198,
        // コメントの基本フォントサイズ (px)
        fontSize: 24,
        // コメントの最大同時表示行数
        maxLanes: 8,
        // コメントが画面に残る最低時間 (ms) ※速度との整合性を取るため実際はスクリーン幅依存
        minDuration: 4000,
        // コメントのオパシティ
        opacity: 0.85,
        // デバッグモード (trueにするとコンソールにログを出す)
        debug: false,
    };

    // =============================================
    // AI用設定
    // =============================================
    const AI_CONFIG = {
        // OpenAIに投げる間隔 (イベント発生時、最低これだけ待つ)
        cooldown: 15000,
        // 1つのプロンプトにまとめる最大イベント数
        maxEvents: 5,
        // AIの文字色
        color: '#ff99ff', // ピンク系
    };

    // =============================================
    // 陣営カラー定義
    // =============================================
    const FACTION_COLORS = {
        RESISTANCE: '#00c8ff',   // 青 (レジスタンス)
        ENLIGHTENED: '#01ff01',  // 緑 (エンライテンド)
        NEUTRAL: '#ffcc00',      // 黄 (ニュートラル)
        MACHINA: '#ff3333',      // 赤 (マキナ/異常)
        SYSTEM: '#ffffff',       // 白 (システム通知)
        ALERT: '#ff4444',        // 赤 (警告)
    };

    // =============================================
    // コメントオーバーレイレイヤーの作成
    // =============================================
    let commentContainer = null;
    let lanes = [];           // 各レーンの次回利用可能時刻

    /**
     * コメントオーバーレイコンテナを初期化する
     */
    function initOverlay() {
        // 既存のコンテナがあれば削除
        const existing = document.getElementById('niconico-overlay');
        if (existing) existing.remove();

        commentContainer = document.createElement('div');
        commentContainer.id = 'niconico-overlay';
        Object.assign(commentContainer.style, {
            position: 'fixed',
            top: '0',
            left: '0',
            width: '100vw',
            height: '100vh',
            pointerEvents: 'none',   // マップ操作を邪魔しない
            overflow: 'hidden',
            zIndex: '10000',
            fontFamily: '"Noto Sans JP", "M PLUS 1p", sans-serif',
        });
        document.body.appendChild(commentContainer);

        // レーン管理の初期化
        lanes = new Array(CONFIG.maxLanes).fill(0);

        // マップ要素にコンテナの位置・サイズを合わせる
        fitToMap();
        log('オーバーレイを初期化しました');
    }

    /**
     * コンテナをIntelマップ要素の表示領域に合わせてリサイズする
     * マップ要素が見つからない場合はトップバー分（60px）を除いた全画面にフォールバック
     */
    function fitToMap() {
        if (!commentContainer) return;

        // Ingress Intel / IITCのマップcanvas要素を探す
        const mapEl = document.getElementById('map_canvas')
            || document.getElementById('map')
            || document.querySelector('.leaflet-container')
            || document.querySelector('#map_canvas');

        if (mapEl) {
            const r = mapEl.getBoundingClientRect();
            Object.assign(commentContainer.style, {
                top: `${r.top}px`,
                left: `${r.left}px`,
                width: `${r.width}px`,
                height: `${r.height}px`,
            });
        } else {
            // フォールバック：ナビゲーションバー分（60px）を除いた領域
            Object.assign(commentContainer.style, {
                top: '60px',
                left: '0',
                width: '100vw',
                height: 'calc(100vh - 60px)',
            });
        }
    }

    // ウィンドウリサイズ時に追従させる
    window.addEventListener('resize', fitToMap);

    // MutationObserverでマップ要素の出現を待って追従
    (function waitForMap() {
        const mapEl = document.getElementById('map_canvas')
            || document.querySelector('.leaflet-container');
        if (mapEl) {
            // 出現後に一度フィット
            fitToMap();
            // ResizeObserverがあればサイズ変化にも追従
            if (typeof ResizeObserver !== 'undefined') {
                new ResizeObserver(fitToMap).observe(mapEl);
            }
        } else {
            setTimeout(waitForMap, 500);
        }
    })();

    // =============================================
    // コメントアニメーション
    // =============================================

    /**
     * 利用可能なレーンインデックスを返す
     * すべて使用中の場合は最も早く空くレーンを返す
     */
    function getAvailableLane() {
        const now = Date.now();
        let bestLane = 0;
        let bestTime = Infinity;

        for (let i = 0; i < lanes.length; i++) {
            if (lanes[i] <= now) {
                return i;
            }
            if (lanes[i] < bestTime) {
                bestTime = lanes[i];
                bestLane = i;
            }
        }
        return bestLane;
    }

    /**
     * UIデバッグ用ログ出力
     */
    function addDebugLog(text, color = '#cccccc') {
        const logBox = document.getElementById('nico-debug-log');
        if (!logBox) return;
        const logLine = document.createElement('div');
        logLine.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
        logLine.style.color = color;
        logBox.appendChild(logLine);
        if (logBox.children.length > 50) logBox.firstChild.remove();
        logBox.scrollTop = logBox.scrollHeight;
    }

    /**
     * コメントを画面に流す
     * @param {string} text    - コメントテキスト
     * @param {string} color   - 文字色 (CSS color)
     * @param {number} size    - フォントサイズ (px, デフォルト=CONFIG.fontSize)
     */
    function showComment(text, color = FACTION_COLORS.SYSTEM, size = CONFIG.fontSize) {
        if (!commentContainer) return;

        const screenWidth = window.innerWidth;
        const screenHeight = window.innerHeight;

        // レーン決定
        const laneIndex = getAvailableLane();
        const laneHeight = screenHeight / CONFIG.maxLanes;
        const topPos = laneIndex * laneHeight + (laneHeight - size) / 2;

        // DOM要素生成
        const el = document.createElement('span');
        el.textContent = text;

        let customStyle = {
            position: 'absolute',
            top: `${topPos}px`,
            left: `${screenWidth}px`,   // 画面右端からスタート
            fontSize: `${size}px`,
            fontWeight: 'bold',
            color: color,
            opacity: String(CONFIG.opacity),
            whiteSpace: 'nowrap',
            textShadow: '1px 1px 3px #000, -1px -1px 3px #000',
            willChange: 'transform',
            transition: 'none',
        };

        // 赤色(Machina)の場合は不気味なグリッチエフェクトを追加
        let machinaAnimation = '';
        if (color === FACTION_COLORS.MACHINA || color === 'red' || color === '#ff3333') {
            customStyle.fontFamily = '"Courier New", Courier, monospace';
            customStyle.textShadow = '2px 0 red, -2px 0 cyan';
            machinaAnimation = 'machinaGlitch 0.3s infinite alternate';
            customStyle.letterSpacing = '2px';
            customStyle.opacity = '0.9';

            // グリッチ用アニメーションキーフレームがなければ追加
            if (!document.getElementById('nico-machina-glitch')) {
                const style = document.createElement('style');
                style.id = 'nico-machina-glitch';
                style.textContent = `
                    @keyframes machinaGlitch {
                        0% { transform: translate(0, 0) skew(0deg); }
                        20% { transform: translate(-2px, 1px) skew(1deg); }
                        40% { transform: translate(1px, -1px) skew(-1deg); }
                        60% { transform: translate(-1px, 2px) skew(0deg); opacity: 0.8; }
                        80% { transform: translate(2px, -2px) skew(2deg); opacity: 1; }
                        100% { transform: translate(0, 0) skew(0deg); }
                    }
                `;
                document.head.appendChild(style);
            }
        }

        Object.assign(el.style, customStyle);
        commentContainer.appendChild(el);

        // テキスト幅を取得してアニメーション時間を計算
        const textWidth = el.scrollWidth;
        const totalDist = screenWidth + textWidth;
        const duration = Math.max(
            CONFIG.minDuration,
            (totalDist / CONFIG.scrollSpeed) * 1000
        );

        // CSSアニメーションで流す (Machinaエフェクトがある場合はカンマ区切りで複数アニメーション適用)
        const keyframesName = `nicoScroll_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const styleEl = document.createElement('style');
        styleEl.textContent = `
            @keyframes ${keyframesName} {
                from { transform: translateX(0); }
                to   { transform: translateX(-${totalDist}px); }
            }
        `;
        document.head.appendChild(styleEl);

        const scrollAnim = `${keyframesName} ${duration}ms linear forwards`;

        // Machinaエフェクトがある場合はカンマ区切りで両方のアニメーションを適用
        el.style.animation = machinaAnimation
            ? `${machinaAnimation}, ${scrollAnim}`
            : scrollAnim;

        // レーンの次回利用可能時刻を更新
        // テキストの先頭が画面左端を超えたあたりを基準にする
        const laneBlockDuration = ((screenWidth + size * text.length * 0.6) / CONFIG.scrollSpeed) * 1000;
        lanes[laneIndex] = Date.now() + laneBlockDuration;

        // アニメーション終了後にDOMを削除
        el.addEventListener('animationend', () => {
            el.remove();
            styleEl.remove();
        });

        // 流れたコメント自体もデバッグログに残す
        addDebugLog(`流れた: ${text}`, color);

        log(`コメント表示: [${text}] lane=${laneIndex} dur=${Math.round(duration)}ms`);
    }

    // =============================================
    // AI API連携 (OpenAI / Claude 自動選択)
    // =============================================

    let eventQueue = [];
    let lastAiCall = 0;
    let aiTimeout = null;
    let hasChatLog = false; // バッファ内にユーザーチャットが含まれていればtrue

    /**
     * 発見されたイベント文字列をAI用のキューに追加する
     * @param {string} rawText
     * @param {boolean} isChat ユーザーの手打ちチャット行ならtrue
     */
    function queueAiEvent(rawText, isChat = false) {
        addDebugLog(`イベント検知: ${rawText.slice(0, 30)}...`, '#888888');
        if (isChat) hasChatLog = true;

        // プラグインが無効なら何もしない
        if (!document.getElementById('nico-enabled')?.checked) return;

        // OpenAI または Claude のどちらかにキーがあれば続行
        const openaiKey = GM_getValue('NICO_OPENAI_API_KEY', '').trim();
        const claudeKey = GM_getValue('NICO_CLAUDE_API_KEY', '').trim();
        if (!openaiKey && !claudeKey) {
            addDebugLog('API Keyが未設定です（OpenAI/Claude）', '#ff4444');
            return;
        }

        // イベントを追加
        eventQueue.push(rawText);
        if (eventQueue.length > AI_CONFIG.maxEvents) {
            eventQueue.shift(); // 古いものから捨てる
        }

        scheduleAiCall();
    }

    /**
     * AI呼び出しのスケジューリング（短期間での連続呼び出しを防ぐ）
     */
    function scheduleAiCall() {
        if (aiTimeout) clearTimeout(aiTimeout);

        const now = Date.now();
        const timeSinceLastCall = now - lastAiCall;
        const timeToWait = Math.max(0, AI_CONFIG.cooldown - timeSinceLastCall);

        aiTimeout = setTimeout(() => {
            triggerAiComment();
        }, timeToWait);
    }

    /**
     * AIのレスポンスをパースしてコメントを画面に流す（共通処理）
     * @param {string} content - APIが返したテキスト
     * @param {string} apiName - デバッグ表示用のAPI名
     */
    function handleAiComments(content, apiName) {
        // ```json ... ``` のようなマークダウンコードブロックを除去する
        const cleaned = content
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/\s*```$/, '')
            .trim();

        let comments = [];
        try {
            const parsed = JSON.parse(cleaned);
            const raw = parsed.comments || parsed;
            if (Array.isArray(raw)) {
                comments = raw.map(c => {
                    if (typeof c === 'string') return { text: c, color: 'white' };
                    return { text: c.text || '', color: c.color || 'white' };
                }).filter(c => c.text);
            } else {
                throw new Error('不正なJSONフォーマット');
            }
        } catch (e) {
            // パース失敗時は生データを流さずデバッグログのみ
            log(`[${apiName}] JSONパース失敗:`, e, cleaned.slice(0, 100));
            addDebugLog(`[${apiName}] JSONパース失敗（生データは非表示）`, '#ff4444');
            return;
        }

        addDebugLog(`[${apiName}] AI回答(${comments.length}件): ${comments.map(c => `[${c.color}]${c.text}`).join(', ')}`, '#aaffaa');

        comments.forEach((comment, index) => {
            const delay = Math.random() * 3000 + (index * 800);
            setTimeout(() => {
                let color;
                switch (comment.color) {
                    case 'blue': color = '#44aaff'; break; // レジスタンス青
                    case 'green': color = '#44ff88'; break; // エンライテンド緑
                    case 'red': color = FACTION_COLORS.MACHINA; break; // Machina赤
                    default: color = '#ffffff'; break; // 基本白
                }
                let size = CONFIG.fontSize;
                if (comment.color === 'white') {
                    if (Math.random() < 0.1) size = CONFIG.fontSize * 1.5; // 10%で文字を大きくするのみ
                }
                showComment(comment.text, color, size);
            }, delay);
        });
    }

    /**
     * OpenAI APIを呼び出してコメントを生成する
     */
    function callOpenAI(prompt, commentCount, onRetry) {
        const apiKey = GM_getValue('NICO_OPENAI_API_KEY', '').trim();
        addDebugLog('[OpenAI] リクエスト送信中...', '#ffffaa');
        GM_xmlhttpRequest({
            method: 'POST',
            url: 'https://api.openai.com/v1/chat/completions',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            data: JSON.stringify({
                model: 'gpt-4o-mini',
                response_format: { type: 'json_object' },
                messages: [
                    { role: 'system', content: 'You must output valid JSON only. Format: { "comments": [{"text": "...", "color": "white|blue|green"}] }' },
                    { role: 'user', content: prompt }
                ],
                max_tokens: Math.max(400, commentCount * 60 + 200),
                temperature: 0.9
            }),
            onload: (response) => {
                if (response.status === 429) {
                    addDebugLog('[OpenAI] レートリミット。別APIを試みます...', '#ffaa44');
                    if (onRetry) onRetry();
                    return;
                }
                if (response.status !== 200) {
                    addDebugLog(`[OpenAI] APIエラー: ${response.status}`, '#ff4444');
                    return;
                }
                try {
                    const res = JSON.parse(response.responseText);
                    if (res.choices && res.choices.length > 0) {
                        handleAiComments(res.choices[0].message.content.trim(), 'OpenAI');
                    }
                } catch (e) {
                    log('OpenAI Response Parse Error:', e);
                }
            },
            onerror: () => addDebugLog('[OpenAI] 通信エラー', '#ff4444')
        });
    }

    /**
     * Claude APIを呼び出してコメントを生成する
     */
    function callClaude(prompt, commentCount, onRetry) {
        const apiKey = GM_getValue('NICO_CLAUDE_API_KEY', '').trim();
        addDebugLog('[Claude] リクエスト送信中...', '#ffddaa');
        GM_xmlhttpRequest({
            method: 'POST',
            url: 'https://api.anthropic.com/v1/messages',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
            },
            data: JSON.stringify({
                model: 'claude-haiku-4-5',
                max_tokens: Math.max(400, commentCount * 60 + 200),
                temperature: 0.9,
                system: 'You must output valid JSON only. Format: { "comments": [{"text": "...", "color": "white|blue|green"}] }',
                messages: [
                    { role: 'user', content: prompt }
                ]
            }),
            onload: (response) => {
                if (response.status === 429) {
                    addDebugLog('[Claude] レートリミット。別APIを試みます...', '#ffaa44');
                    if (onRetry) onRetry();
                    return;
                }
                if (response.status !== 200) {
                    addDebugLog(`[Claude] APIエラー: ${response.status}`, '#ff4444');
                    return;
                }
                try {
                    const res = JSON.parse(response.responseText);
                    if (res.content && res.content.length > 0) {
                        handleAiComments(res.content[0].text.trim(), 'Claude');
                    }
                } catch (e) {
                    log('Claude Response Parse Error:', e);
                }
            },
            onerror: () => addDebugLog('[Claude] 通信エラー', '#ff4444')
        });
    }

    /**
     * Gemini APIを呼び出してコメントを生成する
     */
    function callGemini(prompt, commentCount, onRetry) {
        const apiKey = GM_getValue('NICO_GEMINI_API_KEY', '').trim();
        addDebugLog('[Gemini] リクエスト送信中...', '#aaddff');
        const systemInstruction = 'You must output valid JSON only. Format: { "comments": [{"text": "...", "color": "white|blue|green"}] }';
        GM_xmlhttpRequest({
            method: 'POST',
            url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({
                system_instruction: { parts: [{ text: systemInstruction }] },
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.9,
                    maxOutputTokens: Math.max(400, commentCount * 60 + 200),
                    responseMimeType: 'application/json'
                }
            }),
            onload: (response) => {
                if (response.status === 429) {
                    addDebugLog('[Gemini] レートリミット。別APIを試みます...', '#ffaa44');
                    if (onRetry) onRetry();
                    return;
                }
                if (response.status !== 200) {
                    addDebugLog(`[Gemini] APIエラー: ${response.status}`, '#ff4444');
                    return;
                }
                try {
                    const res = JSON.parse(response.responseText);
                    const text = res?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
                    if (text) handleAiComments(text, 'Gemini');
                } catch (e) {
                    log('Gemini Response Parse Error:', e);
                }
            },
            onerror: () => addDebugLog('[Gemini] 通信エラー', '#ff4444')
        });
    }

    function triggerAiComment(isForce = false) {
        if (eventQueue.length === 0 && !isForce) return;

        const openaiKey = GM_getValue('NICO_OPENAI_API_KEY', '').trim();
        const claudeKey = GM_getValue('NICO_CLAUDE_API_KEY', '').trim();
        const geminiKey = GM_getValue('NICO_GEMINI_API_KEY', '').trim();
        if (!openaiKey && !claudeKey && !geminiKey) return;

        const eventsToProcess = [...eventQueue];
        eventQueue = [];
        lastAiCall = Date.now();

        const chatNote = hasChatLog
            ? '**重要**: ログ内の[チャット]行はユーザーの実際の発言です。必ずその内容にツッコんでください。'
            : 'ログ内容に必ず関連したコメントにしてください。関係のないコメントは不可。';

        const logLines = commLogBuffer.length > 0
            ? commLogBuffer.join('\n')
            : eventsToProcess.join('\n');

        const commentCount = Math.max(1, Math.min(100, parseInt(GM_getValue('NICO_COMMENT_COUNT', 7), 10)));

        const prompt = `あなたはIngress COMM ALLのログを見て、ニコニコ動画のコメント欄に流れるコメントを生成します。
${chatNote}

**重要ルール**:
- ログに登場するポータル名・地名・プレイヤー名を積極的にコメントに盛り込む（固有名詞を拾って反応する）
- 下記の例示の言葉をそのままコメントに使用しないこと。あくまで傾向の参考として読むこと。

以下の4種類のキャラクターがランダムに混在するコメントを ${commentCount}個 生成してください:

━━━━━━━━━━━━━━━━━━━━━
1. 【一般視聴者】（全体の85%以上・white）
   ログに対する自然な反応・感想を短く。
   ポータル名や地名が出たら「〇〇また落とされた」「あそこか」など名前を使って反応する。
   また5%程度で根拠のない陰謀論や深読みコメントを混ぜる。

2. 【Ingressガチ勢】（全体の5%以下・white）
   感情を挟まず冷静にゲーム状況を短く分析する。固有ポータル名・地名を使った分析が望ましい。

3. 【レジスタンス陣営バイアス】（全体の3%以下・blue）
   ★RESが青リンクを引いた / ENLの緑ポータルや緑リンクが破壊されたログがある場合のみ出す
   自陣営(RES/青)を称え相手陣営(ENL/緑)を皮肉る。直接攻撃的な言葉は使わない。

4. 【エンライテンド陣営バイアス】（全体の3%以下・green）
   ★ENLが緑リンクを引いた / RESの青ポータルや青リンクが破壊されたログがある場合のみ出す
   自陣営(ENL/緑)を称え相手陣営(RES/青)を皮肉る。直接攻撃的な言葉は使わない。

5. 【MACHINA】（全体の1%以下・red）
   不気味な内容の短い「英語のみ」のコメントを生成する。
   文字化けを演出するため、Zalgo text等の特殊文字は絶対に避け、代わりに大文字と小文字を不規則に混ぜたり、普通の記号(. , - _ * # など)を単語の間に挟んで読みにくくする。
━━━━━━━━━━━━━━━━━━━━━

出力はJSON形式のみ。各コメントは { "text": "...", "color": "white"|"blue"|"green"|"red" } の形式で。
{"comments": [...]}

COMM ALLログ (古→新):
${logLines}`;

        hasChatLog = false;

        // 利用可能なAPIをリストアップしてシャッフル・順番に試す（429時は次へ自動フォールバック）
        const callers = [];
        if (openaiKey) callers.push((retry) => callOpenAI(prompt, commentCount, retry));
        if (claudeKey) callers.push((retry) => callClaude(prompt, commentCount, retry));
        if (geminiKey) callers.push((retry) => callGemini(prompt, commentCount, retry));

        if (callers.length === 0) return;

        // Fisher-Yatesアルゴリズムでシャッフル
        for (let i = callers.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [callers[i], callers[j]] = [callers[j], callers[i]];
        }

        // 先頭から順に試す（429なら次のAPIへ）
        let idx = 0;
        function tryNext() {
            if (idx >= callers.length) {
                addDebugLog('すべてのAPIが失敗またはレートリミット。スキップ', '#ff4444');
                return;
            }
            callers[idx++](tryNext);
        }
        tryNext();
    }

    // =============================================
    // Ingress イベント監視
    // =============================================

    // 最後に見たコミュニケーション/ポータルのスナップショット
    let lastPortalData = new Map(); // guid -> {team, health}
    let lastCommsMessages = new Set(); // 既に処理したメッセージGUID
    let commLogBuffer = [];           // COMM ALLのログをまとめて保持するバッファ
    const COMM_LOG_MAX = 50;          // 最大保持件数

    /**
     * IntelマップのグローバルオブジェクトからIngressのAPIを取得する
     * @returns {object|null}
     */
    function getIngressAPI() {
        if (window.IITC && window.portals) return { type: 'IITC' };
        if (window.Ingress && window.Ingress.Map) return { type: 'Ingress' };
        return null;
    }

    /**
     * IITCのポータル情報を監視してコメントを流す
     */
    function watchIITCPortals() {
        if (!window.portals) return;

        for (const [guid, portal] of Object.entries(window.portals)) {
            const data = portal.options && portal.options.data;
            if (!data) continue;

            const team = data.team || 'N';
            const title = data.title || 'Unknown Portal';
            const health = data.health || 0;

            const prev = lastPortalData.get(guid);
            if (prev) {
                // チームが変わった（キャプチャ or 中和）
                if (prev.team !== team) {
                    let msg;
                    if (team === 'N') {
                        msg = `⚔️ 中和！${title}`;
                    } else if (team === 'R') {
                        msg = `🔵 キャプチャ！${title} → Resistance`;
                    } else if (team === 'E') {
                        msg = `🟢 キャプチャ！${title} → Enlightened`;
                    } else {
                        msg = `❓ ${title} チーム変更`;
                    }
                    queueAiEvent(msg);
                }
                // HPが大幅低下（攻撃中の可能性）
                if (prev.health - health >= 20 && team !== 'N') {
                    const msg = `⚠️ 攻撃中！${title} (HP: ${prev.health}→${health}%)`;
                    queueAiEvent(msg);
                }
            }
            lastPortalData.set(guid, { team, health });
        }
    }

    /**
     * IITCのコミュニケーション（COMM ALL）を監視してAIキューに追加する
     * ※ COMM Factionは絶対に含めない
     */
    function watchIITCComms(forceMode = false) {
        const isForceMode = forceMode === true; // フックからのイベントオブジェクト誤認を防止

        let chatData = {};
        if (window.chat) {
            // COMM ALLに該当するもののみ取得
            // _faction と _data.faction は意図的に除外する
            if (window.chat._public && window.chat._public.data) Object.assign(chatData, window.chat._public.data);
            if (window.chat._alerts && window.chat._alerts.data) Object.assign(chatData, window.chat._alerts.data);
            if (window.chat._data && window.chat._data.all) Object.assign(chatData, window.chat._data.all);
            if (window.chat._data && window.chat._data.public) Object.assign(chatData, window.chat._data.public);
            // ※ _faction / _data.faction は意図的に取得しない（Factionチャット除外）
        }

        let entries = Object.entries(chatData);
        if (entries.length === 0) return;

        // タイムスタンプ(entry[1][0])順にソート (古い順)
        entries.sort((a, b) => a[1][0] - b[1][0]);

        if (lastCommsMessages.size === 0 || isForceMode) {
            if (isForceMode) {
                lastCommsMessages.clear();
                commLogBuffer = [];
            }
            entries = entries.slice(-50); // 最初は最新50件まで
        }

        let hasNew = false;
        for (const [guid, entry] of entries) {
            if (lastCommsMessages.has(guid)) continue;
            lastCommsMessages.add(guid);

            const plext = entry[2] && entry[2].plext;
            if (!plext) continue;

            const markup = plext.markup || [];
            const plextType = plext.plextType || '';
            let text = '';
            for (const part of markup) {
                if (part[0] === 'TEXT' || part[0] === 'PLAYER' || part[0] === 'PORTAL') {
                    text += (part[1] && (part[1].plain || part[1].name)) || '';
                }
            }
            if (!text) continue;

            const isChat = plextType === 'PLAYER_GENERATED';
            const label = isChat ? '[チャット]' : '[システム]';
            const logLine = `${label} ${text}`;

            // 攻撃通知・中和通知行はバッファおよびAI送信をスキップ
            if (text.includes('under attack by') || text.includes('neutralized by')) {
                addDebugLog(`攻撃通知をスキップ: ${text.slice(0, 30)}...`, '#555555');
                continue;
            }

            // COMM ALLバッファに蓄積
            commLogBuffer.push(logLine);
            if (commLogBuffer.length > COMM_LOG_MAX) commLogBuffer.shift();

            queueAiEvent(logLine, isChat);
            hasNew = true;
        }

        if (hasNew) {
            addDebugLog(`COMM ALLを読み込みました (バッファ ${commLogBuffer.length}件)`, '#66aaff');
        }

        // キャッシュが大きくなりすぎないよう古いものを削除
        if (lastCommsMessages.size > 500) {
            const arr = [...lastCommsMessages];
            lastCommsMessages = new Set(arr.slice(-300));
        }
    }

    /**
     * ページコンテキストにネットワークリクエストのフックを注入し、
     * /r/getPlexts のレスポンスを横取りする
     */
    function injectNetworkHook() {
        const script = document.createElement('script');
        script.textContent = `
        (function() {
            // Fetch API へのフック
            const _origFetch = window.fetch;
            if (_origFetch) {
                window.fetch = async function(...args) {
                    const response = await _origFetch.apply(this, args);
                    try {
                        const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url ? args[0].url : '');
                        if (url.includes('/r/getPlexts')) {
                            // tab=faction が含まれる場合はFactionチャット（除外対象）
                            const isFaction = url.includes('tab=faction');
                            const clone = response.clone();
                            clone.json().then(data => {
                                if (data && data.result) {
                                    window.dispatchEvent(new CustomEvent('ingressNicoPlexts', { detail: { result: data.result, isFaction } }));
                                }
                            }).catch(e => {});
                        }
                    } catch(e) {}
                    return response;
                };
            }

            // XHRへのフック
            const _origOpen = XMLHttpRequest.prototype.open;
            const _origSend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.open = function(method, url) {
                this._reqUrl = typeof url === 'string' ? url : '';
                return _origOpen.apply(this, arguments);
            };
            XMLHttpRequest.prototype.send = function() {
                this.addEventListener('load', function() {
                    if (this._reqUrl && this._reqUrl.includes('/r/getPlexts')) {
                        try {
                            const isFaction = this._reqUrl.includes('tab=faction');
                            const data = JSON.parse(this.responseText);
                            if (data && data.result) {
                                window.dispatchEvent(new CustomEvent('ingressNicoPlexts', { detail: { result: data.result, isFaction } }));
                            }
                        } catch(e) {}
                    }
                });
                return _origSend.apply(this, arguments);
            };
        })();
        `;
        document.documentElement.appendChild(script);
        script.remove();

        window.addEventListener('ingressNicoPlexts', (e) => {
            processPlextsData(e.detail.result, e.detail.isFaction);
        });

        log('ネットワークリクエストの横取りを開始');
    }

    /**
     * フックした生のPlextsデータを処理してコメントを流す
     * COMM ALLのみを対象とし、Faction専用チャットは除外する
     * @param {Array} results  [[guid, timestamp, plextObj], ...]
     * @param {boolean} isFaction  Faction向けのリクエストかどうか（除外フラグ）
     */
    function processPlextsData(results, isFaction = false) {
        if (!Array.isArray(results)) return;
        if (isFaction) return; // Factionのログは絶対に拾わない

        // 古い順で流すためにソート
        const sorted = [...results].sort((a, b) => a[1] - b[1]);

        let hasNew = false;
        for (const entry of sorted) {
            const guid = entry[0];
            if (lastCommsMessages.has(guid)) continue;
            lastCommsMessages.add(guid);

            const plextObj = entry[2] && entry[2].plext;
            if (!plextObj) continue;

            const markup = plextObj.markup || [];
            const plextType = plextObj.plextType || '';
            let text = '';
            for (const part of markup) {
                if (part[0] === 'TEXT' || part[0] === 'PLAYER' || part[0] === 'PORTAL') {
                    text += (part[1] && (part[1].plain || part[1].name)) || '';
                }
            }
            if (!text) continue;

            const isChat = plextType === 'PLAYER_GENERATED';
            const label = isChat ? '[チャット]' : '[システム]';
            const logLine = `${label} ${text}`;

            // 攻撃通知・中和通知行はバッファおよびAI送信をスキップ
            if (text.includes('under attack by') || text.includes('neutralized by')) {
                addDebugLog(`攻撃通知をスキップ: ${text.slice(0, 30)}...`, '#555555');
                continue;
            }

            commLogBuffer.push(logLine);
            if (commLogBuffer.length > COMM_LOG_MAX) commLogBuffer.shift();

            queueAiEvent(logLine, isChat);
            hasNew = true;
        }

        if (hasNew) {
            addDebugLog(`ネットワークからCOMM ALLを取得 (バッファ ${commLogBuffer.length}件)`, '#66aaff');
        }

        // キャッシュ制限
        if (lastCommsMessages.size > 500) {
            const arr = [...lastCommsMessages];
            lastCommsMessages = new Set(arr.slice(-300));
        }
    }

    /**
     * 純正Intel上のコミュニケーションノードを処理する
     * @param {Element} node
     */
    function processNativeCommsNode(node) {
        const text = node.textContent || '';
        if (!text.trim()) return;

        const msg = text.trim().slice(0, 100);

        queueAiEvent(`[チャット] ${msg}`);
    }

    // =============================================
    // ポータル変化をリアルタイム検知 (IITC Hook)
    // =============================================

    /**
     * IITCのイベントフックを登録する
     */
    function registerIITCHooks() {
        if (!window.addHook) return;

        let initialized = false;
        setTimeout(() => { initialized = true; }, 10000);

        window.addHook('portalAdded', (data) => {
            if (!initialized) return;
            const portal = data.portal;
            const pdata = portal.options && portal.options.data;
            if (!pdata) return;
            const team = pdata.team;
            const title = pdata.title || 'Unknown';
            if (team === 'R') {
                queueAiEvent(`🔵 新規発見！${title}`);
            } else if (team === 'E') {
                queueAiEvent(`🟢 新規発見！${title}`);
            }
        });

        window.addHook('portalDetailLoaded', (data) => {
            const pdata = data.portal && data.portal.options && data.portal.options.data;
            if (!pdata) return;
            const guid = data.guid;
            const team = pdata.team;
            const title = pdata.title || 'Unknown';
            const prev = lastPortalData.get(guid);
            if (prev && prev.team !== team) {
                let msg;
                if (team === 'N') {
                    msg = `💥 中和！${title}`;
                } else if (team === 'R') {
                    msg = `🔵 キャプチャ！${title}`;
                } else {
                    msg = `🟢 キャプチャ！${title}`;
                }
                queueAiEvent(msg);
            }
            if (pdata.team && pdata.health !== undefined) {
                lastPortalData.set(guid, { team: pdata.team, health: pdata.health });
            }
        });

        window.addHook('fieldAdded', (data) => {
            queueAiEvent('🔺 フィールド作成！');
        });

        window.addHook('fieldRemoved', (data) => {
            queueAiEvent('💥 フィールド消滅！');
        });

        window.addHook('linkAdded', (data) => {
            queueAiEvent('🔗 リンク！');
        });

        log('IITCフック登録完了');
    }

    // =============================================
    // コントロールパネル（設定UI）の作成
    // =============================================

    /**
     * 画面右上に設定パネルを表示する
     */
    function createControlPanel() {
        const panel = document.createElement('div');
        panel.id = 'niconico-panel';
        Object.assign(panel.style, {
            position: 'fixed',
            bottom: '30px',
            right: '10px',
            zIndex: '10001',
            background: 'rgba(0,0,0,0.85)',
            border: '1px solid #555',
            borderRadius: '8px',
            padding: '10px 14px',
            color: '#fff',
            fontSize: '13px',
            fontFamily: 'sans-serif',
            cursor: 'default',
            userSelect: 'none',
            minWidth: '220px',
        });

        // 保存済みのOpenAI APIキーを取得
        const savedApiKey = GM_getValue('NICO_OPENAI_API_KEY', '');

        panel.innerHTML = `
            <div id="nico-drag-handle" style="font-weight:bold;margin-bottom:8px;letter-spacing:1px;border-bottom:1px solid #555;padding-bottom:5px;cursor:move;display:flex;align-items:center;justify-content:space-between;" title="ドラッグして移動">
                <span style="display:flex;align-items:center;gap:8px;">
                    🎌 ニコニコインテルマップ
                    <a href="https://github.com/MikanRobot/nico-intelmap" target="_blank" style="font-size:10px;color:#88aaff;text-decoration:none;background:rgba(91,143,255,0.15);border:1px solid rgba(91,143,255,0.4);border-radius:4px;padding:1px 6px;white-space:nowrap;">説明書</a>
                </span>
                <button id="nico-toggle" style="background:none;border:none;color:#fff;font-size:16px;cursor:pointer;padding:0 4px;line-height:1;" title="折りたたむ">▼</button>
            </div>

            <div id="nico-body">
                <!-- タブバー -->
                <div style="display:flex;margin-bottom:10px;border-bottom:1px solid #555;">
                    <button id="nico-tab-btn-main" style="flex:1;background:#333;border:none;border-bottom:2px solid #88aaff;color:#88aaff;padding:5px 4px;font-size:12px;cursor:pointer;">メイン</button>
                    <button id="nico-tab-btn-api"  style="flex:1;background:none;border:none;border-bottom:2px solid transparent;color:#888;padding:5px 4px;font-size:12px;cursor:pointer;">API設定</button>
                </div>

                <!-- メインタブ -->
                <div id="nico-tab-main">
                    <div style="margin-bottom:8px;">
                        <label><input type="checkbox" id="nico-enabled" checked> プラグイン有効</label>
                    </div>
                    <div style="margin-bottom:12px;display:flex;align-items:center;gap:6px;">
                        <label style="white-space:nowrap;font-size:12px;">コメント数:</label>
                        <input type="number" id="nico-comment-count" min="1" max="100" value="${GM_getValue('NICO_COMMENT_COUNT', 7)}" style="width:60px;padding:3px;background:#222;color:#fff;border:1px solid #444;border-radius:3px;text-align:center;">
                        <span style="font-size:11px;color:#aaa;">個 (1〜100)</span>
                    </div>
                    <div style="margin-bottom:8px;padding-top:8px;border-top:1px solid #444;">
                        <label><input type="checkbox" id="nico-debug-enabled"> 🛠️ デバッグ表示</label>
                    </div>
                    <div id="nico-debug-log" style="display:none;background:#111;color:#ccc;font-size:11px;height:70px;overflow-y:auto;padding:4px;margin-bottom:8px;border:1px solid #444;border-radius:3px;word-break:break-all;"></div>
                    <div style="flex: 1;"></div>
                    </div>
                </div>

                <!-- API設定タブ -->
                <div id="nico-tab-api" style="display:none;">
                    <div style="margin-bottom:10px;">
                        <div style="font-size:11px;color:#aaa;margin-bottom:3px;">OpenAI API Key</div>
                        <input type="password" id="nico-openai-key" placeholder="sk-..." value="${savedApiKey}" style="width:100%;padding:4px;box-sizing:border-box;background:#222;color:#fff;border:1px solid #444;border-radius:3px;">
                        <div style="margin-top:4px;display:flex;justify-content:space-between;align-items:center;">
                            <span id="nico-apikey-status" style="font-size:11px;color:#aaa;">${savedApiKey ? '⏳ 未検証' : '❌ 未設定'}</span>
                            <a href="https://platform.openai.com/api-keys" target="_blank" style="color:#88aaff;font-size:10px;text-decoration:none;">🔑 取得方法</a>
                        </div>
                    </div>
                    <div style="margin-bottom:10px;">
                        <div style="font-size:11px;color:#aaa;margin-bottom:3px;">Claude API Key</div>
                        <input type="password" id="nico-claude-key" placeholder="sk-ant-..." value="${GM_getValue('NICO_CLAUDE_API_KEY', '')}" style="width:100%;padding:4px;box-sizing:border-box;background:#222;color:#fff;border:1px solid #444;border-radius:3px;">
                        <div style="margin-top:4px;display:flex;justify-content:space-between;align-items:center;">
                            <span id="nico-claude-status" style="font-size:11px;color:#aaa;">${GM_getValue('NICO_CLAUDE_API_KEY', '') ? '⏳ 未検証' : '❌ 未設定'}</span>
                            <a href="https://console.anthropic.com/settings/keys" target="_blank" style="color:#88aaff;font-size:10px;text-decoration:none;">🔑 取得方法</a>
                        </div>
                    </div>
                    <div style="margin-bottom:6px;">
                        <div style="font-size:11px;color:#aaa;margin-bottom:3px;">Gemini API Key</div>
                        <input type="password" id="nico-gemini-key" placeholder="AIza..." value="${GM_getValue('NICO_GEMINI_API_KEY', '')}" style="width:100%;padding:4px;box-sizing:border-box;background:#222;color:#fff;border:1px solid #444;border-radius:3px;">
                        <div style="margin-top:4px;display:flex;justify-content:space-between;align-items:center;">
                            <span id="nico-gemini-status" style="font-size:11px;color:#aaa;">${GM_getValue('NICO_GEMINI_API_KEY', '') ? '⏳ 未検証' : '❌ 未設定'}</span>
                            <a href="https://aistudio.google.com/app/apikey" target="_blank" style="color:#88aaff;font-size:10px;text-decoration:none;">🔑 取得方法</a>
                        </div>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(panel);

        // --- イベントリスナー ---

        // パネルのドラッグ移動
        const dragHandle = document.getElementById('nico-drag-handle');
        let isDragging = false;
        let dragOffsetX = 0;
        let dragOffsetY = 0;

        dragHandle.addEventListener('mousedown', (e) => {
            isDragging = true;
            const rect = panel.getBoundingClientRect();
            dragOffsetX = e.clientX - rect.left;
            dragOffsetY = e.clientY - rect.top;
            // 右寄せ指定などを解除して絶対座標指定へ切り替え
            panel.style.bottom = 'auto';
            panel.style.right = 'auto';
        });
        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            panel.style.left = `${e.clientX - dragOffsetX}px`;
            panel.style.top = `${e.clientY - dragOffsetY}px`;
        });
        document.addEventListener('mouseup', () => {
            isDragging = false;
        });

        // タブ切り替え
        function switchTab(tab) {
            const isMain = tab === 'main';
            document.getElementById('nico-tab-main').style.display = isMain ? '' : 'none';
            document.getElementById('nico-tab-api').style.display = isMain ? 'none' : '';
            document.getElementById('nico-tab-btn-main').style.borderBottomColor = isMain ? '#88aaff' : 'transparent';
            document.getElementById('nico-tab-btn-api').style.borderBottomColor = isMain ? 'transparent' : '#88aaff';
            document.getElementById('nico-tab-btn-main').style.color = isMain ? '#88aaff' : '#888';
            document.getElementById('nico-tab-btn-api').style.color = isMain ? '#888' : '#88aaff';
        }
        document.getElementById('nico-tab-btn-main').addEventListener('click', () => switchTab('main'));
        document.getElementById('nico-tab-btn-api').addEventListener('click', () => switchTab('api'));

        // コメント数入力
        const commentCountInput = document.getElementById('nico-comment-count');
        commentCountInput.addEventListener('change', () => {
            const val = Math.max(1, Math.min(100, parseInt(commentCountInput.value, 10) || 7));
            commentCountInput.value = val;
            GM_setValue('NICO_COMMENT_COUNT', val);
        });

        // デバッグ表示トグル
        const debugCb = document.getElementById('nico-debug-enabled');
        const debugLog = document.getElementById('nico-debug-log');
        debugCb.addEventListener('change', () => {
            debugLog.style.display = debugCb.checked ? 'block' : 'none';
        });

        const enabledCb = document.getElementById('nico-enabled');
        enabledCb.addEventListener('change', () => {
            const active = enabledCb.checked;
            // コメントオーバーレイの表示切り替え
            if (commentContainer) {
                commentContainer.style.display = active ? '' : 'none';
            }
            // OFF時はイベントキューとタイマーもリセット
            if (!active) {
                eventQueue = [];
                if (aiTimeout) { clearTimeout(aiTimeout); aiTimeout = null; }
            }
        });

        // OpenAI API Key 自動保存・バリデーション
        const apiKeyInput = document.getElementById('nico-openai-key');
        const apiKeyStatus = document.getElementById('nico-apikey-status');

        function validateApiKey(key) {
            if (!key) {
                apiKeyStatus.textContent = '❌ API Key Err';
                apiKeyStatus.style.color = '#ff4444';
                return;
            }
            apiKeyStatus.textContent = '⏳ テスト中...';
            apiKeyStatus.style.color = '#aaa';
            GM_xmlhttpRequest({
                method: 'GET',
                url: 'https://api.openai.com/v1/models',
                headers: { 'Authorization': `Bearer ${key}` },
                onload: (res) => {
                    if (res.status === 200) {
                        apiKeyStatus.textContent = '✅ API Key OK';
                        apiKeyStatus.style.color = '#44ff88';
                    } else {
                        apiKeyStatus.textContent = '❌ API Key Err';
                        apiKeyStatus.style.color = '#ff4444';
                    }
                },
                onerror: () => {
                    apiKeyStatus.textContent = '❌ API Key Err';
                    apiKeyStatus.style.color = '#ff4444';
                }
            });
        }

        apiKeyInput.addEventListener('change', () => {
            const key = apiKeyInput.value.trim();
            GM_setValue('NICO_OPENAI_API_KEY', key);
            validateApiKey(key);
        });

        // 起動時に保存済みキーを自動検証
        if (savedApiKey) validateApiKey(savedApiKey);

        // Claude API Key 自動保存・バリデーション
        const claudeKeyInput = document.getElementById('nico-claude-key');
        const claudeStatus = document.getElementById('nico-claude-status');

        function validateClaudeKey(key) {
            if (!key) {
                claudeStatus.textContent = '❌ API Key Err';
                claudeStatus.style.color = '#ff4444';
                return;
            }
            claudeStatus.textContent = '⏳ テスト中...';
            claudeStatus.style.color = '#aaa';
            GM_xmlhttpRequest({
                method: 'GET',
                url: 'https://api.anthropic.com/v1/models',
                headers: {
                    'x-api-key': key,
                    'anthropic-version': '2023-06-01'
                },
                onload: (res) => {
                    if (res.status === 200) {
                        claudeStatus.textContent = '✅ API Key OK';
                        claudeStatus.style.color = '#44ff88';
                    } else {
                        claudeStatus.textContent = '❌ API Key Err';
                        claudeStatus.style.color = '#ff4444';
                    }
                },
                onerror: () => {
                    claudeStatus.textContent = '❌ API Key Err';
                    claudeStatus.style.color = '#ff4444';
                }
            });
        }

        claudeKeyInput.addEventListener('change', () => {
            const key = claudeKeyInput.value.trim();
            GM_setValue('NICO_CLAUDE_API_KEY', key);
            validateClaudeKey(key);
        });

        // 起動時に保存済みキーを自動検証
        const savedClaudeKey = GM_getValue('NICO_CLAUDE_API_KEY', '');
        if (savedClaudeKey) validateClaudeKey(savedClaudeKey);

        // Gemini API Key 自動保存・バリデーション
        const geminiKeyInput = document.getElementById('nico-gemini-key');
        const geminiStatus = document.getElementById('nico-gemini-status');

        function validateGeminiKey(key) {
            if (!key) {
                geminiStatus.textContent = '❌ 未設定';
                geminiStatus.style.color = '#ff4444';
                return;
            }
            geminiStatus.textContent = '⏳ テスト中...';
            geminiStatus.style.color = '#aaa';
            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`,
                onload: (res) => {
                    if (res.status === 200) {
                        geminiStatus.textContent = '✅ API Key OK';
                        geminiStatus.style.color = '#44ff88';
                    } else {
                        geminiStatus.textContent = '❌ API Key Err';
                        geminiStatus.style.color = '#ff4444';
                    }
                },
                onerror: () => {
                    geminiStatus.textContent = '❌ API Key Err';
                    geminiStatus.style.color = '#ff4444';
                }
            });
        }

        geminiKeyInput.addEventListener('change', () => {
            const key = geminiKeyInput.value.trim();
            GM_setValue('NICO_GEMINI_API_KEY', key);
            validateGeminiKey(key);
        });

        // 起動時に保存済みキーを自動検証
        const savedGeminiKey = GM_getValue('NICO_GEMINI_API_KEY', '');
        if (savedGeminiKey) validateGeminiKey(savedGeminiKey);

        // ▼トグル（タイトル行の折りたたみボタン）
        const nicoBody = document.getElementById('nico-body');
        const toggleBtn = document.getElementById('nico-toggle');
        let panelCollapsed = false;
        toggleBtn.addEventListener('mousedown', (e) => e.stopPropagation()); // ドラッグと競合させない
        toggleBtn.addEventListener('click', () => {
            panelCollapsed = !panelCollapsed;
            nicoBody.style.display = panelCollapsed ? 'none' : '';
            toggleBtn.textContent = panelCollapsed ? '▲' : '▼';
            panel.style.minWidth = panelCollapsed ? 'auto' : '220px';
        });

        log('コントロールパネルを作成しました');
    }

    // =============================================
    // Google Font読み込み
    // =============================================

    function loadFont() {
        if (document.getElementById('niconico-font')) return;
        const link = document.createElement('link');
        link.id = 'niconico-font';
        link.rel = 'stylesheet';
        link.href = 'https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@700&display=swap';
        document.head.appendChild(link);
    }

    // =============================================
    // ユーティリティ
    // =============================================

    function log(...args) {
        if (CONFIG.debug) {
            console.log('[NicoIngress]', ...args);
        }
    }

    // =============================================
    // メイン初期化
    // =============================================

    function main() {
        log('初期化開始');

        loadFont();
        initOverlay();
        createControlPanel();

        // いち早く通信を捕捉するためネットワークフックを注入
        injectNetworkHook();

        // IITC環境かどうかを判定して監視方法を切り替え
        const checkReady = setInterval(() => {
            if (window.addHook && window.portals !== undefined) {
                clearInterval(checkReady);
                log('IITC環境を検出');

                registerIITCHooks();

                // マップの描画・更新が完了したタイミングおよびチャット受信時に読み取る
                window.addHook('mapDataRefreshEnd', watchIITCComms);
                window.addHook('publicChatDataAvailable', watchIITCComms);
                window.addHook('factionChatDataAvailable', watchIITCComms);

            } else if (document.readyState === 'complete') {
                clearInterval(checkReady);
                log('純正Intel環境を検出');
                // ネットワークフックは既に注入済みのため、ここでは何もしない
            }
        }, 2000);

        log('ニコニコIngressコメントシステム起動完了！');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', main);
    } else {
        main();
    }

})();
