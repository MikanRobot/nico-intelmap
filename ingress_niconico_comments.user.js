// ==UserScript==
// @name         ニコニコインテルマップ
// @namespace    https://github.com/MikanRobot/nico-intelmap
// @version      1.8.0
// @description  Ingress Intel Map上にニコニコ動画風のスクロールコメントを表示する（AIツッコミ機能付き）
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
    // コメント表示の初期設定（スクロール・フォント等）
    // =============================================
    const CONFIG = {
        // コメントの移動速度 (px/秒)
        scrollSpeed: 198,
        // コメントの基本フォントサイズ (px)
        fontSize: 24,
        // コメントを流すレーンの最大数
        maxLanes: 8,
        // コメントの透明度 (0.0〜1.0)
        opacity: 0.85,
        // デバッグログ出力フラグ
        debug: false,
    };

    // =============================================
    // AIコメント生成用の初期設定
    // =============================================
    const AI_CONFIG = {
        // APIリクエストの最小クールダウン時間 (ms)
        cooldown: 15000,
        // 1回のリクエストに含める最大イベント数
        maxEvents: 5,
    };

    // =============================================
    // コントロールパネルUIのテーマカラー（Ingress Intel Map準拠）
    // =============================================
    const UI_THEME = {
        bg: 'rgba(7, 31, 38, 0.92)',      // パネル背景（ダークティール）
        bgInput: 'rgba(0, 18, 24, 0.85)', // 入力欄背景
        bgSub: 'rgba(0, 40, 50, 0.4)',    // サブ領域背景
        border: '#20767c',                // 枠線（ティール）
        accent: '#26c6da',                // 主アクセント（シアン）
        accentDim: '#6fb3b8',             // 補助テキスト（くすみシアン）
        active: '#ffb24a',                // アクティブ強調（オレンジ）
        text: '#cfeef0',                  // 通常テキスト
        ok: '#44ff88',                    // 成功
        err: '#ff6b6b',                   // エラー
    };

    // =============================================
    // 各派閥（陣営）のテーマカラー定義
    // =============================================
    const FACTION_COLORS = {
        RESISTANCE: '#00c8ff',   // Resistance（青）
        ENLIGHTENED: '#01ff01',  // Enlightened（緑）
        NEUTRAL: '#ffcc00',      // Neutral（黄：中立）
        MACHINA: '#ff3333',      // Machina（赤：NPC陣営）
        SYSTEM: '#ffffff',       // システムメッセージ
        ALERT: '#ff4444',        // 警告メッセージ
    };

    // =============================================
    // オーバーレイ表示用グローバル変数
    // =============================================
    let commentContainer = null;
    let lanes = [];           // 各レーンの次回コメント配置可能時刻
    let activeCommentCount = 0; // 画面上のアクティブなコメント要素の数（TTS同期用）

    /**
     * コメント表示用オーバーレイコンテナを初期化する
     */
    function initOverlay() {
        // 既存のオーバーレイ要素があれば削除
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
            pointerEvents: 'none',   // 下層のマップのクリック・ドラッグ操作を阻害しない
            overflow: 'hidden',
            zIndex: '10000',
            fontFamily: '"Noto Sans JP", "M PLUS 1p", sans-serif',
        });
        document.body.appendChild(commentContainer);

        // レーン配列を初期化
        lanes = new Array(CONFIG.maxLanes).fill(0);

        // 表示領域をインテルマップのサイズに合わせる
        fitToMap();
        log('オーバーレイを初期化しました');
    }

    /**
     * オーバーレイ表示領域をマップキャンバスの座標に合わせる
     */
    function fitToMap() {
        if (!commentContainer) return;

        // IITCまたは純正Intel MapのDOM要素を取得
        const mapEl = document.getElementById('map_canvas')
            || document.getElementById('map')
            || document.querySelector('.leaflet-container');

        if (mapEl) {
            const r = mapEl.getBoundingClientRect();
            Object.assign(commentContainer.style, {
                top: `${r.top}px`,
                left: `${r.left}px`,
                width: `${r.width}px`,
                height: `${r.height}px`,
            });
        } else {
            // マップ要素が見つからない場合のデフォルトサイズ設定
            Object.assign(commentContainer.style, {
                top: '60px',
                left: '0',
                width: '100vw',
                height: 'calc(100vh - 60px)',
            });
        }
    }

    // ウィンドウリサイズ時の追従処理
    window.addEventListener('resize', fitToMap);

    // マップ要素がロードされるのを待機してアタッチする
    (function waitForMap() {
        const mapEl = document.getElementById('map_canvas')
            || document.querySelector('.leaflet-container');
        if (mapEl) {
            fitToMap();
            if (typeof ResizeObserver !== 'undefined') {
                new ResizeObserver(fitToMap).observe(mapEl);
            }
        } else {
            setTimeout(waitForMap, 500);
        }
    })();

    // =============================================
    // コメント描画・スクロール処理
    // =============================================

    /**
     * 空いているコメントレーンを検索して返す
     * すべて埋まっている場合は、最も早く空く予定のレーンを返す
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
     * デバッグ用ログパネルに一行出力
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
     * コメントを画面上に流す処理
     * @param {string} text    - コメント文字列
     * @param {string} color   - 文字色
     * @param {number} size    - フォントサイズ
     */
    function showComment(text, color = FACTION_COLORS.SYSTEM, size = CONFIG.fontSize) {
        if (!commentContainer) return;

        const screenWidth = commentContainer.offsetWidth || window.innerWidth;
        const screenHeight = commentContainer.offsetHeight || window.innerHeight;

        // 割り当てるレーンと座標の決定
        const laneIndex = getAvailableLane();
        const laneHeight = screenHeight / CONFIG.maxLanes;
        const topPos = laneIndex * laneHeight + (laneHeight - size) / 2;

        // コメントのDOM要素を作成
        const el = document.createElement('span');
        el.textContent = text;

        let customStyle = {
            position: 'absolute',
            top: `${topPos}px`,
            left: `${screenWidth}px`,   // 画面右端から表示開始
            fontSize: `${size}px`,
            fontWeight: 'bold',
            color: color,
            opacity: String(CONFIG.opacity),
            whiteSpace: 'nowrap',
            textShadow: '1px 1px 3px #000, -1px -1px 3px #000',
            willChange: 'transform',
            transition: 'none',
        };

        // MACHINA（赤）の場合は特殊なグリッチエフェクトを適用
        let machinaAnimation = '';
        if (color === FACTION_COLORS.MACHINA || color === 'red' || color === '#ff3333') {
            customStyle.fontFamily = '"Courier New", Courier, monospace';
            customStyle.textShadow = '2px 0 red, -2px 0 cyan';
            machinaAnimation = 'machinaGlitch 0.3s infinite alternate';
            customStyle.letterSpacing = '2px';
            customStyle.opacity = '0.9';

            // グリッチアニメーションのスタイルをheadに注入
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

        // コメント文字列の幅から移動距離を計算
        const textWidth = el.scrollWidth;
        const totalDist = screenWidth + textWidth;

        // CONFIG.scrollSpeed (px/秒) からアニメーション時間を算出
        const duration = Math.round((totalDist / CONFIG.scrollSpeed) * 1000);

        // スクロール用のアニメーション定義（@keyframes）を動的に生成
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

        // MACHINAのグリッチとスクロールアニメーションを同時に適用
        el.style.animation = machinaAnimation
            ? `${machinaAnimation}, ${scrollAnim}`
            : scrollAnim;

        // 次のコメントが同じレーンに流れるまでの衝突防止バッファを計算
        const laneBlockDuration = (textWidth / totalDist) * duration + 200;
        lanes[laneIndex] = Date.now() + laneBlockDuration;

        // HUD上のアクティブコメント数をインクリメント
        activeCommentCount++;

        // 共鳴粒子の空間消滅（クリーンアップ）用ヘルパー
        let isRemoved = false;
        const removeEl = () => {
            if (isRemoved) return;
            isRemoved = true;
            el.remove();
            styleEl.remove();
            
            // アクティブカウントのデクリメントとTTS同期切断
            activeCommentCount--;
            if (activeCommentCount <= 0) {
                activeCommentCount = 0;
                if (GM_getValue('NICO_SPEECH_ENABLED', false)) {
                    stopSpeechQueueGracefully();
                }
            }
        };

        // 投影終了（アニメーションエンド）時のノードクリア
        el.addEventListener('animationend', removeEl);

        // DOMリークセーフティネット（アニメーション終了予定時刻 + 2秒で強制消滅）
        setTimeout(removeEl, duration + 2000);

        addDebugLog(`コメント表示: ${text}`, color);
        log(`コメント表示: [${text}] lane=${laneIndex} dur=${Math.round(duration)}ms`);
    }

    // =============================================
    // API（OpenAI / Claude / Gemini）連携処理
    // =============================================

    let eventQueue = [];
    let lastAiCall = 0;
    let aiTimeout = null;
    let hasChatLog = false; // 直前のCOMMログ内にエージェントのチャット発言が含まれるか

    /**
     * 検知したイベントデータをAIコメント用のキューに蓄積
     */
    function queueAiEvent(rawText, isChat = false) {
        addDebugLog(`イベント検知: ${rawText.slice(0, 30)}...`, '#888888');

        // プラグインが無効化されている場合は処理しない
        if (!document.getElementById('nico-enabled')?.checked) return;

        // 自動更新の上限超過後はAPI課金を避けるためAIキューに積まない
        if (isAiCallBudgetExhausted()) return;

        if (isChat) hasChatLog = true;

        // APIキーが設定されているか確認
        const openaiKey = GM_getValue('NICO_OPENAI_API_KEY', '').trim();
        const claudeKey = GM_getValue('NICO_CLAUDE_API_KEY', '').trim();
        const geminiKey = GM_getValue('NICO_GEMINI_API_KEY', '').trim();
        if (!openaiKey && !claudeKey && !geminiKey) {
            addDebugLog('APIキーが設定されていません', '#ff4444');
            return;
        }

        eventQueue.push(rawText);
        if (eventQueue.length > AI_CONFIG.maxEvents) {
            eventQueue.shift(); // キューサイズ上限を超えた古いイベントを削除
        }

        scheduleAiCall();
    }

    /**
     * APIリクエストの連続実行を抑止（クールダウン）
     */
    function scheduleAiCall() {
        if (aiTimeout) clearTimeout(aiTimeout);

        const now = Date.now();
        const timeSinceLastCall = now - lastAiCall;
        const timeToWait = Math.max(0, AI_CONFIG.cooldown - timeSinceLastCall);

        addDebugLog(`[待機] AIリクエストをスケジュール（${Math.round(timeToWait / 1000)}秒後）...`, '#666666');

        aiTimeout = setTimeout(() => {
            triggerAiComment();
        }, timeToWait);
    }

    // =============================================
    // 音声読み上げ（TTS）制御処理
    // =============================================
    
    let isAudioUnlocked = false;
    const unlockAudio = () => {
        if (isAudioUnlocked) return;
        isAudioUnlocked = true;
        // ユーザー操作を契機に音声合成のミュート解除を行う（Safari等の対策）
        const uttr = new SpeechSynthesisUtterance('');
        uttr.volume = 0;
        speechSynthesis.speak(uttr);
        addDebugLog('🔊 音声合成の初期化に成功しました', '#aaffaa');
    };
    ['click', 'mousedown', 'pointerdown', 'keydown', 'touchstart'].forEach(e => {
        document.addEventListener(e, unlockAudio, { once: true });
    });

    let speechQueue = [];
    let isSpeaking = false;

    /**
     * キューから発話データを取得して再生
     */
    function processSpeechQueue() {
        if (speechQueue.length === 0) {
            isSpeaking = false;
            return;
        }
        isSpeaking = true;
        
        const uttr = speechQueue.shift();
        
        const next = () => {
            if (!isSpeaking) return;
            setTimeout(() => {
                if (isSpeaking) processSpeechQueue();
            }, 1000); // 次の発話までのインターバルタイム
        };

        uttr.onend = next;
        uttr.onerror = next;
        
        speechSynthesis.speak(uttr);
    }

    function enqueueSpeech(uttr) {
        speechQueue.push(uttr);
        if (!isSpeaking) {
            processSpeechQueue();
        }
    }

    function cancelAllSpeech() {
        speechQueue = [];
        isSpeaking = false;
        speechSynthesis.cancel();
    }

    function stopSpeechQueueGracefully() {
        speechQueue = [];
    }

    let lastUsedApiName = null; // 直近でコメントを生成したAPI名（ステータスバー表示用）

    /**
     * 直近で応答したAPIの「▶ 使用中」バッジをUI上に表示する
     */
    function markLastUsedApi(apiName) {
        lastUsedApiName = apiName;
        const badgeMap = {
            'OpenAI': 'nico-openai-badge',
            'Claude': 'nico-claude-badge',
            'Gemini': 'nico-gemini-badge',
        };
        for (const [name, id] of Object.entries(badgeMap)) {
            const el = document.getElementById(id);
            if (el) el.style.display = (name === apiName) ? '' : 'none';
        }
        updateStatusBar();
    }

    /**
     * APIから返却されたAIコメントを整形・表示・読み上げする処理
     * @param {string} content - APIのJSONレスポンス
     * @param {string} apiName - 使用したAPIモデルの名称
     */
    function handleAiComments(content, apiName) {
        markLastUsedApi(apiName);
        const cleaned = content
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/\s*```$/, '')
            .trim();

        let comments = [];
        try {
            // ```json ``` ラッパーを除去したあと、最初の { から最後の } までを抽出して解析
            const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error('JSONブロックが見つかりません');
            const parsed = JSON.parse(jsonMatch[0]);
            const raw = parsed.comments || parsed;
            if (Array.isArray(raw)) {
                comments = raw.map(c => {
                    if (typeof c === 'string') return { text: c, color: 'white' };
                    return { text: c.text || '', color: c.color || 'white' };
                }).filter(c => c.text);
            } else {
                throw new Error('commentsが配列ではありません');
            }
        } catch (e) {
            log(`[${apiName}] JSON解析エラー:`, e, cleaned.slice(0, 200));
            // max_tokens超過などによる途中切断のサルベージ: 完全な {...} ブロックだけ抽出して再試行
            try {
                const salvaged = [];
                // text/color どちらの順序でも対応
                const objRe = /\{[^{}]*?"text"\s*:\s*"((?:[^"\\]|\\.)*)"[^{}]*?"color"\s*:\s*"(\w+)"[^{}]*?\}|\{[^{}]*?"color"\s*:\s*"(\w+)"[^{}]*?"text"\s*:\s*"((?:[^"\\]|\\.)*)"[^{}]*?\}/g;
                let m;
                while ((m = objRe.exec(cleaned)) !== null) {
                    // text→color順 か color→text順かでキャプチャグループが変わる
                    const text  = m[1] ?? m[4];
                    const color = m[2] ?? m[3];
                    if (text) salvaged.push({ text, color: color || 'white' });
                }
                if (salvaged.length > 0) {
                    addDebugLog(`[${apiName}] JSON切断を検出 — ${salvaged.length}件をサルベージしました`, '#ffaa44');
                    comments = salvaged;
                } else {
                    throw new Error('サルベージ対象なし');
                }
            } catch {
                addDebugLog(`[${apiName}] JSON解析に失敗しました: ${e.message}`, '#ff4444');
                return;
            }
        }

        addDebugLog(`[${apiName}] AIコメント受信(${comments.length}件): ${comments.map(c => `[${c.color}]${c.text}`).join(', ')}`, '#aaffaa');

        const isSpeechEnabled = GM_getValue('NICO_SPEECH_ENABLED', false);

        comments.forEach((comment, index) => {
            // MACHINA（赤）用の文字フィルタリング処理
            if (comment.color === 'red') {
                if (/[ぁ-んァ-ヶｱ-ﾝﾞﾟ一-龠]/.test(comment.text)) {
                    comment.color = 'white'; // 赤コメントに日本語が混じっていた場合は白（一般コメント）へ変換
                } else {
                    comment.text = comment.text.replace(/[^\x20-\x7E]/g, ''); // 半角ASCII以外の文字を削除
                }
            }

            // 描画開始時間をランダムに遅延させて重なりを軽減
            const delay = Math.random() * 3000 + (index * 800);

            setTimeout(() => {
                let color;
                switch (comment.color) {
                    case 'blue':  color = FACTION_COLORS.RESISTANCE;  break;
                    case 'green': color = FACTION_COLORS.ENLIGHTENED; break;
                    case 'red':   color = FACTION_COLORS.MACHINA;     break;
                    default:      color = '#ffffff';                   break;
                }
                let size = CONFIG.fontSize;
                if (comment.color === 'white' && Math.random() < 0.1) size = CONFIG.fontSize * 1.5; // 10%の確率で文字サイズを1.5倍にする
                
                showComment(comment.text, color, size);

                if (isSpeechEnabled) {
                    if (!isAudioUnlocked) {
                        if (index === 0) addDebugLog('⚠️ 音声を有効化するには画面をクリックしてください', '#ffcc88');
                        return;
                    }

                    const uttr = new SpeechSynthesisUtterance(comment.text);
                    const voices = speechSynthesis.getVoices();

                    if (comment.color === 'red') {
                        // MACHINA専用の英語音声設定
                        uttr.lang = 'en-US';
                        uttr.rate = 0.95;
                        uttr.pitch = 0.8;
                        const engVoice = voices.find(v => v.lang.startsWith('en') && (v.name.includes('Samantha') || v.name.includes('Victoria') || v.name.includes('Karen') || v.name.includes('Google US') || v.name.includes('Female')));
                        if (engVoice) uttr.voice = engVoice;
                    } else {
                        // 一般エージェント用の日本語音声設定（読み上げモードにより速度・ピッチを切替）
                        const speechMode = GM_getValue('NICO_SPEECH_MODE', 'yukkuri');
                        uttr.lang = 'ja-JP';
                        if (speechMode === 'normal') {
                            uttr.rate = 1.0;
                            uttr.pitch = 1.0;
                        } else {
                            uttr.rate = 1.15;
                            uttr.pitch = 1.3;
                        }
                        const jpVoice = voices.find(v => v.lang.startsWith('ja') && (v.name.includes('Kyoko') || v.name.includes('Google 日本語') || v.name.includes('Megumi')));
                        if (jpVoice) uttr.voice = jpVoice;
                    }

                    enqueueSpeech(uttr);
                }
            }, delay);
        });
    }

    // APIコストの概算用単価（USD / 1Mトークン）。実際の料金とは変動しうるため、あくまで大まかな目安。
    const PRICING_USD_PER_1M = {
        OpenAI: { input: 0.15, output: 0.60 },  // gpt-4o-mini
        Claude: { input: 1.00, output: 5.00 },  // claude-haiku-4-5
        Gemini: { input: 0.30, output: 2.50 },  // gemini-2.5-flash
    };

    // 累計コスト管理（セッション累計はメモリ上、日次累計はGM_setValueに永続化）
    let sessionCostUsd = 0;

    /**
     * ローカルタイムゾーン基準の日付キー（YYYY-MM-DD）を返す
     */
    function getLocalDateKey() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    /**
     * 概算コストをセッション累計・日次累計に加算し、パネル表示を更新する
     */
    function addCostUsd(costUsd) {
        sessionCostUsd += costUsd;
        const today = getLocalDateKey();
        if (GM_getValue('NICO_COST_DATE', '') !== today) {
            // 日付が変わっていたら日次累計をリセット
            GM_setValue('NICO_COST_DATE', today);
            GM_setValue('NICO_COST_DAILY', 0);
        }
        GM_setValue('NICO_COST_DAILY', GM_getValue('NICO_COST_DAILY', 0) + costUsd);
        updateCostDisplay();
    }

    /**
     * 本日のAPI概算コスト（USD）を返す（日付が変わっていれば0）
     */
    function getDailyCostUsd() {
        return GM_getValue('NICO_COST_DATE', '') === getLocalDateKey() ? GM_getValue('NICO_COST_DAILY', 0) : 0;
    }

    /**
     * パネル上の累計コスト表示（本日／セッション）とステータスバーを最新状態に更新する
     */
    function updateCostDisplay() {
        const dailyEl = document.getElementById('nico-cost-daily');
        const sessionEl = document.getElementById('nico-cost-session');
        if (dailyEl) dailyEl.textContent = `$${getDailyCostUsd().toFixed(5)}`;
        if (sessionEl) sessionEl.textContent = `$${sessionCostUsd.toFixed(5)}`;
        updateStatusBar();
    }

    /**
     * APIのトークン消費量と概算コストをデバッグログに出力し、累計に加算する
     */
    function logTokenUsage(apiName, inputTokens, outputTokens) {
        if (inputTokens === undefined || outputTokens === undefined) return;
        const rate = PRICING_USD_PER_1M[apiName];
        const totalTokens = inputTokens + outputTokens;
        const costUsd = (inputTokens / 1e6) * rate.input + (outputTokens / 1e6) * rate.output;
        addDebugLog(`[${apiName}] トークン消費: 入力${inputTokens} / 出力${outputTokens} (計${totalTokens}) — 推定コスト: 約$${costUsd.toFixed(5)} (目安)`, '#88ccff');
        addCostUsd(costUsd);
    }

    /**
     * APIのエラーレスポンス本文から人間可読なエラーメッセージを抽出する共通処理
     */
    function extractApiErrorMessage(responseText) {
        try {
            const body = JSON.parse(responseText);
            return body?.error?.message || responseText.slice(0, 200);
        } catch {
            return (responseText || '').slice(0, 200);
        }
    }

    /**
     * OpenAI APIを呼び出してAIコメントを生成
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
                    { role: 'system', content: 'You must output valid JSON only. Format: { "comments": [{"text": "...", "color": "white|blue|green|red"}] }' },
                    { role: 'user', content: prompt }
                ],
                max_tokens: Math.max(1024, commentCount * 150 + 512),
                temperature: 0.9
            }),
            onload: (response) => {
                if (response.status !== 200) {
                    addDebugLog(`[OpenAI] エラー(${response.status}): ${extractApiErrorMessage(response.responseText)}`, '#ffaa44');
                    if (onRetry) onRetry();
                    return;
                }
                try {
                    const res = JSON.parse(response.responseText);
                    if (res.usage) logTokenUsage('OpenAI', res.usage.prompt_tokens, res.usage.completion_tokens);
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
     * Claude APIを呼び出してAIコメントを生成
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
                max_tokens: Math.max(1024, commentCount * 150 + 512),
                temperature: 0.9,
                system: 'You must output valid JSON only. Format: { "comments": [{"text": "...", "color": "white|blue|green|red"}] }',
                messages: [
                    { role: 'user', content: prompt }
                ]
            }),
            onload: (response) => {
                if (response.status !== 200) {
                    addDebugLog(`[Claude] エラー(${response.status}): ${extractApiErrorMessage(response.responseText)}`, '#ffaa44');
                    if (onRetry) onRetry();
                    return;
                }
                try {
                    const res = JSON.parse(response.responseText);
                    if (res.usage) logTokenUsage('Claude', res.usage.input_tokens, res.usage.output_tokens);
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
     * Gemini APIを呼び出してAIコメントを生成
     */
    function callGemini(prompt, commentCount, onRetry) {
        const apiKey = GM_getValue('NICO_GEMINI_API_KEY', '').trim();
        addDebugLog('[Gemini] リクエスト送信中...', '#aaddff');
        const systemInstruction = 'You must output valid JSON only. Format: { "comments": [{"text": "...", "color": "white|blue|green|red"}] }';
        GM_xmlhttpRequest({
            method: 'POST',
            url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({
                system_instruction: { parts: [{ text: systemInstruction }] },
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.9,
                    maxOutputTokens: Math.max(1024, commentCount * 150 + 512),
                    responseMimeType: 'application/json',
                    thinkingConfig: { thinkingBudget: 0 }
                }
            }),
            onload: (response) => {
                if (response.status !== 200) {
                    addDebugLog(`[Gemini] エラー(${response.status}): ${extractApiErrorMessage(response.responseText)}`, '#ffaa44');
                    if (onRetry) onRetry();
                    return;
                }
                try {
                    const res = JSON.parse(response.responseText);
                    if (res.usageMetadata) logTokenUsage('Gemini', res.usageMetadata.promptTokenCount, res.usageMetadata.candidatesTokenCount);
                    const parts = res?.candidates?.[0]?.content?.parts || [];
                    const text = parts.find(p => p.text && !p.thought)?.text?.trim();
                    if (text) handleAiComments(text, 'Gemini');
                } catch (e) {
                    log('Gemini Response Parse Error:', e);
                }
            },
            onerror: () => addDebugLog('[Gemini] 通信エラー', '#ff4444')
        });
    }

    /**
     * 現在の時間帯・曜日に応じた「エージェントの生活感」コンテキストをプロンプト用に生成する
     */
    function getTimePersonaNote() {
        const now = new Date();
        const hour = now.getHours();
        const isWeekend = now.getDay() === 0 || now.getDay() === 6;

        let timeNote;
        if (hour < 4) {
            timeNote = '深夜（0〜4時）。深夜徘徊・寝落ち寸前・「明日仕事なのに」・不審者扱いや職質リスクといった深夜AGあるあるの時間帯';
        } else if (hour < 7) {
            timeNote = '早朝（4〜7時）。朝活AG・始発前のワンデプロイ・散歩ついでのリチャージといった早朝あるあるの時間帯';
        } else if (hour < 9) {
            timeNote = '通勤・通学時間帯（7〜9時）。出勤前のワンデプロイ・電車内からのリチャージ・遅刻リスクといったあるあるの時間帯';
        } else if (hour < 17) {
            timeNote = '日中（9〜17時）。営業車AG・昼休みのファーム巡回・仕事サボり疑惑といったあるあるの時間帯';
        } else if (hour < 20) {
            timeNote = '夕方〜帰宅時間帯（17〜20時）。帰宅ついでの寄り道デプロイ・晩飯前のひと焼きといったあるあるの時間帯';
        } else {
            timeNote = '夜（20〜24時）。夕食後の散歩AG・夜活・寝る前の防衛リチャージといったあるあるの時間帯';
        }
        const weekendNote = isWeekend
            ? 'さらに今日は週末なので、遠征・ロングリンク作戦・アノマリー・ミッションデイなど休日ならではのネタも使ってよい。'
            : '';
        return `【現在の時間帯コンテキスト】現地時間は${timeNote}。${weekendNote}コメントのうち2〜3件程度に、この時間帯ならではの生活感をさりげなく反映させること（全コメントに入れるのは不自然なので禁止）。`;
    }

    /**
     * APIを呼び出してAIコメントを生成・トリガーする
     */
    function triggerAiComment(isForce = false) {
        if (eventQueue.length === 0 && !isForce) return;
        if (!isForce && isAiCallBudgetExhausted()) return;

        addDebugLog(`--- AI呼び出し開始 (手動: ${isForce}) ---`, '#cccccc');

        const openaiKey = GM_getValue('NICO_OPENAI_API_KEY', '').trim();
        const claudeKey = GM_getValue('NICO_CLAUDE_API_KEY', '').trim();
        const geminiKey = GM_getValue('NICO_GEMINI_API_KEY', '').trim();
        if (!openaiKey && !claudeKey && !geminiKey) {
            addDebugLog('エラー: 有効なAPIキーがありません', '#ff4444');
            return;
        }

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

        const prompt = `あなたは位置情報ゲーム「Ingress（イングレス）」のCOMM ALLログ（ポータル占領、リンク確立、コントロールフィールド形成、チャットなど）を観察しているユーザーです。そのログに基づいて、ニコニコ動画のコメント欄に流れるような、Ingressのエージェント（プレイヤー：AG）達による非常にリアルでディープなコメントを生成してください。
${chatNote}
${getTimePersonaNote()}

**重要ルール**:
- Ingressのリアルなプレイヤーが日常的に使う専門用語、俗称、ネットスラング（例：焼く、更地、デプロイ、リチャージ、スキャナ、ノヴァ、多重、多層、沈める、自撮り、アプグレ、白ポ、カプセル、ファーム、バースターなど）をふんだんに取り入れること。
- 移動手段やプレイスタイルにまつわる「エージェントあるある」の日常ユーモア（例：車載AG、チャリチャリ、徒歩インステップ、深夜徘徊、不審者扱い、警察の職務質問（職質）、地方のポータル維持、メダル実績、アノマリー遠征など）を交えること。
- ログに登場するポータル名・地名・プレイヤー名（AG名）を積極的に拾ってリアクションしてください（「〇〇（ポータル名）が焼かれたか！」「〇〇さん（AG名）またあそこ回ってるな」など）。
- 下記の例示の言葉をそのままコメントに使用しないこと。あくまで世界観・語彙 of 参考として読むこと。

以下の5種類のキャラクターがランダムに混在するコメントを ${commentCount}個 生成してください:

━━━━━━━━━━━━━━━━━━━━━
1. 【一般エージェント（一般視聴者）】（全体の70%以上・white）
   - ログに対する自然な反応や感想を短く、ネットスラングやエージェントの生々しい声を交えて表現。
   - 「〇〇（ポータル名）が更地になってる」「青（RES）/緑（ENL）リンク綺麗に通ったな」「あそ公（あそこのポータル）また焼かれたんか」「防衛（リチャージ）間に合わんかったか」「あそこは車から届かんし徒歩だな」「深夜のチャリチャリお疲れ様です」「また職質されかけてて草」「〇〇さんのスキャナどうなってんのｗ」など。
   - 5%程度の確率で、特定のエージェントが裏で何かを企んでいるのではないかという、プレイヤー同士の行動に対する根拠のない深読み、邪推、陰謀論コメント（例：「〇〇さんが深夜に急にデプロイしたのはアノマリーの仕込みの陽動作戦か？」「最近〇〇エリアのポータルが更地になったのは裏で陣営間の取引があったのでは」「〇〇さん、二重スパイを企んでいるんじゃないか…？」など）を混ぜる。

2. 【Ingressガチ勢・戦術家】（全体の20%以下・white）
   - 感情を挟まず、極めて冷静に戦況やエリア状況、使用アイテム等を短く分析する。
   - 「多重CF（コントロールフィールド）の起点アンカーになってるな」「ポータルキー（Key）の管理がしっかりしてる」「Aegisシールド頑丈すぎ」「ウルトラストライク（US）でシールドを剥がされたか」「XMP8（レベル8バースター）で更地にされた模様」「ポータルレベル（P8など）の維持に動いてる」「リンクカットで多層が崩壊したな」「MU（マインドユニット）の稼ぎがでかい」「無計画なクソリンクで多重の邪魔になってるな」など。

3. 【レジスタンス（RES/青）陣営バイアス】（全体の10%程度・必ず1件以上・blue）
   - **ログの内容に関わらず、必ず1件以上生成すること。** ログにRES有利な内容（青リンク・青CF形成・ENLポータル破壊など）があればそれに絡めてよいが、なくてもRES目線の贔屓コメントを生成すること。
   - これは1.の一般エージェントのような中立的・客観的な実況コメントでは**絶対にない**。自陣営（RES/青）を無条件に称賛・礼賛し、相手陣営（ENL/緑）を見下す・挑発する強い感情のこもった一言を**必ず含める**こと。
   - 「青いコントロールフィールドが美しい」「人類の自由と知性を守るレジスタンス！」「緑の精神汚染（シェイパー）をADA様と共に拒絶する」「青リンクで世界を覆い尽くせ」「緑のCFが崩壊してXMが澄んでいく」「所詮シェイパーの操り人形には負けん」など。

4. 【エンライテンド（ENL/緑）陣営バイアス】（全体の10%程度・必ず1件以上・green）
   - **ログの内容に関わらず、必ず1件以上生成すること。** ログにENL有利な内容（緑リンク・緑CF形成・RESポータル破壊など）があればそれに絡めてよいが、なくてもENL目線の贔屓コメントを生成すること。
   - これは1.の一般エージェントのような中立的・客観的な実況コメントでは**絶対にない**。自陣営（ENL/緑）を無条件に称賛・礼賛し、相手陣営（RES/青）を見下す・挑発する強い感情のこもった一言を**必ず含める**こと。
   - 「シェイパーの導きによる人類進化！」「やはり緑のCFこそ至高」「ジャービス神に救済されよ」「青い束縛から解放し、啓発（エンライトン）するのだ」「青い壁を壊してXMの光を受け入れよう」「レジスタンスの旧時代の自由なぞ幻想に過ぎん」など。

5. 【MACHINA（マキナ/赤）の侵食】（全体の1%以下・red）
   - 謎の第3勢力「MACHINA（赤い人工知能）」の不気味な自動侵食コメント。
   - 不気味な内容の短い「英語のみ」のコメントを生成する（※日本語は絶対に使用禁止）。
   - Zalgo text、絵文字、特殊なUnicode文字はシステムエラー(豆腐文字)になるため【絶対に使用禁止】。
   - 半角のアルファベット, 数字, 基本記号( . , - _ * # ! ? ) のみを使用し、大文字小文字をランダムに混ぜることでマキナの暗号やプログラムバグのような不気味さを表現すること。
━━━━━━━━━━━━━━━━━━━━━

出力はJSON形式のみ。各コメントは { "text": "...", "color": "white"|"blue"|"green"|"red" } の形式で。
※ 注意: "red" は完全に「5. 【MACHINA】」のキャラクターに合致するコメント（英語のみの不気味なコメント）の場合にのみ使用すること。一般コメント等で強調のために "red" を使うのは絶対禁止。
{"comments": [...]}

COMM ALLログ (古→新):
${logLines}`;

        hasChatLog = false;

        // 有効かつ使用チェック済みのAPIを固定順（OpenAI→Claude→Gemini）で積む
        const openaiOn = document.getElementById('nico-openai-enabled')?.checked ?? true;
        const claudeOn = document.getElementById('nico-claude-enabled')?.checked ?? true;
        const geminiOn = document.getElementById('nico-gemini-enabled')?.checked ?? true;

        const callers = [];
        if (openaiKey && openaiOn) callers.push((retry) => callOpenAI(prompt, commentCount, retry));
        if (claudeKey && claudeOn) callers.push((retry) => callClaude(prompt, commentCount, retry));
        if (geminiKey && geminiOn) callers.push((retry) => callGemini(prompt, commentCount, retry));

        if (callers.length === 0) {
            addDebugLog('エラー: 使用するAPIが選択されていません', '#ff4444');
            return;
        }

        // 先頭のAPIから順にフォールバック制御しながら順次呼び出し
        let idx = 0;
        function tryNext() {
            if (idx >= callers.length) {
                addDebugLog('すべてのAPIが応答しませんでした', '#ff4444');
                return;
            }
            callers[idx++](tryNext);
        }
        tryNext();
    }

    // =============================================
    // マップデータおよびCOMMのリアルタイム監視処理
    // =============================================

    let lastPortalData = new Map(); // guid -> {team, health}
    let lastCommsMessages = new Set(); // 重複表示防止用の既読メッセージGUIDのキャッシュ
    let commLogBuffer = [];           // AIコメントの文脈生成用に蓄積するCOMMログ履歴
    const COMM_LOG_MAX = 50;

    // Intel Mapの自動読み込み（定期ポーリング）でAI呼び出しを許可する上限回数。超えるとAPI課金を避けるためコメント生成を停止する
    const MAX_AUTO_REFRESHES = 5;
    let maxAutoRefreshes = MAX_AUTO_REFRESHES; // 「+5回延長」ボタンで実行中に加算される現在の上限
    let autoRefreshCount = 0;
    let autoRefreshCapNotified = false;

    /**
     * 自動更新の上限超過でAI呼び出し予算が尽きているか判定する
     * （カウント自体は ingestPlextEntries() が新規ログ検出時に加算する）
     */
    function isAiCallBudgetExhausted() {
        if (autoRefreshCount <= maxAutoRefreshes) return false;
        if (!autoRefreshCapNotified) {
            autoRefreshCapNotified = true;
            addDebugLog(`自動更新が上限（${maxAutoRefreshes}回）に達したため、以降のコメント生成（API呼び出し）を停止しました。パネルの「+${MAX_AUTO_REFRESHES}回延長」で再開できます`, '#ffaa44');
            updateAiBudgetDisplay();
        }
        return true;
    }

    /**
     * 現在のAI生成残量に応じた表示色を返す（残量あり=緑／残0=橙／超過=赤）
     */
    function aiBudgetColor() {
        if (autoRefreshCount > maxAutoRefreshes) return UI_THEME.err;
        if (autoRefreshCount >= maxAutoRefreshes) return UI_THEME.active;
        return UI_THEME.ok;
    }

    /**
     * パネルのAI生成予算表示（カウンター・プログレスバー・延長ボタン）を最新状態に更新する
     */
    function updateAiBudgetDisplay() {
        const shown = Math.min(autoRefreshCount, maxAutoRefreshes);
        const color = aiBudgetColor();

        const countEl = document.getElementById('nico-refresh-count');
        if (countEl) {
            countEl.textContent = `${shown} / ${maxAutoRefreshes}`;
            countEl.style.color = color;
        }
        const barEl = document.getElementById('nico-budget-bar-fill');
        if (barEl) {
            barEl.style.width = `${(shown / maxAutoRefreshes) * 100}%`;
            barEl.style.background = color;
        }
        // 上限到達中は延長ボタンを警告表示（パルス）にして注意を促す
        const extendBtn = document.getElementById('nico-refresh-extend');
        if (extendBtn) extendBtn.classList.toggle('nico-btn-warn', autoRefreshCount >= maxAutoRefreshes);

        updateStatusBar();
        updateStatusDot();
    }

    /**
     * ヘッダー下の常時表示ステータスバー（AI残量・本日コスト・直近API）を更新する
     */
    function updateStatusBar() {
        const refreshEl = document.getElementById('nico-status-refresh');
        if (refreshEl) {
            refreshEl.textContent = `${Math.min(autoRefreshCount, maxAutoRefreshes)}/${maxAutoRefreshes}`;
            refreshEl.style.color = aiBudgetColor();
        }
        const costEl = document.getElementById('nico-status-cost');
        if (costEl) costEl.textContent = `$${getDailyCostUsd().toFixed(4)}`;
        const apiEl = document.getElementById('nico-status-api');
        if (apiEl) apiEl.textContent = lastUsedApiName || '─';
    }

    /**
     * ヘッダーの稼働状態ドットの色・ツールチップを更新する
     * 🟢稼働中 / 🟠予算切れ / 🔴設定不備
     */
    function updateStatusDot() {
        const dot = document.getElementById('nico-status-dot');
        if (!dot) return;

        const powerOn = document.getElementById('nico-enabled')?.checked ?? true;
        const hasUsableApi = ['OPENAI', 'CLAUDE', 'GEMINI'].some(k =>
            GM_getValue(`NICO_${k}_API_KEY`, '').trim() &&
            (document.getElementById(`nico-${k.toLowerCase()}-enabled`)?.checked ?? true)
        );

        let color, title;
        if (!powerOn) {
            color = UI_THEME.err;
            title = '停止中：プラグインが無効です';
        } else if (!hasUsableApi) {
            color = UI_THEME.err;
            title = '停止中：有効なAPIキーが設定されていません（API設定タブ）';
        } else if (autoRefreshCount > maxAutoRefreshes) {
            color = UI_THEME.active;
            title = '停止中：AI生成上限に達しています（「＋延長」で再開できます）';
        } else {
            color = UI_THEME.ok;
            title = '稼働中：ログを監視しAIコメントを生成します';
        }
        dot.style.background = color;
        dot.style.boxShadow = `0 0 6px ${color}`;
        dot.title = title;
    }

    /**
     * 同一タイムスタンプでグループ化されたログ行をまとめてキューに流す共通処理
     */
    function flushLogGroup(groupedLogs, isChatGroup) {
        if (groupedLogs.length === 0) return;
        const mergedLine = groupedLogs.length === 1
            ? groupedLogs[0]
            : `(同時刻${groupedLogs.length}連ログ) ` + groupedLogs.join(' / ');
        commLogBuffer.push(mergedLine);
        if (commLogBuffer.length > COMM_LOG_MAX) commLogBuffer.shift();
        queueAiEvent(mergedLine, isChatGroup);
    }

    /**
     * plextのmarkupテキストを組み立てて返す共通処理
     * @returns {{ text: string, isChat: boolean } | null}
     */
    function parsePlextEntry(entry) {
        const plextObj = entry[2] && entry[2].plext;
        if (!plextObj) return null;

        const markup = plextObj.markup || [];
        const plextType = plextObj.plextType || '';
        let text = '';
        for (const part of markup) {
            if (part[0] === 'TEXT' || part[0] === 'PLAYER' || part[0] === 'PORTAL') {
                text += (part[1] && (part[1].plain || part[1].name)) || '';
            }
        }
        if (!text) return null;

        const isChat = plextType === 'PLAYER_GENERATED';
        return { text, isChat };
    }

    // AIコメント生成対象から除外するシステムノイズのキーワード（重複・冗長ログ）
    const NOISE_KEYWORDS = ['under attack by', 'neutralized by', 'destroyed by'];

    /**
     * システムノイズ（重複・冗長ログ）に該当するテキストか判定する共通処理
     */
    function isNoiseLog(text) {
        return NOISE_KEYWORDS.some(keyword => text.includes(keyword));
    }

    /**
     * ソート済みの [guid, plextエントリ] ペア群を解析し、ログのグループ化・蓄積・AIキュー投入まで行う共通処理
     * 新規（未読）ログを含む呼び出しを「自動更新1回」としてカウントする
     * @param {Array<[string, Array]>} pairs - タイムスタンプ昇順の [guid, entry] ペア配列
     * @param {string} sourceLabel - 受信経路をデバッグログに示すラベル
     */
    function ingestPlextEntries(pairs, sourceLabel) {
        if (!pairs.some(([guid]) => !lastCommsMessages.has(guid))) return;

        autoRefreshCount++;
        addDebugLog(`[自動更新] ${autoRefreshCount}/${maxAutoRefreshes}回目`, '#666666');
        updateAiBudgetDisplay();

        let hasNew = false;
        let currentTimestamp = -1;
        let groupedLogs = [];
        let isChatGroup = false;

        for (const [guid, entry] of pairs) {
            if (lastCommsMessages.has(guid)) continue;
            lastCommsMessages.add(guid);

            const timestamp = entry[1];
            const parsed = parsePlextEntry(entry);
            if (!parsed) continue;

            const { text, isChat } = parsed;

            // システムメッセージから不要な重複ログを除外
            if (isNoiseLog(text)) {
                addDebugLog(`システムノイズを無視: ${text.slice(0, 30)}...`, '#555555');
                continue;
            }

            if (currentTimestamp !== -1 && currentTimestamp !== timestamp) {
                flushLogGroup(groupedLogs, isChatGroup);
                groupedLogs = [];
                isChatGroup = false;
            }

            const label = isChat ? '[チャット]' : '[システム]';
            currentTimestamp = timestamp;
            groupedLogs.push(`${label} ${text}`);
            if (isChat) isChatGroup = true;
            hasNew = true;
        }
        flushLogGroup(groupedLogs, isChatGroup);

        if (hasNew) {
            addDebugLog(`${sourceLabel} (バッファ ${commLogBuffer.length}件)`, '#66aaff');
        }

        // 既読GUIDキャッシュの肥大化防止
        if (lastCommsMessages.size > 500) {
            lastCommsMessages = new Set([...lastCommsMessages].slice(-300));
        }
    }

    /**
     * IITCのチャットログ（COMM ALL）を監視してパース・イベント化する処理
     */
    function watchIITCComms(forceMode = false) {
        const isForceMode = forceMode === true;

        let chatData = {};
        if (window.chat) {
            if (window.chat._public && window.chat._public.data) Object.assign(chatData, window.chat._public.data);
            if (window.chat._alerts && window.chat._alerts.data) Object.assign(chatData, window.chat._alerts.data);
            if (window.chat._data && window.chat._data.all) Object.assign(chatData, window.chat._data.all);
            if (window.chat._data && window.chat._data.public) Object.assign(chatData, window.chat._data.public);
        }

        let entries = Object.entries(chatData);
        if (entries.length === 0) return;

        entries.sort((a, b) => a[1][0] - b[1][0]);

        if (lastCommsMessages.size === 0 || isForceMode) {
            if (isForceMode) {
                lastCommsMessages.clear();
                commLogBuffer = [];
            }
            entries = entries.slice(-50);
        }

        ingestPlextEntries(entries, 'COMM ALLパケット受信');
    }

    /**
     * Intel Mapのネットワーク通信(/r/getPlexts)をフックする
     */
    function injectNetworkHook() {
        const script = document.createElement('script');
        script.textContent = `
        (function() {
            const _origFetch = window.fetch;
            if (_origFetch) {
                window.fetch = async function(...args) {
                    const response = await _origFetch.apply(this, args);
                    try {
                        const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url ? args[0].url : '');
                        if (url.includes('/r/getPlexts')) {
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

        log('ネットワークフックを設定しました');
    }

    /**
     * ネットワークフック経由でパケットデータをパースする
     */
    function processPlextsData(results, isFaction = false) {
        if (!Array.isArray(results) || results.length === 0) return;
        if (isFaction) return; // Factionチャット（陣営内部発言）はプライバシー保護のためキャプチャ対象外

        const sorted = [...results].sort((a, b) => a[1] - b[1]);
        ingestPlextEntries(sorted.map(entry => [entry[0], entry]), 'ネットワークからCOMM ALL同期');
    }

    // =============================================
    // IITCフック監視イベント登録処理
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
                queueAiEvent(`🔵 ポータルオンライン (RES)！: ${title}`);
            } else if (team === 'E') {
                queueAiEvent(`🟢 ポータルオンライン (ENL)！: ${title}`);
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
                    msg = `💥 ポータル中和！: ${title}`;
                } else if (team === 'R') {
                    msg = `🔵 ポータルキャプチャ (RES)！: ${title}`;
                } else {
                    msg = `🟢 ポータルキャプチャ (ENL)！: ${title}`;
                }
                queueAiEvent(msg);
            }
            if (pdata.team && pdata.health !== undefined) {
                // キャッシュサイズ肥大化防止のヘルパー適用
                setPortalData(guid, { team: pdata.team, health: pdata.health });
            }
        });

        window.addHook('fieldAdded', (data) => {
            queueAiEvent('🔺 コントロールフィールド (CF) 形成！');
        });

        window.addHook('fieldRemoved', (data) => {
            queueAiEvent('💥 コントロールフィールド (CF) 崩壊！');
        });

        window.addHook('linkAdded', (data) => {
            queueAiEvent('🔗 リンク確立！');
        });

        log('IITCイベントフックを登録しました');
    }

    /**
     * キャッシュサイズが大きくなりすぎないよう制限するヘルパー関数
     */
    function setPortalData(key, value) {
        if (lastPortalData.size >= 1000) {
            // 最も古いエントリーを削除（FIFO）
            const firstKey = lastPortalData.keys().next().value;
            lastPortalData.delete(firstKey);
        }
        lastPortalData.set(key, value);
    }

    // =============================================
    // コントロールパネル（設定UI）描画処理
    // =============================================

    /**
     * 設定用コントロールパネルを画面右上に構築・表示する
     */
    /**
     * コントロールパネル用のスタイルシートを一度だけ<head>に注入する
     */
    function injectPanelStyle() {
        if (document.getElementById('nico-panel-style')) return;
        const style = document.createElement('style');
        style.id = 'nico-panel-style';
        style.textContent = `
            #niconico-panel {
                background: ${UI_THEME.bg};
                border: 1px solid ${UI_THEME.border};
                border-radius: 6px;
                box-shadow: 0 0 12px rgba(38,198,218,0.25), inset 0 0 20px rgba(0,0,0,0.4);
                color: ${UI_THEME.text};
                font-size: 13px;
                font-family: sans-serif;
                cursor: default;
                user-select: none;
                accent-color: ${UI_THEME.accent};
            }
            #niconico-panel * { box-sizing: border-box; }

            /* ヘッダー */
            .nico-header {
                display: flex; align-items: center; gap: 8px;
                font-weight: bold; letter-spacing: 1px; cursor: move;
                color: ${UI_THEME.accent}; text-shadow: 0 0 6px rgba(38,198,218,0.5);
                padding-bottom: 6px; border-bottom: 1px solid ${UI_THEME.border};
            }
            .nico-header-title { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .nico-status-dot { width: 9px; height: 9px; border-radius: 50%; flex: 0 0 auto; background: ${UI_THEME.accentDim}; }
            .nico-collapse-btn { background: none; border: none; color: ${UI_THEME.accent}; font-size: 16px; cursor: pointer; padding: 0 4px; line-height: 1; }

            /* ステータスバー（常時表示） */
            .nico-statusbar { display: flex; align-items: center; gap: 10px; font-size: 10px; color: ${UI_THEME.accentDim}; padding: 5px 2px 3px; cursor: pointer; }
            .nico-statusbar b { font-weight: bold; color: ${UI_THEME.text}; }

            /* タブ */
            .nico-tabbar { display: flex; margin: 8px 0 10px; border-bottom: 1px solid ${UI_THEME.border}; }
            .nico-tab { flex: 1; background: none; border: none; border-bottom: 2px solid transparent; color: ${UI_THEME.accentDim}; padding: 5px 4px; font-size: 12px; cursor: pointer; }
            .nico-tab.active { color: ${UI_THEME.active}; border-bottom-color: ${UI_THEME.active}; background: rgba(255,178,74,0.12); }

            /* カード / 行 */
            .nico-card { background: ${UI_THEME.bgSub}; border: 1px solid ${UI_THEME.border}; border-radius: 4px; padding: 8px; margin-bottom: 8px; }
            .nico-card-title { display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: ${UI_THEME.accent}; margin-bottom: 6px; }
            .nico-row { display: flex; align-items: center; justify-content: space-between; gap: 6px; min-height: 24px; }
            .nico-label { font-size: 12px; color: ${UI_THEME.text}; white-space: nowrap; }
            .nico-hint { font-size: 10px; color: ${UI_THEME.accentDim}; }
            .nico-hint b { color: ${UI_THEME.text}; font-weight: bold; }
            .nico-footer { display: flex; justify-content: flex-end; margin-top: 2px; }
            .nico-link { color: ${UI_THEME.accent}; font-size: 10px; text-decoration: none; }
            .nico-link:hover { text-decoration: underline; }

            /* 入力 */
            .nico-input { background: ${UI_THEME.bgInput}; color: ${UI_THEME.text}; border: 1px solid ${UI_THEME.border}; border-radius: 3px; padding: 4px; }
            .nico-input:focus { outline: 1px solid ${UI_THEME.accent}; }
            .nico-num { width: 56px; text-align: center; }
            .nico-key { width: 100%; }

            /* ボタン */
            .nico-btn { background: rgba(38,198,218,0.12); border: 1px solid ${UI_THEME.border}; color: ${UI_THEME.accent}; font-size: 10px; padding: 2px 8px; border-radius: 3px; cursor: pointer; white-space: nowrap; }
            .nico-btn:hover { background: rgba(38,198,218,0.25); }
            .nico-btn-warn { border-color: ${UI_THEME.active}; color: ${UI_THEME.active}; animation: nico-pulse 1.5s infinite; }
            @keyframes nico-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }

            /* トグルスイッチ */
            .nico-switch { position: relative; display: inline-block; width: 30px; height: 16px; flex: 0 0 auto; }
            .nico-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
            .nico-slider { position: absolute; inset: 0; background: #2a4a50; border-radius: 8px; transition: 0.15s; cursor: pointer; }
            .nico-slider::before { content: ''; position: absolute; width: 12px; height: 12px; left: 2px; top: 2px; background: #cfeef0; border-radius: 50%; transition: 0.15s; }
            .nico-switch input:checked + .nico-slider { background: ${UI_THEME.accent}; }
            .nico-switch input:checked + .nico-slider::before { transform: translateX(14px); background: #fff; }
            .nico-switch input:focus-visible + .nico-slider { outline: 1px solid ${UI_THEME.accent}; outline-offset: 1px; }

            /* セグメントコントロール */
            .nico-segment { display: inline-flex; border: 1px solid ${UI_THEME.border}; border-radius: 3px; overflow: hidden; }
            .nico-segment label { cursor: pointer; display: inline-flex; }
            .nico-segment input { position: absolute; opacity: 0; width: 0; height: 0; }
            .nico-segment span { display: inline-block; font-size: 11px; padding: 3px 12px; color: ${UI_THEME.accentDim}; }
            .nico-segment label:first-child span { border-right: 1px solid ${UI_THEME.border}; }
            .nico-segment input:checked + span { color: ${UI_THEME.active}; background: rgba(255,178,74,0.15); font-weight: bold; }
            .nico-segment input:focus-visible + span { outline: 1px solid ${UI_THEME.accent}; outline-offset: -1px; }

            /* プログレスバー */
            .nico-bar { height: 6px; background: ${UI_THEME.bgInput}; border-radius: 3px; overflow: hidden; margin-top: 4px; }
            .nico-bar-fill { height: 100%; width: 0%; background: ${UI_THEME.ok}; border-radius: 3px; transition: width 0.2s, background 0.2s; }

            /* APIカード */
            .nico-api-card { border: 1px solid ${UI_THEME.border}; border-radius: 4px; padding: 6px; margin-bottom: 8px; }
            .nico-api-card:last-child { margin-bottom: 0; }
            .nico-api-head { display: flex; align-items: center; gap: 6px; font-size: 11px; color: ${UI_THEME.accentDim}; margin-bottom: 5px; }
            .nico-api-name { flex: 1; }
            .nico-api-icon { font-size: 12px; }
            .nico-api-badge { font-size: 9px; color: ${UI_THEME.active}; background: rgba(255,178,74,0.15); border: 1px solid rgba(255,178,74,0.5); border-radius: 3px; padding: 1px 5px; }
            .nico-api-foot { display: flex; justify-content: flex-end; margin-top: 4px; }
            /* APIカードのキー無効化（有効トグルは操作可能なまま、キー欄のみ減光） */
            .nico-api-card.nico-api-off .nico-api-name,
            .nico-api-card.nico-api-off .nico-key,
            .nico-api-card.nico-api-off .nico-api-foot { opacity: 0.4; }
            .nico-api-card.nico-api-off .nico-key { pointer-events: none; }

            /* 汎用の無効化（減光＋操作不可） */
            .nico-disabled { opacity: 0.4; pointer-events: none; }

            /* デバッグログ */
            .nico-log { background: ${UI_THEME.bgInput}; color: ${UI_THEME.text}; font-size: 11px; height: 160px; overflow-y: auto; padding: 4px; border: 1px solid ${UI_THEME.border}; border-radius: 3px; word-break: break-all; }
        `;
        document.head.appendChild(style);
    }

    function createControlPanel() {
        injectPanelStyle();

        const panel = document.createElement('div');
        panel.id = 'niconico-panel';
        Object.assign(panel.style, {
            position: 'fixed',
            bottom: '30px',
            right: '10px',
            zIndex: '10001',
            padding: '10px 14px',
            minWidth: 'auto',
        });

        const speechMode = GM_getValue('NICO_SPEECH_MODE', 'yukkuri');

        // APIカード定義（statusId は互換のためOpenAIのみ旧ID nico-apikey-status を維持）
        const API_CARDS = [
            { idx: '①', name: 'OpenAI', enId: 'nico-openai-enabled', enKey: 'NICO_OPENAI_ENABLED', keyId: 'nico-openai-key', keyStore: 'NICO_OPENAI_API_KEY', statusId: 'nico-apikey-status', badgeId: 'nico-openai-badge', ph: 'sk-...',     link: 'https://platform.openai.com/api-keys' },
            { idx: '②', name: 'Claude', enId: 'nico-claude-enabled', enKey: 'NICO_CLAUDE_ENABLED', keyId: 'nico-claude-key', keyStore: 'NICO_CLAUDE_API_KEY', statusId: 'nico-claude-status', badgeId: 'nico-claude-badge', ph: 'sk-ant-...', link: 'https://console.anthropic.com/settings/keys' },
            { idx: '③', name: 'Gemini', enId: 'nico-gemini-enabled', enKey: 'NICO_GEMINI_ENABLED', keyId: 'nico-gemini-key', keyStore: 'NICO_GEMINI_API_KEY', statusId: 'nico-gemini-status', badgeId: 'nico-gemini-badge', ph: 'AIza...',   link: 'https://aistudio.google.com/app/apikey' },
        ];

        const apiCardsHtml = API_CARDS.map(c => {
            const key = GM_getValue(c.keyStore, '');
            const enabled = GM_getValue(c.enKey, true);
            return `
                <div class="nico-api-card" id="${c.enId}-card">
                    <div class="nico-api-head">
                        <label class="nico-switch" title="このAPIを使用する"><input type="checkbox" id="${c.enId}" ${enabled ? 'checked' : ''}><span class="nico-slider"></span></label>
                        <span class="nico-api-name">${c.idx} ${c.name}</span>
                        <span id="${c.statusId}" class="nico-api-icon" title="${key ? '未検証' : '未設定'}">${key ? '⏳' : '❌'}</span>
                        <span id="${c.badgeId}" class="nico-api-badge" style="display:none;">▶ 使用中</span>
                    </div>
                    <input type="password" id="${c.keyId}" class="nico-input nico-key" placeholder="${c.ph}" value="${key}">
                    <div class="nico-api-foot"><a class="nico-link" href="${c.link}" target="_blank">🔑 取得方法</a></div>
                </div>`;
        }).join('');

        panel.innerHTML = `
            <div class="nico-header" id="nico-drag-handle" title="ドラッグで移動 / ダブルクリックで開閉">
                <span class="nico-status-dot" id="nico-status-dot"></span>
                <span class="nico-header-title">🎌 ニコニコインテルマップ</span>
                <label class="nico-switch" id="nico-power-switch" title="プラグインの有効／無効"><input type="checkbox" id="nico-enabled" checked><span class="nico-slider"></span></label>
                <button class="nico-collapse-btn" id="nico-toggle" title="開く">▲</button>
            </div>

            <div class="nico-statusbar" id="nico-status-bar" title="クリックでパネルを開く">
                <span title="AI生成の残り回数">🔄 <b id="nico-status-refresh">0/${MAX_AUTO_REFRESHES}</b></span>
                <span title="本日のAPI概算コスト">💰 <b id="nico-status-cost">$0.0000</b></span>
                <span title="直近でコメントを生成したAPI">▶ <b id="nico-status-api">─</b></span>
            </div>

            <div id="nico-body" style="display:none;">
                <div class="nico-tabbar">
                    <button class="nico-tab active" id="nico-tab-btn-basic">基本</button>
                    <button class="nico-tab" id="nico-tab-btn-api">AI / API</button>
                    <button class="nico-tab" id="nico-tab-btn-log">ログ</button>
                </div>

                <!-- 基本タブ -->
                <div id="nico-tab-basic">
                    <div class="nico-card">
                        <div class="nico-card-title">💬 コメント表示</div>
                        <div class="nico-row">
                            <span class="nico-label">1回の生成数</span>
                            <span><input type="number" id="nico-comment-count" class="nico-input nico-num" min="1" max="100" value="${GM_getValue('NICO_COMMENT_COUNT', 7)}"> <span class="nico-hint">個 (1〜100)</span></span>
                        </div>
                    </div>
                    <div class="nico-card">
                        <div class="nico-card-title">
                            <span>🔊 音声読み上げ</span>
                            <label class="nico-switch" title="音声読み上げの有効／無効"><input type="checkbox" id="nico-speech-enabled" ${GM_getValue('NICO_SPEECH_ENABLED', false) ? 'checked' : ''}><span class="nico-slider"></span></label>
                        </div>
                        <div class="nico-row">
                            <span class="nico-label">読み上げ方式</span>
                            <span class="nico-segment" id="nico-speech-segment">
                                <label><input type="radio" name="nico-speech-mode" value="yukkuri" ${speechMode === 'yukkuri' ? 'checked' : ''}><span>ゆっくり</span></label>
                                <label><input type="radio" name="nico-speech-mode" value="normal" ${speechMode === 'normal' ? 'checked' : ''}><span>普通</span></label>
                            </span>
                        </div>
                    </div>
                    <div class="nico-footer"><a class="nico-link" href="https://github.com/MikanRobot/nico-intelmap" target="_blank">詳細・使い方 ↗</a></div>
                </div>

                <!-- AI / API タブ -->
                <div id="nico-tab-api" style="display:none;">
                    <div class="nico-card">
                        <div class="nico-card-title">
                            <span>🎫 AI生成予算</span>
                            <button class="nico-btn" id="nico-refresh-extend" title="AIコメント生成の上限を${MAX_AUTO_REFRESHES}回分追加します（API利用料が発生します）">＋${MAX_AUTO_REFRESHES}回延長</button>
                        </div>
                        <div class="nico-row">
                            <span class="nico-label" title="新規ログを伴う自動読み込みの回数。上限に達するとAPI課金防止のためAIコメント生成を停止します">残り生成回数</span>
                            <span id="nico-refresh-count" style="font-weight:bold;color:${UI_THEME.ok};">0 / ${MAX_AUTO_REFRESHES}</span>
                        </div>
                        <div class="nico-bar"><div class="nico-bar-fill" id="nico-budget-bar-fill"></div></div>
                        <div class="nico-row" style="margin-top:6px;">
                            <span class="nico-hint" title="トークン消費量から算出した概算値です。実際の請求額とは異なる場合があります">💰 推定コスト</span>
                            <span class="nico-hint">本日 <b id="nico-cost-daily">$0.00000</b> / 今回 <b id="nico-cost-session">$0.00000</b></span>
                        </div>
                    </div>
                    <div class="nico-card">
                        <div class="nico-card-title"><span>🔑 APIキー</span><span class="nico-hint">上から順に使用・失敗で次へ</span></div>
                        ${apiCardsHtml}
                    </div>
                </div>

                <!-- ログタブ -->
                <div id="nico-tab-log" style="display:none;">
                    <div class="nico-card">
                        <div class="nico-card-title"><span>🛠️ デバッグログ</span><button class="nico-btn" id="nico-debug-copy" title="ログをクリップボードにコピーしてAIに貼り付けてデバッグできます">📋 コピー</button></div>
                        <div class="nico-log" id="nico-debug-log"></div>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(panel);

        // --- コントロールイベント処理 ---

        // パネルのドラッグ移動制御
        const dragHandle = document.getElementById('nico-drag-handle');
        let isDragging = false;
        let dragOffsetX = 0;
        let dragOffsetY = 0;

        dragHandle.addEventListener('mousedown', (e) => {
            isDragging = true;
            const rect = panel.getBoundingClientRect();
            dragOffsetX = e.clientX - rect.left;
            dragOffsetY = e.clientY - rect.top;
            // 物理位置を現在の座標に固定し、右下固定スタイルを解除する
            panel.style.left = `${rect.left}px`;
            panel.style.top = `${rect.top}px`;
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

        // nico-body参照（折りたたみ・電源減光で共用）
        const nicoBody = document.getElementById('nico-body');

        // パネルタブ切り替えハンドラ（基本 / AI・API / ログ）
        function switchTab(tab) {
            for (const t of ['basic', 'api', 'log']) {
                document.getElementById(`nico-tab-${t}`).style.display = (t === tab) ? '' : 'none';
                document.getElementById(`nico-tab-btn-${t}`).classList.toggle('active', t === tab);
            }
            if (tab === 'log') {
                const logBox = document.getElementById('nico-debug-log');
                if (logBox) logBox.scrollTop = logBox.scrollHeight;
            }
        }
        for (const t of ['basic', 'api', 'log']) {
            document.getElementById(`nico-tab-btn-${t}`).addEventListener('click', () => switchTab(t));
        }

        // コメント数入力同期ハンドラ
        const commentCountInput = document.getElementById('nico-comment-count');
        commentCountInput.addEventListener('change', () => {
            const val = Math.max(1, Math.min(100, parseInt(commentCountInput.value, 10) || 7));
            commentCountInput.value = val;
            GM_setValue('NICO_COMMENT_COUNT', val);
        });

        // 音声読み上げの有効／無効に応じて「読み上げ方式」セグメントを減光する
        function updateSpeechModeState() {
            const on = document.getElementById('nico-speech-enabled')?.checked;
            document.getElementById('nico-speech-segment')?.classList.toggle('nico-disabled', !on);
        }

        // 音声合成有効・無効切り替え
        const speechCb = document.getElementById('nico-speech-enabled');
        speechCb.addEventListener('change', () => {
            GM_setValue('NICO_SPEECH_ENABLED', speechCb.checked);
            if (!speechCb.checked) cancelAllSpeech();
            updateSpeechModeState();
        });

        // 読み上げ方式（ゆっくり／普通）セグメントの切り替え
        document.querySelectorAll('input[name="nico-speech-mode"]').forEach((radio) => {
            radio.addEventListener('change', () => {
                if (radio.checked) GM_setValue('NICO_SPEECH_MODE', radio.value);
            });
        });

        // AI生成回数の上限延長ボタン
        document.getElementById('nico-refresh-extend').addEventListener('click', () => {
            maxAutoRefreshes += MAX_AUTO_REFRESHES;
            autoRefreshCapNotified = false; // 次回上限到達時に再度通知できるようにリセット
            addDebugLog(`AI生成上限を${MAX_AUTO_REFRESHES}回分延長しました（${autoRefreshCount}/${maxAutoRefreshes}）`, '#aaffaa');
            updateAiBudgetDisplay();
        });

        // デバッグログのコピー（ログタブを開いている間だけ表示される）
        const debugLog = document.getElementById('nico-debug-log');
        const debugCopyBtn = document.getElementById('nico-debug-copy');
        debugCopyBtn.addEventListener('click', () => {
            const lines = [...debugLog.children].map(el => el.textContent).join('\n');
            navigator.clipboard.writeText(lines).then(() => {
                debugCopyBtn.textContent = '✅ コピー済み';
                setTimeout(() => { debugCopyBtn.textContent = '📋 コピー'; }, 2000);
            }).catch(() => {
                debugCopyBtn.textContent = '❌ 失敗';
                setTimeout(() => { debugCopyBtn.textContent = '📋 コピー'; }, 2000);
            });
        });

        // プラグイン有効化切り替え（ヘッダーの電源トグル）
        const enabledCb = document.getElementById('nico-enabled');
        enabledCb.addEventListener('change', () => {
            const active = enabledCb.checked;
            if (commentContainer) {
                commentContainer.style.display = active ? '' : 'none';
            }
            if (!active) {
                eventQueue = [];
                if (aiTimeout) { clearTimeout(aiTimeout); aiTimeout = null; }
            }
            nicoBody.style.opacity = active ? '1' : '0.55';
            updateStatusDot();
        });
        // 電源トグル操作でパネルドラッグが誤発火しないようにする
        document.getElementById('nico-power-switch').addEventListener('mousedown', (e) => e.stopPropagation());

        // 各APIカードの有効／無効に応じてキー入力欄を減光する（有効トグル自体は操作可能なまま）
        function updateApiCardStates() {
            for (const { enId } of API_CARDS) {
                const on = document.getElementById(enId)?.checked;
                document.getElementById(`${enId}-card`)?.classList.toggle('nico-api-off', !on);
            }
        }

        /**
         * APIキー検証関数を生成する共通ファクトリ
         * @param {HTMLElement} statusEl - 検証結果アイコン（✅/❌/⏳）を表示する要素
         * @param {Function} buildRequest - key を受け取り GM_xmlhttpRequest の url/headers を返す関数
         */
        function makeKeyValidator(statusEl, buildRequest) {
            const setIcon = (icon, title, color) => {
                statusEl.textContent = icon;
                statusEl.title = title;
                statusEl.style.color = color;
                updateStatusDot();
            };
            return (key) => {
                if (!key) { setIcon('❌', '未設定', UI_THEME.err); return; }
                setIcon('⏳', '検証中...', UI_THEME.accentDim);
                GM_xmlhttpRequest({
                    method: 'GET',
                    ...buildRequest(key),
                    onload: (res) => res.status === 200
                        ? setIcon('✅', 'API Key OK（利用対象）', UI_THEME.ok)
                        : setIcon('❌', `API Key エラー（HTTP ${res.status}／キーを確認してください）`, UI_THEME.err),
                    onerror: () => setIcon('❌', 'API Key エラー（通信失敗）', UI_THEME.err),
                });
            };
        }

        const validateApiKey = makeKeyValidator(document.getElementById('nico-apikey-status'), (key) => ({
            url: 'https://api.openai.com/v1/models',
            headers: { 'Authorization': `Bearer ${key}` },
        }));
        const validateClaudeKey = makeKeyValidator(document.getElementById('nico-claude-status'), (key) => ({
            url: 'https://api.anthropic.com/v1/models',
            headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        }));
        const validateGeminiKey = makeKeyValidator(document.getElementById('nico-gemini-status'), (key) => ({
            url: `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`,
        }));

        // APIキー入力欄の自動保存＋検証、および使用チェックボックスの保存
        const API_KEY_BINDINGS = [
            { inputId: 'nico-openai-key', storageKey: 'NICO_OPENAI_API_KEY', validator: validateApiKey,    enabledId: 'nico-openai-enabled', enabledKey: 'NICO_OPENAI_ENABLED' },
            { inputId: 'nico-claude-key', storageKey: 'NICO_CLAUDE_API_KEY', validator: validateClaudeKey, enabledId: 'nico-claude-enabled', enabledKey: 'NICO_CLAUDE_ENABLED' },
            { inputId: 'nico-gemini-key', storageKey: 'NICO_GEMINI_API_KEY', validator: validateGeminiKey, enabledId: 'nico-gemini-enabled', enabledKey: 'NICO_GEMINI_ENABLED' },
        ];
        for (const { inputId, storageKey, validator, enabledId, enabledKey } of API_KEY_BINDINGS) {
            const inputEl = document.getElementById(inputId);
            inputEl.addEventListener('change', () => {
                const key = inputEl.value.trim();
                GM_setValue(storageKey, key);
                validator(key);
            });
            document.getElementById(enabledId).addEventListener('change', (e) => {
                GM_setValue(enabledKey, e.target.checked);
                updateApiCardStates();
                updateStatusDot();
            });
        }

        // 保存済みAPIキーの一括検証ヘルパー
        function validateAllApiKeys() {
            for (const { storageKey, validator } of API_KEY_BINDINGS) {
                validator(GM_getValue(storageKey, '').trim());
            }
            updateStatusDot();
        }

        // 折りたたみトグル制御ハンドラ
        const toggleBtn = document.getElementById('nico-toggle');
        let panelCollapsed = true;

        function togglePanel() {
            panelCollapsed = !panelCollapsed;
            nicoBody.style.display = panelCollapsed ? 'none' : '';
            toggleBtn.textContent = panelCollapsed ? '▲' : '▼';
            toggleBtn.title = panelCollapsed ? '開く' : '折りたたむ';
            panel.style.minWidth = panelCollapsed ? 'auto' : '240px';
        }

        toggleBtn.addEventListener('mousedown', (e) => e.stopPropagation());
        toggleBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePanel(); });

        // タイトルバー（ドラッグハンドル）のダブルクリックで開閉
        dragHandle.addEventListener('dblclick', togglePanel);

        // ステータスバーは折りたたみ時のみクリックで展開する
        document.getElementById('nico-status-bar').addEventListener('click', () => {
            if (panelCollapsed) togglePanel();
        });

        // 初期状態の反映（APIキー検証・カード減光・音声セグメント・予算・コスト・ドット）
        validateAllApiKeys();
        updateApiCardStates();
        updateSpeechModeState();
        updateAiBudgetDisplay();
        updateCostDisplay();
        updateStatusDot();

        log('コントロールパネルを表示しました');
    }

    // =============================================
    // ホログラム表示用外部フォントの読み込み
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
    // デバッグログ出力関数
    // =============================================

    function log(...args) {
        if (CONFIG.debug) {
            console.log('[NicoIngress]', ...args);
        }
    }

    // =============================================
    // プラグイン初期化シーケンス
    // =============================================

    function main() {
        log('プラグインを起動します');

        loadFont();
        initOverlay();
        createControlPanel();

        // ネットワークフックをロード
        injectNetworkHook();

        const checkReady = setInterval(() => {
            if (window.addHook && window.portals !== undefined) {
                clearInterval(checkReady);
                log('IITC環境を検出しました');

                registerIITCHooks();

                // イベントハンドラ登録
                window.addHook('mapDataRefreshEnd', watchIITCComms);
                window.addHook('publicChatDataAvailable', watchIITCComms);
                window.addHook('factionChatDataAvailable', watchIITCComms);

            } else if (document.readyState === 'complete') {
                clearInterval(checkReady);
                log('純正Intel Map環境を検出しました');
            }
        }, 2000);

        log('初期化完了。イベント待機中...');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', main);
    } else {
        main();
    }

})();
