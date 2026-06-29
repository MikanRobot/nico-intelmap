// ==UserScript==
// @name         ニコニコインテルマップ
// @namespace    https://github.com/MikanRobot/nico-intelmap
// @version      1.3.0
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
        // コメントが表示される最低時間 (ms)
        minDuration: 4000,
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
        // AIコメントの表示文字色
        color: '#ff99ff',
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
        log('HUD投影レイヤーをデプロイしました');
    }

    /**
     * オーバーレイ表示領域をマップキャンバスの座標に合わせる
     */
    function fitToMap() {
        if (!commentContainer) return;

        // IITCまたは純正Intel MapのDOM要素を取得
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

        addDebugLog(`投影: ${text}`, color);
        log(`XMコメント投影: [${text}] lane=${laneIndex} dur=${Math.round(duration)}ms`);
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

        if (isChat) hasChatLog = true;

        // APIキーが設定されているか確認
        const openaiKey = GM_getValue('NICO_OPENAI_API_KEY', '').trim();
        const claudeKey = GM_getValue('NICO_CLAUDE_API_KEY', '').trim();
        const geminiKey = GM_getValue('NICO_GEMINI_API_KEY', '').trim();
        if (!openaiKey && !claudeKey && !geminiKey) {
            addDebugLog('外部コグニティブリンク未確立（API Keyを設定してください）', '#ff4444');
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

        addDebugLog(`[待機] AI共鳴波をスケジュール（${Math.round(timeToWait / 1000)}秒後）...`, '#666666');

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
        addDebugLog('🔊 音声合成モジュールの同調に成功しました', '#aaffaa');
    };
    ['click', 'mousedown', 'keydown', 'touchstart'].forEach(e => {
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

    /**
     * APIから返却されたAIコメントを整形・表示・読み上げする処理
     * @param {string} content - APIのJSONレスポンス
     * @param {string} apiName - 使用したAPIモデルの名称
     */
    function handleAiComments(content, apiName) {
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
                throw new Error('パースシグナルの異常');
            }
        } catch (e) {
            log(`[${apiName}] JSONデコード異常:`, e, cleaned.slice(0, 100));
            addDebugLog(`[${apiName}] コグニティブデータの復号に失敗`, '#ff4444');
            return;
        }

        addDebugLog(`[${apiName}] 外部共鳴(${comments.length}件): ${comments.map(c => `[${c.color}]${c.text}`).join(', ')}`, '#aaffaa');

        const isSpeechEnabled = GM_getValue('NICO_SPEECH_ENABLED', false);
        let maxDelay = 0;

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
            if (delay > maxDelay) maxDelay = delay;

            setTimeout(() => {
                let color;
                switch (comment.color) {
                    case 'blue': color = '#44aaff'; break;
                    case 'green': color = '#44ff88'; break;
                    case 'red': color = FACTION_COLORS.MACHINA; break;
                    default: color = '#ffffff'; break;
                }
                let size = CONFIG.fontSize;
                if (comment.color === 'white' && Math.random() < 0.1) size = CONFIG.fontSize * 1.5; // 10%の確率で文字サイズを1.5倍にする
                
                showComment(comment.text, color, size);

                if (isSpeechEnabled) {
                    if (!isAudioUnlocked) {
                        if (index === 0) addDebugLog('⚠️ オーディオチャネルのトリガー（画面のタップ）が必要です', '#ffcc88');
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
                        // 一般エージェント用の日本語音声設定
                        uttr.lang = 'ja-JP';
                        uttr.rate = 1.15;
                        uttr.pitch = 1.3;
                        const jpVoice = voices.find(v => v.lang.startsWith('ja') && (v.name.includes('Kyoko') || v.name.includes('Google 日本語') || v.name.includes('Megumi')));
                        if (jpVoice) uttr.voice = jpVoice;
                    }

                    enqueueSpeech(uttr);
                }
            }, delay);
        });
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
                max_tokens: Math.max(400, commentCount * 60 + 200),
                temperature: 0.9
            }),
            onload: (response) => {
                if (response.status === 429 || response.status >= 500) {
                    addDebugLog(`[OpenAI] パルス減衰(${response.status})。別セクターをサーチします...`, '#ffaa44');
                    if (onRetry) onRetry();
                    return;
                }
                if (response.status !== 200) {
                    addDebugLog(`[OpenAI] 接続エラー: ${response.status}`, '#ff4444');
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
            onerror: () => addDebugLog('[OpenAI] 通信障害', '#ff4444')
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
                max_tokens: Math.max(400, commentCount * 60 + 200),
                temperature: 0.9,
                system: 'You must output valid JSON only. Format: { "comments": [{"text": "...", "color": "white|blue|green|red"}] }',
                messages: [
                    { role: 'user', content: prompt }
                ]
            }),
            onload: (response) => {
                if (response.status === 429 || response.status >= 500) {
                    addDebugLog(`[Claude] パルス減衰(${response.status})。別セクターをサーチします...`, '#ffaa44');
                    if (onRetry) onRetry();
                    return;
                }
                if (response.status !== 200) {
                    addDebugLog(`[Claude] 接続エラー: ${response.status}`, '#ff4444');
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
            onerror: () => addDebugLog('[Claude] 通信障害', '#ff4444')
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
                if (response.status === 429 || response.status >= 500) {
                    addDebugLog(`[Gemini] パルス減衰(${response.status})。別セクターをサーチします...`, '#ffaa44');
                    if (onRetry) onRetry();
                    return;
                }
                if (response.status !== 200) {
                    addDebugLog(`[Gemini] 接続エラー: ${response.status}`, '#ff4444');
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
            onerror: () => addDebugLog('[Gemini] 通信障害', '#ff4444')
        });
    }

    /**
     * APIを呼び出してAIコメントを生成・トリガーする
     */
    function triggerAiComment(isForce = false) {
        if (eventQueue.length === 0 && !isForce) return;

        addDebugLog(`--- AIコグニティブ同調シーケンス開始 (手動: ${isForce}) ---`, '#cccccc');

        const openaiKey = GM_getValue('NICO_OPENAI_API_KEY', '').trim();
        const claudeKey = GM_getValue('NICO_CLAUDE_API_KEY', '').trim();
        const geminiKey = GM_getValue('NICO_GEMINI_API_KEY', '').trim();
        if (!openaiKey && !claudeKey && !geminiKey) {
            addDebugLog('エラー: コグニティブグリッドキーが一切ロードされていません', '#ff4444');
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

3. 【レジスタンス（RES/青）陣営バイアス】（全体の3%以下・blue）
   - ★RESが青リンクを引いた / ENLの緑ポータルや緑CFが破壊されたログがある場合のみ出す。
   - 自陣営（RES/青）の行動を称え、相手陣営（ENL/緑）を皮肉る。
   - 「青いコントロールフィールドが美しい」「人類の自由と知性を守るレジスタンス！」「緑の精神汚染（シェイパー）をADA様と共に拒絶する」「青リンクで世界を覆い尽くせ」「緑のCFが崩壊してXMが澄んでいく」など。

4. 【エンライテンド（ENL/緑）陣営バイアス】（全体の3%以下・green）
   - ★ENLが緑リンクを引いた / RESの青ポータルや青CFが破壊されたログがある場合のみ出す。
   - 自陣営（ENL/緑）の行動を称え、相手陣営（RES/青）を皮肉る。
   - 「シェイパーの導きによる人類進化！」「やはり緑のCFこそ至高」「ジャービス神に救済されよ」「青い束縛から解放し、啓発（エンライトン）するのだ」「青い壁を壊してXM of 光を受け入れよう」など。

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

        // 有効なAPIコールのランダムシャッフル（Fisher-Yates）
        const callers = [];
        if (openaiKey) callers.push((retry) => callOpenAI(prompt, commentCount, retry));
        if (claudeKey) callers.push((retry) => callClaude(prompt, commentCount, retry));
        if (geminiKey) callers.push((retry) => callGemini(prompt, commentCount, retry));

        if (callers.length === 0) return;

        for (let i = callers.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [callers[i], callers[j]] = [callers[j], callers[i]];
        }

        // 先頭のAPIから順にフォールバック制御しながら順次呼び出し
        let idx = 0;
        function tryNext() {
            if (idx >= callers.length) {
                addDebugLog('すべてのコグニティブグリッドが応答しません。バイパスします', '#ff4444');
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

        let hasNew = false;
        let currentTimestamp = -1;
        let groupedLogs = [];
        let isChatGroup = false;

        for (const [guid, entry] of entries) {
            if (lastCommsMessages.has(guid)) continue;
            lastCommsMessages.add(guid);

            const timestamp = entry[1];
            const parsed = parsePlextEntry(entry);
            if (!parsed) continue;

            const { text, isChat } = parsed;

            // システムメッセージから不要な重複ログを除外
            if (text.includes('under attack by') || text.includes('neutralized by') || text.includes('Battle Beacon')) {
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
            addDebugLog(`COMM ALLパケット受信 (バッファ ${commLogBuffer.length}件)`, '#66aaff');
        }

        if (lastCommsMessages.size > 500) {
            const arr = [...lastCommsMessages];
            lastCommsMessages = new Set(arr.slice(-300));
        }
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

        log('物理通信ポートへのフックに成功');
    }

    /**
     * ネットワークフック経由でパケットデータをパースする
     */
    function processPlextsData(results, isFaction = false) {
        if (!Array.isArray(results)) return;
        if (isFaction) return; // Factionチャット（陣営内部発言）はプライバシー保護のためキャプチャ対象外

        const sorted = [...results].sort((a, b) => a[1] - b[1]);

        let hasNew = false;
        let currentTimestamp = -1;
        let groupedLogs = [];
        let isChatGroup = false;

        for (const entry of sorted) {
            const guid = entry[0];
            const timestamp = entry[1];
            if (lastCommsMessages.has(guid)) continue;
            lastCommsMessages.add(guid);

            const parsed = parsePlextEntry(entry);
            if (!parsed) continue;

            const { text, isChat } = parsed;

            if (text.includes('under attack by') || text.includes('neutralized by') || text.includes('Battle Beacon')) {
                addDebugLog(`ノイズ排除: ${text.slice(0, 30)}...`, '#555555');
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
            addDebugLog(`ネットワークセグメントからCOMM ALL同期 (バッファ ${commLogBuffer.length}件)`, '#66aaff');
        }

        if (lastCommsMessages.size > 500) {
            const arr = [...lastCommsMessages];
            lastCommsMessages = new Set(arr.slice(-300));
        }
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

        log('IITCネットワークポートとの結合に成功');
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

        const savedApiKey = GM_getValue('NICO_OPENAI_API_KEY', '');

        panel.innerHTML = `
            <div id="nico-drag-handle" style="font-weight:bold;margin-bottom:8px;letter-spacing:1px;border-bottom:1px solid #555;padding-bottom:5px;cursor:move;display:flex;align-items:center;justify-content:space-between;" title="ドラッグして移動">
                <span style="display:flex;align-items:center;gap:8px;">
                    🎌 ニコニコインテルマップ
                    <a href="https://github.com/MikanRobot/nico-intelmap" target="_blank" style="font-size:10px;color:#88aaff;text-decoration:none;background:rgba(91,143,255,0.15);border:1px solid rgba(91,143,255,0.4);border-radius:4px;padding:1px 6px;white-space:nowrap;">詳細</a>
                </span>
                <button id="nico-toggle" style="background:none;border:none;color:#fff;font-size:16px;cursor:pointer;padding:0 4px;line-height:1;" title="開く">▲</button>
            </div>

            <div id="nico-body" style="display:none;">
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
                        <label><input type="checkbox" id="nico-speech-enabled" ${GM_getValue('NICO_SPEECH_ENABLED', false) ? 'checked' : ''}> 🔊 音声読み上げ</label>
                    </div>
                    <div style="margin-bottom:8px;padding-top:8px;border-top:1px solid #444;">
                        <label><input type="checkbox" id="nico-debug-enabled"> 🛠️ デバッグ表示</label>
                    </div>
                    <div id="nico-debug-log" style="display:none;background:#111;color:#ccc;font-size:11px;height:70px;overflow-y:auto;padding:4px;margin-bottom:8px;border:1px solid #444;border-radius:3px;word-break:break-all;"></div>
                    <div style="flex: 1;"></div>
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
                    <div id="nico-api-active-summary" style="margin-top:12px;padding:8px;background:rgba(255,255,255,0.05);border:1px solid #555;border-radius:4px;font-size:11px;line-height:1.4;color:#ccc;">
                        ⏳ 読み込み中...
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

        // パネルタブ切り替えハンドラ
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

        // コメント数入力同期ハンドラ
        const commentCountInput = document.getElementById('nico-comment-count');
        commentCountInput.addEventListener('change', () => {
            const val = Math.max(1, Math.min(100, parseInt(commentCountInput.value, 10) || 7));
            commentCountInput.value = val;
            GM_setValue('NICO_COMMENT_COUNT', val);
        });

        // 音声合成有効・無効切り替え
        const speechCb = document.getElementById('nico-speech-enabled');
        speechCb.addEventListener('change', () => {
            GM_setValue('NICO_SPEECH_ENABLED', speechCb.checked);
            if (!speechCb.checked) cancelAllSpeech();
        });

        // システムデバッグログ表示切り替え
        const debugCb = document.getElementById('nico-debug-enabled');
        const debugLog = document.getElementById('nico-debug-log');
        debugCb.addEventListener('change', () => {
            debugLog.style.display = debugCb.checked ? 'block' : 'none';
        });

        // プラグイン有効化切り替え
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
        });

        // OpenAI APIキー自動保存と実地検証
        const apiKeyInput = document.getElementById('nico-openai-key');
        const apiKeyStatus = document.getElementById('nico-apikey-status');

        function updateActiveApiSummary() {
            const summaryEl = document.getElementById('nico-api-active-summary');
            if (!summaryEl) return;

            const activeApis = [];
            const openaiKey = GM_getValue('NICO_OPENAI_API_KEY', '').trim();
            const claudeKey = GM_getValue('NICO_CLAUDE_API_KEY', '').trim();
            const geminiKey = GM_getValue('NICO_GEMINI_API_KEY', '').trim();

            const openAiOk = document.getElementById('nico-apikey-status')?.textContent.includes('OK');
            const claudeOk = document.getElementById('nico-claude-status')?.textContent.includes('OK');
            const geminiOk = document.getElementById('nico-gemini-status')?.textContent.includes('OK');

            if (openaiKey && openAiOk) activeApis.push('OpenAI');
            if (claudeKey && claudeOk) activeApis.push('Claude');
            if (geminiKey && geminiOk) activeApis.push('Gemini');

            if (activeApis.length > 0) {
                summaryEl.innerHTML = `⚙️ <b>読み込み完了</b>:<br>現在 <span style="color:#44ff88;font-weight:bold;">${activeApis.join(', ')}</span> のAPIキーを読み込み、利用中です。（AIコメント生成時にランダムに自動選択・フォールバックされます）`;
                summaryEl.style.borderColor = '#44ff88';
            } else {
                summaryEl.innerHTML = `⚠️ <b>読み込み失敗</b>:<br><span style="color:#ff4444;">有効なAPIキーが読み込まれていません。いずれかのAPI設定を行ってください。</span>`;
                summaryEl.style.borderColor = '#ff4444';
            }
        }

        function validateApiKey(key) {
            if (!key) {
                apiKeyStatus.textContent = '❌ 未設定';
                apiKeyStatus.style.color = '#ff4444';
                updateActiveApiSummary();
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
                        apiKeyStatus.textContent = '✅ API Key OK (利用対象)';
                        apiKeyStatus.style.color = '#44ff88';
                    } else {
                        apiKeyStatus.textContent = '❌ API Key Err';
                        apiKeyStatus.style.color = '#ff4444';
                    }
                    updateActiveApiSummary();
                },
                onerror: () => {
                    apiKeyStatus.textContent = '❌ API Key Err';
                    apiKeyStatus.style.color = '#ff4444';
                    updateActiveApiSummary();
                }
            });
        }

        apiKeyInput.addEventListener('change', () => {
            const key = apiKeyInput.value.trim();
            GM_setValue('NICO_OPENAI_API_KEY', key);
            validateApiKey(key);
        });

        // Claude APIキー自動保存と検証
        const claudeKeyInput = document.getElementById('nico-claude-key');
        const claudeStatus = document.getElementById('nico-claude-status');

        function validateClaudeKey(key) {
            if (!key) {
                claudeStatus.textContent = '❌ 未設定';
                claudeStatus.style.color = '#ff4444';
                updateActiveApiSummary();
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
                        claudeStatus.textContent = '✅ API Key OK (利用対象)';
                        claudeStatus.style.color = '#44ff88';
                    } else {
                        claudeStatus.textContent = '❌ API Key Err';
                        claudeStatus.style.color = '#ff4444';
                    }
                    updateActiveApiSummary();
                },
                onerror: () => {
                    claudeStatus.textContent = '❌ API Key Err';
                    claudeStatus.style.color = '#ff4444';
                    updateActiveApiSummary();
                }
            });
        }

        claudeKeyInput.addEventListener('change', () => {
            const key = claudeKeyInput.value.trim();
            GM_setValue('NICO_CLAUDE_API_KEY', key);
            validateClaudeKey(key);
        });

        // Gemini APIキー自動保存と検証
        const geminiKeyInput = document.getElementById('nico-gemini-key');
        const geminiStatus = document.getElementById('nico-gemini-status');

        function validateGeminiKey(key) {
            if (!key) {
                geminiStatus.textContent = '❌ 未設定';
                geminiStatus.style.color = '#ff4444';
                updateActiveApiSummary();
                return;
            }
            geminiStatus.textContent = '⏳ テスト中...';
            geminiStatus.style.color = '#aaa';
            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`,
                onload: (res) => {
                    if (res.status === 200) {
                        geminiStatus.textContent = '✅ API Key OK (利用対象)';
                        geminiStatus.style.color = '#44ff88';
                    } else {
                        geminiStatus.textContent = '❌ API Key Err';
                        geminiStatus.style.color = '#ff4444';
                    }
                    updateActiveApiSummary();
                },
                onerror: () => {
                    geminiStatus.textContent = '❌ API Key Err';
                    geminiStatus.style.color = '#ff4444';
                    updateActiveApiSummary();
                }
            });
        }

        geminiKeyInput.addEventListener('change', () => {
            const key = geminiKeyInput.value.trim();
            GM_setValue('NICO_GEMINI_API_KEY', key);
            validateGeminiKey(key);
        });

        // 保存済みAPIキーの一括検証ヘルパー
        function validateAllApiKeys() {
            const savedApiKey = GM_getValue('NICO_OPENAI_API_KEY', '');
            const savedClaudeKey = GM_getValue('NICO_CLAUDE_API_KEY', '');
            const savedGeminiKey = GM_getValue('NICO_GEMINI_API_KEY', '');

            if (savedApiKey) {
                validateApiKey(savedApiKey);
            } else {
                apiKeyStatus.textContent = '❌ 未設定';
                apiKeyStatus.style.color = '#ff4444';
            }

            if (savedClaudeKey) {
                validateClaudeKey(savedClaudeKey);
            } else {
                claudeStatus.textContent = '❌ 未設定';
                claudeStatus.style.color = '#ff4444';
            }

            if (savedGeminiKey) {
                validateGeminiKey(savedGeminiKey);
            } else {
                geminiStatus.textContent = '❌ 未設定';
                geminiStatus.style.color = '#ff4444';
            }

            updateActiveApiSummary();
        }

        // 折りたたみトグル制御ハンドラ
        const nicoBody = document.getElementById('nico-body');
        const toggleBtn = document.getElementById('nico-toggle');
        let panelCollapsed = true;
        panel.style.minWidth = 'auto';

        function togglePanel() {
            panelCollapsed = !panelCollapsed;
            nicoBody.style.display = panelCollapsed ? 'none' : '';
            toggleBtn.textContent = panelCollapsed ? '▲' : '▼';
            toggleBtn.title = panelCollapsed ? '開く' : '折りたたむ';
            panel.style.minWidth = panelCollapsed ? 'auto' : '220px';
        }

        toggleBtn.addEventListener('mousedown', (e) => e.stopPropagation());
        toggleBtn.addEventListener('click', togglePanel);

        // タイトルバー（ドラッグハンドル）のダブルクリックで開閉
        dragHandle.addEventListener('dblclick', togglePanel);

        // 起動時に保存済みのAPIキーを一括自動検証
        validateAllApiKeys();

        log('コントロールパネルをデプロイしました');
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
        log('ブートシーケンスを開始します');

        loadFont();
        initOverlay();
        createControlPanel();

        // ネットワークフックをロード
        injectNetworkHook();

        const checkReady = setInterval(() => {
            if (window.addHook && window.portals !== undefined) {
                clearInterval(checkReady);
                log('IITCスキャナー環境を検知');

                registerIITCHooks();

                // イベントハンドラ登録
                window.addHook('mapDataRefreshEnd', watchIITCComms);
                window.addHook('publicChatDataAvailable', watchIITCComms);
                window.addHook('factionChatDataAvailable', watchIITCComms);

            } else if (document.readyState === 'complete') {
                clearInterval(checkReady);
                log('純正Intelスキャナー環境を検知');
            }
        }, 2000);

        log('スキャナーHUDの同期完了。XM受信待機中...');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', main);
    } else {
        main();
    }

})();
