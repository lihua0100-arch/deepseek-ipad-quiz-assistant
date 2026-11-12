// ==UserScript==
// @name    DeepSeek 智能题库助手 (iPad 学习通/U校园/全平台触屏通用版)
// @namespace    https://tampermonkey.net/
// @version      3.4.0
// @updateURL    https://raw.githubusercontent.com/lihua0100-arch/deepseek-ipad-quiz-assistant/main/deepseek-ipad-quiz-assistant.user.js
// @downloadURL  https://raw.githubusercontent.com/lihua0100-arch/deepseek-ipad-quiz-assistant/main/deepseek-ipad-quiz-assistant.user.js
// @description  专为 iPad Safari 与 Mac 打造（全面适配学习通 mooc1.chaoxing.com、U校园、超星尔雅）：1.突破 DeepSeek API 无联网限制，利用油猴跨域特权内置【Bing/百度实时联网搜题引擎(RAG)】，自动抓取全网原题题库摘要喂给模型；2.内置【全卷30题上下文前后互证】（如第29题自动参考第13题题干中的“3°”）；3.采用 V3+联网搜题+8路并发流水线，彻底消除第13题长思考卡顿！
// @author       Gemini
// @match        *://*/*
// @allFrames    true
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      api.deepseek.com
// @connect      cn.bing.com
// @connect      www.bing.com
// @connect      www.baidu.com
// @connect      m.baidu.com
// @connect      *
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    if (window.self !== window.top && (window.innerWidth < 120 || window.innerHeight < 80)) {
        return;
    }

    const IS_MAC = /Mac|iPod|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

    /********************************************************************
     * 1. 配置参数与全局状态
     ********************************************************************/
    const CONFIG = {
        apiUrl: 'https://api.deepseek.com/chat/completions',
        longPressDuration: 450,
        concurrency: 6,           // 6 路并发预取（联网搜题 + AI推理并行流水线，彻底告别第13题卡顿）
        enableWebSearch: true,    // 默认开启实时联网搜题增强 (RAG)
        searchTimeoutMs: 3200     // 联网搜索最大超时时间（毫秒），超时立即无缝走模型推理，绝不卡顿
    };

    const STATE = {
        apiKey: GM_getValue('DEEPSEEK_API_KEY', ''),
        // 有了实时联网搜题(RAG)与全卷互证，默认使用响应极快的 deepseek-chat (V3)，彻底消除 R1 思考 15 秒导致的卡顿！
        model: GM_getValue('DEEPSEEK_MODEL_V34', 'deepseek-chat'),
        webSearchEnabled: GM_getValue('DEEPSEEK_WEB_SEARCH', true),
        verifiedBank: GM_getValue('DEEPSEEK_VERIFIED_BANK', {}),
        isAnalyzing: false,
        isBatchRunning: false,
        stopBatchRequested: false,
        lastPickedScope: null,
        lastMousePos: { x: window.innerWidth / 2, y: window.innerHeight / 2 }
    };

    function normalizeStemKey(text) {
        return String(text || '')
            .replace(/^\s*\d+[.、\s)）]*/, '')
            .replace(/\([单多判填简]选题.*?\)/g, '')
            .replace(/[\s_—\-，。；：？！、,.?;:!()（）【】\[\]"'“”‘’]/g, '')
            .slice(0, 80);
    }

    /********************************************************************
     * 2. 实时联网搜题引擎 (Web Search RAG via GM_xmlhttpRequest)
     * 原理：DeepSeek 官方 API 默认是离线模型，无法上网查国内题库原题。
     * 本模块利用油猴 GM_xmlhttpRequest 跨域能力，在发给 DeepSeek 前实时向
     * 必应 (Bing) 与百度并发检索题干原题，提取网课/船员题库/专业课网页摘要喂给 DeepSeek！
     ********************************************************************/
    function cleanSearchQuery(stemText) {
        return String(stemText || '')
            .replace(/^\s*\d+[.、\s)）]*/, '')
            .replace(/\(\s*[单多判填简]选题[^)]*\)/g, '')
            .replace(/\[\[.*?\]\]/g, ' ')
            .replace(/_{2,}/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 72);
    }

    function fetchUrlTextWithTimeout(url, timeoutMs = CONFIG.searchTimeoutMs) {
        return new Promise((resolve) => {
            let settled = false;
            const timer = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    resolve('');
                }
            }, timeoutMs);

            try {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url,
                    headers: {
                        'Accept': 'text/html,application/xhtml+xml',
                        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
                    },
                    timeout: timeoutMs,
                    onload: (res) => {
                        if (settled) return;
                        settled = true;
                        clearTimeout(timer);
                        resolve(res.status === 200 ? (res.responseText || '') : '');
                    },
                    onerror: () => {
                        if (settled) return;
                        settled = true;
                        clearTimeout(timer);
                        resolve('');
                    },
                    ontimeout: () => {
                        if (settled) return;
                        settled = true;
                        clearTimeout(timer);
                        resolve('');
                    }
                });
            } catch (_) {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    resolve('');
                }
            }
        });
    }

    function parseSearchSnippetsFromHTML(html) {
        if (!html) return [];
        const doc = new DOMParser().parseFromString(html, 'text/html');
        doc.querySelectorAll('script, style, noscript, nav, header, footer').forEach(el => el.remove());

        const snippets = [];
        // 提取 Bing (.b_algo, .b_caption) 与 百度 (.c-container, .c-abstract, .content-right_8Zs40) 的搜索结果摘要
        const selectors = [
            '.b_algo', '.b_caption p', '.b_snippet',
            '.c-container', '.c-abstract', '[class*="content-right"]', '[class*="summary"]', '.result'
        ];
        const nodes = doc.querySelectorAll(selectors.join(','));
        for (const node of nodes) {
            const txt = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
            if (txt.length >= 20 && txt.length <= 450 && !snippets.includes(txt)) {
                snippets.push(txt);
            }
            if (snippets.length >= 5) break;
        }
        return snippets;
    }

    async function searchWebForQuestionClues(stemText, optionsList = []) {
        if (!STATE.webSearchEnabled) return '';
        const query = cleanSearchQuery(stemText);
        if (query.length < 5) return '';

        const optKeywords = optionsList.slice(0, 4).map(o => o.cleanContent).join(' ');
        const fullQuery = `${query} ${optKeywords}`.slice(0, 95);

        const bingUrl = `https://cn.bing.com/search?q=${encodeURIComponent(fullQuery)}`;
        const baiduUrl = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=5`;

        const [bingHtml, baiduHtml] = await Promise.all([
            fetchUrlTextWithTimeout(bingUrl, CONFIG.searchTimeoutMs),
            fetchUrlTextWithTimeout(baiduUrl, CONFIG.searchTimeoutMs)
        ]);

        const combinedSnippets = [
            ...parseSearchSnippetsFromHTML(bingHtml),
            ...parseSearchSnippetsFromHTML(baiduHtml)
        ].slice(0, 6);

        return combinedSnippets.join('\n---\n').slice(0, 1600);
    }

    /********************************************************************
     * 3. 页面主环境点击桥接器 (Main-World Click Bridge)
     ********************************************************************/
    function injectMainWorldBridge() {
        if (document.getElementById('ds-mainworld-bridge')) return;
        const script = document.createElement('script');
        script.id = 'ds-mainworld-bridge';
        script.textContent = `
            (function() {
                window.addEventListener('ds-mainworld-click', function() {
                    var targets = document.querySelectorAll('[data-ds-click-target]');
                    targets.forEach(function(el) {
                        el.removeAttribute('data-ds-click-target');
                        try {
                            var row = el.closest('.answerBg, .single_choice li, .multi_choice li, .true_false li, .answerList li, .ant-radio-wrapper, .ant-checkbox-wrapper, .el-radio, .el-checkbox, li') || el;
                            var badge = row.querySelector('.num_option, .num_option_dx, .ans-radio, .ans-checkbox, input[type="radio"], input[type="checkbox"], .ant-radio-input, .ant-checkbox-input, a, label');

                            var isSelected = function(node) {
                                if (!node) return false;
                                if (node.querySelector('input:checked')) return true;
                                if (node.querySelector('.check_answer, .check_answer_dx, .ant-radio-checked, .ant-checkbox-checked, .is-checked')) return true;
                                return /\\b(check_answer|check_answer_dx|checked|selected|active|cur|on)\\b/i.test(node.className || '');
                            };

                            if (isSelected(row)) return;

                            var triggerNode = function(n) {
                                if (!n) return;
                                if (window.jQuery) {
                                    try { window.jQuery(n).trigger('tap'); } catch(_) {}
                                    try { window.jQuery(n).trigger('click'); } catch(_) {}
                                } else if (window.$ && typeof window.$.fn === 'object') {
                                    try { window.$(n).trigger('tap'); } catch(_) {}
                                    try { window.$(n).trigger('click'); } catch(_) {}
                                }
                                try { n.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); } catch(_) {}
                                try { n.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true })); } catch(_) {}
                                try { n.click(); } catch(_) {}
                            };

                            triggerNode(row);
                            if (!isSelected(row) && badge && badge !== row) {
                                triggerNode(badge);
                            }
                            if (!isSelected(row) && el !== row && el !== badge) {
                                triggerNode(el);
                            }
                        } catch (err) {
                            console.error('[DS MainWorld Click]', err);
                        }
                    });
                });
            })();
        `;
        (document.head || document.documentElement).appendChild(script);
    }
    injectMainWorldBridge();

    /********************************************************************
     * 4. UI 样式
     ********************************************************************/
    const isTopFrame = window.self === window.top;

    const styleEl = document.createElement('style');
    styleEl.textContent = `
        html, body, body * {
            -webkit-user-select: text !important;
            user-select: text !important;
            -webkit-touch-callout: default !important;
        }

        #ds-fab {
            position: fixed;
            right: 22px;
            bottom: 240px;
            width: 54px;
            height: 54px;
            border-radius: 50%;
            background: rgba(15, 23, 42, 0.92);
            color: #38bdf8;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 4px 18px rgba(0, 0, 0, 0.42);
            border: 1.5px solid rgba(56, 189, 248, 0.45);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            z-index: 2147483647;
            touch-action: none;
            user-select: none !important;
            -webkit-user-select: none !important;
            -webkit-touch-callout: none !important;
            -webkit-tap-highlight-color: transparent;
            font-size: 23px;
            cursor: pointer;
            will-change: transform;
            transition: transform 0.18s ease, box-shadow 0.2s ease, border-color 0.2s ease;
        }
        #ds-fab:active {
            transform: scale(0.92);
        }

        #ds-fab.ds-loading {
            animation: ds-spin-normal 1s linear infinite;
        }
        @keyframes ds-spin-normal {
            0% { transform: rotate3d(0, 0, 1, 0deg); }
            100% { transform: rotate3d(0, 0, 1, 360deg); }
        }

        #ds-fab.ds-turbo-spin {
            border-color: #10b981 !important;
            background: radial-gradient(circle, rgba(6, 95, 70, 0.98) 0%, rgba(15, 23, 42, 0.98) 100%) !important;
            box-shadow: 0 0 28px rgba(16, 185, 129, 0.98), 0 0 56px rgba(56, 189, 248, 0.75) !important;
            animation: ds-spin-turbo 0.2s linear infinite !important;
        }
        @keyframes ds-spin-turbo {
            0% { transform: scale3d(1.14, 1.14, 1) rotate3d(0, 0, 1, 0deg); }
            50% { transform: scale3d(1.2, 1.2, 1) rotate3d(0, 0, 1, 180deg); }
            100% { transform: scale3d(1.14, 1.14, 1) rotate3d(0, 0, 1, 360deg); }
        }

        #ds-card {
            position: fixed;
            right: 16px;
            bottom: 92px;
            width: 355px;
            max-width: calc(100vw - 32px);
            background: rgba(15, 23, 42, 0.95);
            color: #f8fafc;
            border-radius: 14px;
            border: 1px solid rgba(148, 163, 184, 0.32);
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.52);
            backdrop-filter: blur(14px);
            -webkit-backdrop-filter: blur(14px);
            z-index: 2147483646;
            font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", system-ui, sans-serif;
            font-size: 13px;
            line-height: 1.5;
            padding: 12px 14px;
            display: none;
            user-select: text;
        }

        .ds-card-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            border-bottom: 1px solid rgba(148, 163, 184, 0.2);
            padding-bottom: 6px;
            margin-bottom: 8px;
        }
        .ds-card-title {
            font-weight: 600;
            color: #38bdf8;
            font-size: 14px;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .ds-card-close {
            color: #94a3b8;
            font-size: 16px;
            padding: 2px 6px;
            cursor: pointer;
        }

        .ds-answer-box {
            background: rgba(30, 41, 59, 0.78);
            border-radius: 8px;
            padding: 8px 10px;
            margin-bottom: 8px;
            border-left: 3px solid #10b981;
            word-break: break-word;
        }
        .ds-answer-main {
            font-size: 15px;
            font-weight: 600;
            color: #10b981;
            margin-bottom: 4px;
            user-select: all;
        }
        .ds-answer-sub {
            font-size: 12px;
            color: #cbd5e1;
            margin-top: 4px;
            line-height: 1.4;
        }

        .ds-progress-bar-bg {
            width: 100%;
            height: 6px;
            background: rgba(51, 65, 85, 0.8);
            border-radius: 3px;
            overflow: hidden;
            margin: 6px 0;
        }
        .ds-progress-bar-fill {
            height: 100%;
            background: linear-gradient(90deg, #10b981, #38bdf8);
            width: 0%;
            transition: width 0.22s ease;
        }

        .ds-card-actions {
            display: flex;
            gap: 6px;
            flex-wrap: wrap;
        }
        .ds-btn {
            background: #1e293b;
            color: #f1f5f9;
            border: 1px solid rgba(148, 163, 184, 0.3);
            border-radius: 6px;
            padding: 5px 8px;
            font-size: 11.5px;
            cursor: pointer;
            -webkit-tap-highlight-color: transparent;
            display: inline-flex;
            align-items: center;
            gap: 4px;
        }
        .ds-btn:active {
            background: #334155;
        }
        .ds-btn-fill {
            background: #065f46;
            color: #a7f3d0;
            border-color: #059669;
            font-weight: 500;
        }

        .ds-correct-highlight {
            outline: 2px solid #10b981 !important;
            background-color: rgba(16, 185, 129, 0.14) !important;
            outline-offset: 2px !important;
            border-radius: 6px !important;
            box-shadow: 0 0 10px rgba(16, 185, 129, 0.45) !important;
        }
        .ds-auto-clicked-pulse {
            outline: 3px solid #34d399 !important;
            background-color: rgba(16, 185, 129, 0.3) !important;
            box-shadow: 0 0 22px rgba(16, 185, 129, 0.85) !important;
        }
        .ds-scope-flash {
            outline: 2px dashed rgba(56, 189, 248, 0.85) !important;
            outline-offset: 4px !important;
            border-radius: 6px !important;
        }
    `;
    document.head.appendChild(styleEl);

    window.addEventListener('selectstart', (e) => e.stopPropagation(), true);
    window.addEventListener('copy', (e) => e.stopPropagation(), true);

    let fabEl = null;
    let cardEl = null;

    function getUIElements() {
        try {
            const topDoc = window.top.document;
            return {
                fab: topDoc.getElementById('ds-fab') || fabEl,
                card: topDoc.getElementById('ds-card') || cardEl,
                contentBox: topDoc.getElementById('ds-card-content'),
                footerBox: topDoc.getElementById('ds-card-footer'),
                sweepBtn: topDoc.getElementById('ds-btn-autosweep'),
                searchBtn: topDoc.getElementById('ds-btn-websearch'),
                modelBtn: topDoc.getElementById('ds-btn-switch-model')
            };
        } catch (_) {
            return {
                fab: fabEl,
                card: cardEl,
                contentBox: document.getElementById('ds-card-content'),
                footerBox: document.getElementById('ds-card-footer'),
                sweepBtn: document.getElementById('ds-btn-autosweep'),
                searchBtn: document.getElementById('ds-btn-websearch'),
                modelBtn: document.getElementById('ds-btn-switch-model')
            };
        }
    }

    if (isTopFrame) {
        fabEl = document.createElement('div');
        fabEl.id = 'ds-fab';
        fabEl.innerHTML = '🎯';
        fabEl.title = '单击：联网解析单题 | 长按 或 连点3下：实时联网搜题 + 全卷互证丝滑全选！';
        document.body.appendChild(fabEl);

        cardEl = document.createElement('div');
        cardEl.id = 'ds-card';
        cardEl.innerHTML = `
            <div class="ds-card-header">
                <span class="ds-card-title">🌐 DeepSeek 题库助手 3.4 (联网搜题版)</span>
                <span class="ds-card-close" id="ds-card-close-btn">✕</span>
            </div>
            <div id="ds-card-content">
                <div style="color:#94a3b8;font-size:12px;">
                    • <b>轻点 1 下 🎯</b>：联网搜题解析单题（在批改页则自动记忆答案）<br>
                    • <b>长按 🎯 或 连点 3 下 🎯</b>：启动<b>🌐 实时联网搜原题 + 全卷30题互证 + 6路极速并发</b>，不卡顿高准全选！
                </div>
            </div>
            <div class="ds-card-actions" id="ds-card-footer" style="margin-top:6px;display:flex;">
                <button class="ds-btn ds-btn-fill" id="ds-btn-autosweep">🚀 联网全卷高准全选</button>
                <button class="ds-btn" id="ds-btn-websearch">${STATE.webSearchEnabled ? '🌐 联网搜题:开' : '📴 联网搜题:关'}</button>
                <button class="ds-btn" id="ds-btn-switch-model">${STATE.model === 'deepseek-reasoner' ? '🧠 R1深度' : '⚡ V3极速(不卡顿)'}</button>
            </div>
        `;
        document.body.appendChild(cardEl);

        document.getElementById('ds-card-close-btn').addEventListener('click', () => {
            cardEl.style.display = 'none';
        });

        document.getElementById('ds-btn-autosweep').addEventListener('click', () => {
            if (STATE.isBatchRunning) {
                STATE.stopBatchRequested = true;
            } else {
                startFullPageAutoSweep();
            }
        });

        document.getElementById('ds-btn-websearch').addEventListener('click', (e) => {
            STATE.webSearchEnabled = !STATE.webSearchEnabled;
            GM_setValue('DEEPSEEK_WEB_SEARCH', STATE.webSearchEnabled);
            e.currentTarget.innerText = STATE.webSearchEnabled ? '🌐 联网搜题:开' : '📴 联网搜题:关';
        });

        document.getElementById('ds-btn-switch-model').addEventListener('click', (e) => {
            STATE.model = STATE.model === 'deepseek-chat' ? 'deepseek-reasoner' : 'deepseek-chat';
            GM_setValue('DEEPSEEK_MODEL_V34', STATE.model);
            e.currentTarget.innerText = STATE.model === 'deepseek-reasoner' ? '🧠 R1深度' : '⚡ V3极速(不卡顿)';
        });

        fabEl.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
        });

        let isPressing = false;
        let startX = 0, startY = 0;
        let initialLeft = 0, initialTop = 0;
        let hasMoved = false;
        let longPressTriggered = false;
        let longPressTimer = null;
        let tapCount = 0;
        let tapResolveTimer = null;

        const clearLongPressTimer = () => {
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
        };

        const onPointerStart = (clientX, clientY) => {
            isPressing = true;
            hasMoved = false;
            longPressTriggered = false;
            startX = clientX;
            startY = clientY;
            const rect = fabEl.getBoundingClientRect();
            initialLeft = rect.left;
            initialTop = rect.top;

            clearLongPressTimer();
            longPressTimer = setTimeout(() => {
                if (isPressing && !hasMoved) {
                    longPressTriggered = true;
                    tapCount = 0;
                    if (tapResolveTimer) clearTimeout(tapResolveTimer);
                    startFullPageAutoSweep();
                }
            }, CONFIG.longPressDuration);
        };

        const onPointerMove = (clientX, clientY) => {
            if (!isPressing) return;
            const dx = clientX - startX;
            const dy = clientY - startY;
            if (Math.hypot(dx, dy) > 10) {
                hasMoved = true;
                clearLongPressTimer();
                const newLeft = Math.max(10, Math.min(window.innerWidth - 60, initialLeft + dx));
                const newTop = Math.max(10, Math.min(window.innerHeight - 60, initialTop + dy));
                fabEl.style.left = `${newLeft}px`;
                fabEl.style.top = `${newTop}px`;
                fabEl.style.right = 'auto';
                fabEl.style.bottom = 'auto';
            }
        };

        const onPointerEnd = () => {
            clearLongPressTimer();
            isPressing = false;
        };

        fabEl.addEventListener('touchstart', (e) => {
            if (e.touches.length === 1) {
                onPointerStart(e.touches[0].clientX, e.touches[0].clientY);
            }
        }, { passive: true });

        window.addEventListener('touchmove', (e) => {
            if (isPressing && e.touches.length === 1) {
                onPointerMove(e.touches[0].clientX, e.touches[0].clientY);
            }
        }, { passive: true });

        window.addEventListener('touchend', onPointerEnd);
        window.addEventListener('touchcancel', onPointerEnd);

        fabEl.addEventListener('mousedown', (e) => {
            if (e.button === 0) {
                onPointerStart(e.clientX, e.clientY);
            }
        });

        window.addEventListener('mousemove', (e) => {
            if (isPressing) {
                onPointerMove(e.clientX, e.clientY);
            }
        });

        window.addEventListener('mouseup', onPointerEnd);

        fabEl.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (hasMoved || longPressTriggered) return;

            if (STATE.isBatchRunning) {
                STATE.stopBatchRequested = true;
                return;
            }

            tapCount += 1;
            if (tapResolveTimer) clearTimeout(tapResolveTimer);

            if (tapCount >= 3) {
                tapCount = 0;
                startFullPageAutoSweep();
            } else {
                tapResolveTimer = setTimeout(() => {
                    tapCount = 0;
                    triggerSingleQuestionAnalysis();
                }, 300);
            }
        });
    }

    window.addEventListener('click', (e) => {
        const hit = e.target;
        const ui = getUIElements();
        if (hit && (!ui.fab || !ui.fab.contains(hit)) && (!ui.card || !ui.card.contains(hit))) {
            if (e.isTrusted) {
                STATE.lastPickedScope = hit;
            }
        }
    }, true);

    window.addEventListener('touchstart', (e) => {
        const hit = e.target;
        const ui = getUIElements();
        if (hit && (!ui.fab || !ui.fab.contains(hit)) && (!ui.card || !ui.card.contains(hit))) {
            STATE.lastPickedScope = hit;
            if (e.touches[0]) {
                STATE.lastMousePos.x = e.touches[0].clientX;
                STATE.lastMousePos.y = e.touches[0].clientY;
            }
        }
    }, { passive: true });

    /********************************************************************
     * 5. 批改结果页自动记忆引擎
     ********************************************************************/
    function harvestGradedPageAnswers() {
        const blocks = querySelectorAllDeep('.TiMu, .questionLi, .singleQuesId, .question-item, [class*="question"]');
        let learnedRight = 0;
        let learnedWrong = 0;
        const bank = Object.assign({}, GM_getValue('DEEPSEEK_VERIFIED_BANK', {}));

        for (const block of blocks) {
            const fullTxt = (block.innerText || '').replace(/\s+/g, ' ').trim();
            if (!fullTxt.includes('我的答案')) continue;

            const opts = extractOptionsFromBlock(block);
            const stem = extractPureQuestionStem(block, opts, null);
            const key = normalizeStemKey(stem);
            if (!key || key.length < 4) continue;

            const myAnsMatch = fullTxt.match(/我的答案\s*[:：]\s*([A-H]+)/i);
            const rightAnsMatch = fullTxt.match(/正确答案\s*[:：]\s*([A-H]+)/i);
            const isMarkedCorrect = Boolean(
                block.querySelector('.marking_duigou, .icon-right, [class*="right"], [class*="correct"]') ||
                (myAnsMatch && rightAnsMatch && myAnsMatch[1].toUpperCase() === rightAnsMatch[1].toUpperCase()) ||
                (/[1-9]\d*\s*分/.test(fullTxt) && !/\b0\s*分/.test(fullTxt))
            );
            const isMarkedWrong = Boolean(
                block.querySelector('.marking_cuowu, .icon-wrong, [class*="wrong"], [class*="error"]') ||
                /\b0\s*分/.test(fullTxt)
            );

            const entry = bank[key] || { correctLetters: [], wrongLetters: [] };

            if (rightAnsMatch) {
                entry.correctLetters = rightAnsMatch[1].toUpperCase().split('');
                learnedRight++;
            } else if (isMarkedCorrect && myAnsMatch) {
                entry.correctLetters = myAnsMatch[1].toUpperCase().split('');
                learnedRight++;
            } else if (isMarkedWrong && myAnsMatch) {
                const wrongLet = myAnsMatch[1].toUpperCase();
                if (!entry.wrongLetters.includes(wrongLet)) {
                    entry.wrongLetters.push(wrongLet);
                }
                learnedWrong++;
            }

            bank[key] = entry;
        }

        if (learnedRight > 0 || learnedWrong > 0) {
            STATE.verifiedBank = bank;
            GM_setValue('DEEPSEEK_VERIFIED_BANK', bank);
            const ui = getUIElements();
            if (ui.card && ui.contentBox) {
                ui.card.style.display = 'block';
                ui.contentBox.innerHTML = `
                    <div class="ds-answer-box">
                        <div class="ds-answer-main">📚 已自动记忆本页批改结果！</div>
                        <div class="ds-answer-sub">已锁定 <b>${learnedRight}</b> 道标准答案、记录 <b>${learnedWrong}</b> 道错题排除项。点击页面<b>“重做”</b>后再长按 🎯 即可秒拿满分！</div>
                    </div>
                `;
            }
        }
        return { learnedRight, learnedWrong };
    }

    setTimeout(harvestGradedPageAnswers, 1200);

    /********************************************************************
     * 6. 丝滑单容器滚屏引擎
     ********************************************************************/
    function startTurboSpinEffect() {
        const { fab, sweepBtn } = getUIElements();
        if (fab) {
            fab.classList.remove('ds-loading');
            fab.classList.add('ds-turbo-spin');
            fab.innerHTML = '⚡';
        }
        if (sweepBtn) {
            sweepBtn.innerText = '⏹️ 停止全卷连刷';
        }
    }

    function stopTurboSpinEffect() {
        const { fab, sweepBtn } = getUIElements();
        if (fab) {
            fab.classList.remove('ds-turbo-spin');
            fab.classList.remove('ds-loading');
            fab.innerHTML = '🎯';
        }
        if (sweepBtn) {
            sweepBtn.innerText = '🚀 联网全卷高准全选';
        }
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function findPrimaryScroller(el) {
        let node = el.parentElement;
        const win = el.ownerDocument.defaultView || window;
        while (node && node !== el.ownerDocument.body && node !== el.ownerDocument.documentElement) {
            const style = win.getComputedStyle(node);
            if (/(auto|scroll|overlay)/i.test(style.overflowY + style.overflow) && node.scrollHeight > node.clientHeight + 20) {
                return { type: 'element', scroller: node };
            }
            node = node.parentElement;
        }

        const ownDocScroll = el.ownerDocument.scrollingElement || el.ownerDocument.documentElement || el.ownerDocument.body;
        if (ownDocScroll && ownDocScroll.scrollHeight > win.innerHeight + 20) {
            return { type: 'window', scroller: win, docEl: ownDocScroll };
        }

        try {
            const topDocScroll = window.top.document.scrollingElement || window.top.document.documentElement;
            return { type: 'window', scroller: window.top, docEl: topDocScroll };
        } catch (_) {
            return { type: 'window', scroller: win, docEl: ownDocScroll };
        }
    }

    function smoothScrollToElementAsync(el, duration = 220) {
        return new Promise((resolve) => {
            if (!el) {
                resolve();
                return;
            }

            try {
                let totalTopOffset = 0;
                let currWin = el.ownerDocument.defaultView || window;
                const rect = el.getBoundingClientRect();
                totalTopOffset += rect.top + Math.min(rect.height / 2, 120);

                while (currWin && currWin !== window.top) {
                    try {
                        const frameEl = currWin.frameElement;
                        if (frameEl) {
                            totalTopOffset += frameEl.getBoundingClientRect().top;
                            currWin = currWin.parent;
                        } else {
                            break;
                        }
                    } catch (_) {
                        break;
                    }
                }

                const targetViewportY = window.top.innerHeight * 0.35;
                const deltaY = totalTopOffset - targetViewportY;
                if (Math.abs(deltaY) < 45) {
                    resolve();
                    return;
                }

                const primary = findPrimaryScroller(el);
                const startScrollTop = primary.type === 'element'
                    ? primary.scroller.scrollTop
                    : (primary.scroller.scrollY || primary.docEl?.scrollTop || 0);

                const startTime = performance.now();
                const animate = (now) => {
                    const progress = Math.min(1, (now - startTime) / duration);
                    const eased = -(Math.cos(Math.PI * progress) - 1) / 2;
                    const nextPos = startScrollTop + deltaY * eased;

                    if (primary.type === 'element') {
                        primary.scroller.scrollTop = nextPos;
                    } else {
                        primary.scroller.scrollTo(0, nextPos);
                    }

                    if (progress < 1) {
                        requestAnimationFrame(animate);
                    } else {
                        resolve();
                    }
                };
                requestAnimationFrame(animate);
            } catch (_) {
                try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (__) {}
                setTimeout(resolve, duration);
            }
        });
    }

    function clickOptionElementReliably(optionEl) {
        if (!optionEl) return;
        try {
            const ownerDoc = optionEl.ownerDocument || document;
            if (!ownerDoc.getElementById('ds-mainworld-bridge')) {
                const s = ownerDoc.createElement('script');
                s.id = 'ds-mainworld-bridge';
                s.textContent = document.getElementById('ds-mainworld-bridge')?.textContent || '';
                (ownerDoc.head || ownerDoc.documentElement).appendChild(s);
            }

            optionEl.setAttribute('data-ds-click-target', '1');
            (ownerDoc.defaultView || window).dispatchEvent(new CustomEvent('ds-mainworld-click'));

            const parentRow = optionEl.closest('.answerBg, .single_choice li, .multi_choice li, .true_false li, .answerList li, .ant-radio-wrapper, .ant-checkbox-wrapper, li') || optionEl;
            parentRow.classList.add('ds-correct-highlight', 'ds-auto-clicked-pulse');
            setTimeout(() => {
                parentRow.classList.remove('ds-auto-clicked-pulse');
            }, 900);
        } catch (err) {
            console.error('[DeepSeek Click]', err);
        }
    }

    /********************************************************************
     * 7. 精准题目与选项提取器
     ********************************************************************/
    const STRICT_QUESTION_BLOCK_SELECTORS = [
        '.TiMu', '.singleQuesId', '.questionLi',
        '.question-common-abs-reply', '.question-inputbox',
        '.question-item', '.question-box', '.question-card', '.exam-item',
        '.subject-item', '.q-item', '.ti-item', '.problem-item',
        '[class*="question-wrapper"]', '[class*="question-container"]', '[class*="exercise-item"]'
    ];

    const INPUT_SELECTORS = [
        'textarea', '[contenteditable="true"]', '[role="textbox"]', '.edui-body-container',
        'input[type="text"]', 'input:not([type])', 'input[type="search"]', 'input[type="number"]'
    ];

    function querySelectorAllDeep(selector, root = document) {
        const results = Array.from(root.querySelectorAll(selector));
        const allNodes = root.querySelectorAll('*');
        for (const node of allNodes) {
            if (node.shadowRoot) {
                results.push(...querySelectorAllDeep(selector, node.shadowRoot));
            }
        }
        const iframes = root.querySelectorAll('iframe');
        for (const ifr of iframes) {
            try {
                if (ifr.contentDocument) {
                    results.push(...querySelectorAllDeep(selector, ifr.contentDocument));
                }
            } catch (_) {}
        }
        return results;
    }

    function extractOptionsFromBlock(blockEl) {
        const priorityGroups = [
            '.answerBg',
            '.single_choice li, .multi_choice li, .true_false li, .answerList li',
            '.ant-radio-wrapper, .ant-checkbox-wrapper, .el-radio, .el-checkbox',
            '[class*="option-item"], [class*="optionItem"], [class*="choice-item"], .option, .question-option',
            'li[role="option"], div[role="radio"], div[role="checkbox"]'
        ];

        let rawOptions = [];
        for (const groupSel of priorityGroups) {
            const found = querySelectorAllDeep(groupSel, blockEl).filter(el => {
                const r = el.getBoundingClientRect();
                return r.width >= 12 && r.height >= 10 && r.height <= 280;
            });
            if (found.length >= 2) {
                rawOptions = found;
                break;
            }
        }

        if (rawOptions.length === 0) {
            const optionPrefixRegex = /^\s*([A-H]([.、．:：\s)]|$)|[（(][A-H][)）])/i;
            const nodes = querySelectorAllDeep('li, div, p, label', blockEl);
            for (const n of nodes) {
                if (n.children.length > 6) continue;
                const txt = (n.innerText || '').replace(/\s+/g, ' ').trim();
                if (txt.length >= 1 && txt.length <= 240 && optionPrefixRegex.test(txt)) {
                    rawOptions.push(n);
                }
            }
        }

        rawOptions = rawOptions.filter(el => !rawOptions.some(other => other !== el && el.contains(other)));

        const options = [];
        const seenTexts = new Set();

        for (let i = 0; i < rawOptions.length; i++) {
            const el = rawOptions[i];
            const rawText = (el.innerText || '').replace(/\s+/g, ' ').trim();
            if (!rawText || rawText.length > 300 || seenTexts.has(rawText)) continue;
            seenTexts.add(rawText);

            const badgeNode = el.querySelector('.num_option, .num_option_dx, [data]');
            const dataLetter = badgeNode?.getAttribute('data')?.trim() || '';
            const prefixMatch = rawText.match(/^\s*([A-H])(?=[.、．:：\s)]|$)/i);
            const letter = (
                (/^[A-H]$/i.test(dataLetter) ? dataLetter : '') ||
                (prefixMatch ? prefixMatch[1] : '') ||
                String.fromCharCode(65 + options.length)
            ).toUpperCase();

            const cleanContent = rawText.replace(/^\s*[（(]?[A-H][)）.、．:：\s]\s*/i, '').trim() || rawText;

            options.push({
                el,
                letter,
                text: rawText,
                cleanContent
            });
            if (options.length >= 10) break;
        }
        return options;
    }

    function extractInputsFromBlock(blockEl) {
        const rawInputs = querySelectorAllDeep(INPUT_SELECTORS.join(','), blockEl);
        return rawInputs.filter(el => {
            if (el.disabled || el.readOnly) return false;
            if (el.type === 'hidden' || el.type === 'radio' || el.type === 'checkbox') return false;
            const r = el.getBoundingClientRect();
            return r.width >= 16 && r.height >= 12;
        });
    }

    function extractPureQuestionStem(blockEl, optionsList = [], targetInput = null) {
        if (!blockEl) return '';

        const liveInputs = Array.from(blockEl.querySelectorAll ? blockEl.querySelectorAll('input, textarea, [contenteditable="true"]') : []);
        const cleanupInputs = [];
        liveInputs.forEach((inp) => {
            if (inp.type === 'hidden' || inp.type === 'radio' || inp.type === 'checkbox') return;
            const curVal = (inp.isContentEditable ? inp.innerText : inp.value || '').trim();
            const marker = (targetInput && inp === targetInput)
                ? ` [[👉此处为需要作答的空格👈]] `
                : (curVal ? ` [[空格(已填:"${curVal}")]] ` : ` ______ `);
            inp.setAttribute('data-ds-marker', marker);
            cleanupInputs.push(inp);
        });

        const cleanupOpts = [];
        optionsList.forEach(opt => {
            if (opt.el && blockEl.contains(opt.el) && opt.el !== blockEl) {
                opt.el.setAttribute('data-ds-opt-remove', '1');
                cleanupOpts.push(opt.el);
            }
        });

        const clone = blockEl.cloneNode(true);
        cleanupInputs.forEach(inp => inp.removeAttribute('data-ds-marker'));
        cleanupOpts.forEach(el => el.removeAttribute('data-ds-opt-remove'));

        clone.querySelectorAll('[data-ds-opt-remove="1"]').forEach(el => el.remove());
        clone.querySelectorAll('[data-ds-marker]').forEach(el => el.replaceWith(el.getAttribute('data-ds-marker')));
        clone.querySelectorAll('style, script, .ans-icon, .font-cxsecret-ignore, .marking_duigou, .marking_cuowu').forEach(el => el.remove());

        const pureStem = (clone.innerText || clone.textContent || '')
            .replace(/我的答案\s*[:：].*$/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        return pureStem.length >= 4 ? pureStem : (blockEl.innerText || '').replace(/\s+/g, ' ').trim();
    }

    function collectAllQuestionsOnPage() {
        let blocks = querySelectorAllDeep(STRICT_QUESTION_BLOCK_SELECTORS.join(','));

        let validBlocks = blocks.filter(el => {
            const r = el.getBoundingClientRect();
            if (r.width < 100 || r.height < 24) return false;
            const opts = extractOptionsFromBlock(el);
            const inps = extractInputsFromBlock(el);
            return opts.length >= 2 || inps.length >= 1;
        });

        validBlocks = validBlocks.filter(el => !validBlocks.some(other => other !== el && el.contains(other)));

        if (validBlocks.length === 0) {
            const allOpts = querySelectorAllDeep('.answerBg, .option, .ant-radio-wrapper, .el-radio');
            const discovered = new Set();
            for (const opt of allOpts) {
                let curr = opt.parentElement;
                let depth = 0;
                while (curr && curr !== document.body && depth < 7) {
                    const optsInCurr = extractOptionsFromBlock(curr);
                    const txtLen = (curr.innerText || '').trim().length;
                    if (optsInCurr.length >= 2 && optsInCurr.length <= 8 && txtLen > optsInCurr.reduce((s, o) => s + o.text.length, 0) + 6) {
                        discovered.add(curr);
                        break;
                    }
                    curr = curr.parentElement;
                    depth++;
                }
            }
            validBlocks = Array.from(discovered).filter(el => !Array.from(discovered).some(other => other !== el && el.contains(other)));
        }

        validBlocks.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);

        return validBlocks.map((blockEl, index) => {
            const options = extractOptionsFromBlock(blockEl);
            const inputs = extractInputsFromBlock(blockEl);
            const stemText = extractPureQuestionStem(blockEl, options, inputs[0] || null).slice(0, 1000);
            return {
                index,
                blockEl,
                options,
                inputs,
                stemText
            };
        });
    }

    /********************************************************************
     * 8. 实时联网搜题 RAG + 全卷前后互证 + CoT 推理引擎
     ********************************************************************/
    async function requestSingleQuestionCoTAnalysis(q, paperContextSummary = '', overrideModel = null) {
        STATE.verifiedBank = GM_getValue('DEEPSEEK_VERIFIED_BANK', STATE.verifiedBank || {});
        const stemKey = normalizeStemKey(q.stemText);
        const memoryEntry = STATE.verifiedBank[stemKey];

        // 1. 优先命中本地批改验证记忆库
        if (memoryEntry && Array.isArray(memoryEntry.correctLetters) && memoryEntry.correctLetters.length > 0) {
            return {
                thinking: '📚 命中已验证满分题库记忆，直接锁定标准答案',
                answerLetters: memoryEntry.correctLetters,
                answerTexts: []
            };
        }

        // 2. 实时联网检索该题干的原题题库与网页参考资料 (Bing + 百度并发)
        const webClues = await searchWebForQuestionClues(q.stemText, q.options);

        return new Promise((resolve) => {
            const useModel = overrideModel || STATE.model;
            const isMultiChoice = /多选|多项|more than one|multiple/i.test(q.stemText);
            const isTrueFalse = q.options.length === 2 && q.options.some(o => /对|错|正确|错误|true|false|√|×/i.test(o.text));
            const qTypeHint = isMultiChoice ? '【多选题（选2~4项）】' : (isTrueFalse ? '【判断题】' : (q.options.length > 0 ? '【单选题（必选唯一最佳项）】' : '【填空/主观题】'));

            const formattedOptions = q.options.length > 0
                ? q.options.map(o => `选项 ${o.letter}: ${o.cleanContent}`).join('\n')
                : '（本题为填空或主观题，无候选选项）';

            const wrongExclusionNote = (memoryEntry && Array.isArray(memoryEntry.wrongLetters) && memoryEntry.wrongLetters.length > 0)
                ? `\n⚠️【重要错题排除指令】：本题在上次提交时选择【${memoryEntry.wrongLetters.join(', ')}】被判为 0 分错误！本次严禁再选 ${memoryEntry.wrongLetters.join(', ')}，请务必从其余选项中推导正确答案！`
                : '';

            const systemPrompt = [
                '你是一个结合【实时联网题库检索结果】与【全卷前后互证】的满分级高校专业课与通用题库解析专家。',
                '请严格遵循以下三大解题准则：',
                '1.【优先参考联网搜题原题摘要】：若下方提供了【🌐 实时联网搜题检索到的原题与参考资料】，请仔细核对其中出现的原题答案或权威教材原文规定（例如：散装种子饼装船前至少有 2 个月氧化期；散装固体废物在 IMSBC 规则中属于 B 类；装运煤炭完货后平舱目的是 ①防止货物移动 和 ④防止形成积存气体的坑洼及空气渗入煤堆）。',
                '2.【善用同卷其它题目互证】：下方提供了【📄 同卷其它题目题干与选项互证摘要】，同一份试卷的不同题目往往直接泄露了答案！（例如：若同卷某题选项写有“即使存在短时横倾，也不应超过3°”，则另一题问“保证船舶横倾不超过多少度”必选 3°；若同卷某题提到“必须兼顾易流态化(A类)和化学危险性(B类)”，则问“IMSBC所列散货类别”必选“不一定仅属于一个类别”！）',
                '3.【集装箱与散货运输核心法则】：',
                '   - 6位箱位号 BBRRTT：前两位奇数排号(01,03,05...)为 20ft 箱且对应自首【第 (BB+1)/2 排】（03 是自首第 2 排）；中两位列号奇右偶左（08 是左舷第 4 列，05 是右舷第 3 列）；后两位 <80 为舱内，>=80 为甲板。',
                '   - 两个 1CC(20ft) 长度之和比一个 1AA(40ft) 【短】；端门第 3 行标明【总重和自重】；超高标记数字为【实际高度】；初配图是【总图加行箱位图】；同一卸港箱量少时应【集中配装】，箱量大时安排在【不同排位且间隔一定距离】，双岸桥同时作业至少【纵向间隔一个 40ft 行箱位】。',
                '必须严格返回如下 JSON 格式（不要包含任何 Markdown 代码块标签）：',
                '{',
                '  "thinking": "结合联网题库摘要、同卷互证与教材规定的推导过程",',
                '  "answerLetters": ["正确选项大写字母，如 \\"C\\""],',
                '  "answerTexts": ["正确选项完整原文内容"]',
                '}'
            ].join('\n');

            const userPrompt = [
                `题目类型：${qTypeHint}`,
                `当前题干：${q.stemText}`,
                `候选选项：\n${formattedOptions}`,
                webClues ? `【🌐 实时联网搜题检索到的原题与参考资料】：\n${webClues}` : '',
                paperContextSummary ? `【📄 同卷其它题目互证摘要（供跨题核对知识点）】：\n${paperContextSummary}` : '',
                wrongExclusionNote
            ].filter(Boolean).join('\n\n');

            const payload = {
                model: useModel,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ]
            };
            if (useModel === 'deepseek-chat') {
                payload.temperature = 0.0;
                payload.response_format = { type: 'json_object' };
            }

            GM_xmlhttpRequest({
                method: 'POST',
                url: CONFIG.apiUrl,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${STATE.apiKey}`
                },
                data: JSON.stringify(payload),
                onload: (res) => {
                    try {
                        if (res.status !== 200) {
                            if (useModel === 'deepseek-reasoner') {
                                requestSingleQuestionCoTAnalysis(q, paperContextSummary, 'deepseek-chat').then(resolve);
                                return;
                            }
                            resolve(null);
                            return;
                        }
                        const data = JSON.parse(res.responseText);
                        const msgObj = data.choices?.[0]?.message || {};
                        const rawContent = msgObj.content || '{}';
                        const reasoningText = msgObj.reasoning_content || '';
                        const cleaned = rawContent.replace(/```json|```/gi, '').trim();
                        const firstBrace = cleaned.indexOf('{');
                        const lastBrace = cleaned.lastIndexOf('}');
                        const parsed = JSON.parse(firstBrace !== -1 ? cleaned.slice(firstBrace, lastBrace + 1) : cleaned);
                        if (!parsed.thinking && reasoningText) {
                            parsed.thinking = reasoningText.replace(/\s+/g, ' ').trim().slice(-120);
                        }
                        parsed.usedWebSearch = Boolean(webClues);
                        resolve(parsed);
                    } catch (e) {
                        console.error('[DeepSeek Parse]', e);
                        resolve(null);
                    }
                },
                onerror: () => resolve(null)
            });
        });
    }

    function matchOptionsAccurately(qOptions, parsed) {
        if (!parsed || !qOptions || qOptions.length === 0) return [];

        const letters = Array.isArray(parsed.answerLetters)
            ? parsed.answerLetters.map(l => String(l).replace(/[^A-H]/gi, '').toUpperCase()).filter(Boolean)
            : (parsed.answerLetter ? [String(parsed.answerLetter).replace(/[^A-H]/gi, '').toUpperCase()] : []);

        const texts = Array.isArray(parsed.answerTexts)
            ? parsed.answerTexts.map(t => String(t).trim()).filter(Boolean)
            : (parsed.answer ? [String(parsed.answer).trim()] : []);

        const matched = [];
        const addUnique = (opt) => {
            if (opt && !matched.includes(opt)) matched.push(opt);
        };

        if (texts.length === 1 && letters.length <= 1) {
            const targetTxt = texts[0].replace(/^\s*[（(]?[A-H][)）.、．:：\s]\s*/i, '').trim();
            if (targetTxt.length >= 1) {
                const exactTextOpt = qOptions.find(o => o.cleanContent === targetTxt || o.text === targetTxt);
                if (exactTextOpt) {
                    addUnique(exactTextOpt);
                    return matched;
                }
            }
        }

        for (const letChar of letters) {
            const byLetter = qOptions.find(o => o.letter === letChar);
            if (byLetter) addUnique(byLetter);
        }

        if (matched.length === 0 && texts.length > 0) {
            for (const t of texts) {
                const cleanT = t.replace(/^\s*[（(]?[A-H][)）.、．:：\s]\s*/i, '').trim();
                const bySub = qOptions.find(o =>
                    (cleanT.length >= 1 && (o.cleanContent.includes(cleanT) || cleanT.includes(o.cleanContent))) ||
                    o.text.includes(t)
                );
                if (bySub) addUnique(bySub);
            }
        }

        return matched;
    }

    // 生成全卷其它题目的互证摘要（供跨题核对，如第13题的“横倾不超过3°”直接帮第29题锁定答案）
    function buildFullPaperCrossContext(allQuestions) {
        return allQuestions.map((q, i) => {
            const optsInline = q.options.map(o => `${o.letter}.${o.cleanContent}`).join(' ');
            return `T${i + 1}: ${q.stemText.slice(0, 90)} [${optsInline.slice(0, 90)}]`;
        }).join('\n').slice(0, 3200);
    }

    /********************************************************************
     * 9. 联网搜题 + 全卷互证 + 6 路并发丝滑全选流水线
     ********************************************************************/
    async function startFullPageAutoSweep() {
        harvestGradedPageAnswers();

        const ui = getUIElements();
        if (!STATE.apiKey) {
            const key = prompt('请输入您的 DeepSeek API Key (sk-...):', '');
            if (key) {
                STATE.apiKey = key.trim();
                GM_setValue('DEEPSEEK_API_KEY', STATE.apiKey);
            } else {
                return;
            }
        }

        if (STATE.isBatchRunning) return;

        const allQuestions = collectAllQuestionsOnPage();
        if (allQuestions.length === 0) {
            if (ui.card) ui.card.style.display = 'block';
            if (ui.contentBox) {
                ui.contentBox.innerHTML = `<div style="color:#f59e0b;">⚠️ 未在当前页面扫描到题目列表，请确认题目已加载完毕。</div>`;
            }
            return;
        }

        STATE.isBatchRunning = true;
        STATE.stopBatchRequested = false;
        startTurboSpinEffect();
        if (ui.card) ui.card.style.display = 'block';

        const total = allQuestions.length;
        let completedCount = 0;

        // 构建整张试卷的互证上下文（让每道题都能看到同卷其它题目的题干与选项线索）
        const paperContextSummary = buildFullPaperCrossContext(allQuestions);

        const resultPromises = new Array(total);
        let nextPrefetchIdx = 0;

        function triggerPrefetchUpTo(limitIdx) {
            const maxIdx = Math.min(total, limitIdx);
            while (nextPrefetchIdx < maxIdx && !STATE.stopBatchRequested) {
                const idx = nextPrefetchIdx++;
                resultPromises[idx] = requestSingleQuestionCoTAnalysis(allQuestions[idx], paperContextSummary);
            }
        }

        triggerPrefetchUpTo(CONFIG.concurrency);

        const updateSweepProgressUI = (curNum, titlePreview, answerPreview, thinkingNote, usedSearch) => {
            if (!ui.contentBox) return;
            const pct = Math.round((curNum / total) * 100);
            const searchBadge = usedSearch ? '🌐已联网搜题' : (STATE.webSearchEnabled ? '🌐联网检索中' : '🧠本地推理');
            ui.contentBox.innerHTML = `
                <div style="display:flex;justify-content:space-between;align-items:center;color:#10b981;font-weight:600;">
                    <span>⚡ 全卷高准连刷 (${curNum}/${total}) · ${searchBadge}</span>
                    <span style="font-size:11px;color:#94a3b8;">轻点 ⚡ 暂停</span>
                </div>
                <div class="ds-progress-bar-bg">
                    <div class="ds-progress-bar-fill" style="width:${pct}%;"></div>
                </div>
                <div class="ds-answer-box" style="margin-top:6px;margin-bottom:2px;">
                    <div style="font-size:11px;color:#94a3b8;">第 ${curNum} 题：${escapeHtml(titlePreview.slice(0, 26))}...</div>
                    <div class="ds-answer-main">${escapeHtml(answerPreview || '🌐 正在联网检索并推导...')}</div>
                    ${thinkingNote ? `<div class="ds-answer-sub">${escapeHtml(thinkingNote.slice(0, 95))}</div>` : ''}
                </div>
            `;
        };

        for (let i = 0; i < total; i++) {
            if (STATE.stopBatchRequested) break;

            triggerPrefetchUpTo(i + 1 + CONFIG.concurrency);

            const q = allQuestions[i];
            const curNum = i + 1;

            q.blockEl.classList.add('ds-scope-flash');
            updateSweepProgressUI(curNum, q.stemText, '🌐 正在联网比对题库与全卷互证...', '', false);

            const [parsed] = await Promise.all([
                resultPromises[i],
                smoothScrollToElementAsync(q.blockEl, 220)
            ]);

            if (STATE.stopBatchRequested) {
                q.blockEl.classList.remove('ds-scope-flash');
                break;
            }

            const matchedOpts = matchOptionsAccurately(q.options, parsed);
            const firstAnsText = Array.isArray(parsed?.answerTexts) ? parsed.answerTexts[0] : (parsed?.answer || '');

            if (matchedOpts.length > 0) {
                const ansDisplay = matchedOpts.map(o => `${o.letter}. ${o.cleanContent}`).join(' | ');
                updateSweepProgressUI(curNum, q.stemText, `✅ 已选：${ansDisplay}`, parsed?.thinking || '', parsed?.usedWebSearch);

                for (const opt of matchedOpts) {
                    clickOptionElementReliably(opt.el);
                    if (matchedOpts.length > 1) await sleep(140);
                }
                completedCount++;
            } else if (q.inputs.length > 0 && firstAnsText) {
                const inp = q.inputs[0];
                updateSweepProgressUI(curNum, q.stemText, `✍️ 已填：${firstAnsText}`, parsed?.thinking || '', parsed?.usedWebSearch);
                inp.focus();
                setNativeInputValue(inp, String(firstAnsText).trim());
                inp.classList.add('ds-correct-highlight');
                completedCount++;
            } else {
                updateSweepProgressUI(curNum, q.stemText, firstAnsText || '⚠️ 未匹配到选项', parsed?.thinking || '', parsed?.usedWebSearch);
            }

            setTimeout(() => q.blockEl.classList.remove('ds-scope-flash'), 400);
            await sleep(160);
        }

        STATE.isBatchRunning = false;
        stopTurboSpinEffect();

        if (ui.contentBox) {
            if (STATE.stopBatchRequested) {
                ui.contentBox.innerHTML = `
                    <div class="ds-answer-box" style="border-left-color:#f59e0b;">
                        <div class="ds-answer-main" style="color:#f59e0b;">⏸️ 全卷连刷已手动暂停</div>
                        <div class="ds-answer-sub">已完成 ${completedCount} / ${total} 题。长按或连点 3 下 🎯 可重新启动。</div>
                    </div>
                `;
            } else {
                ui.contentBox.innerHTML = `
                    <div class="ds-answer-box">
                        <div class="ds-answer-main">🎉 全卷 ${completedCount} / ${total} 题已全部选完！</div>
                        <div class="ds-answer-sub">已完成【🌐 实时联网搜题 + 全卷互证】点选，请检查后提交。</div>
                    </div>
                `;
            }
        }
    }

    /********************************************************************
     * 10. 单题解析功能（轻点 1 下悬浮球触发）
     ********************************************************************/
    function findSingleQuestionScope() {
        const ui = getUIElements();
        const hitUnderMouse = document.elementFromPoint(STATE.lastMousePos.x, STATE.lastMousePos.y);
        let curr = (STATE.lastPickedScope && STATE.lastPickedScope.ownerDocument?.body.contains(STATE.lastPickedScope))
            ? STATE.lastPickedScope
            : (hitUnderMouse || document.activeElement);

        if (curr && (curr === ui.fab || ui.fab?.contains(curr) || curr === ui.card || ui.card?.contains(curr))) {
            curr = null;
        }

        if (!curr || curr === document.body) {
            const allQ = collectAllQuestionsOnPage();
            const inView = allQ.find(q => {
                const r = q.blockEl.getBoundingClientRect();
                return r.bottom > 80 && r.top < window.innerHeight - 60;
            }) || allQ[0];
            if (inView) return inView.blockEl;
            return document.body;
        }

        let depth = 0;
        while (curr && curr !== document.body && depth < 12) {
            const isMatched = STRICT_QUESTION_BLOCK_SELECTORS.some(sel => {
                try { return curr.matches && curr.matches(sel); } catch (_) { return false; }
            });
            const opts = extractOptionsFromBlock(curr);
            const inps = extractInputsFromBlock(curr);
            if (isMatched || (opts.length >= 2 && opts.length <= 8) || (inps.length === 1 && (curr.innerText || '').length >= 6)) {
                return curr;
            }
            curr = curr.parentElement;
            depth++;
        }
        return document.body;
    }

    function triggerSingleQuestionAnalysis() {
        const harvested = harvestGradedPageAnswers();
        if (harvested.learnedRight > 0 || harvested.learnedWrong > 0) {
            return;
        }

        const ui = getUIElements();
        if (!STATE.apiKey) {
            const key = prompt('请输入您的 DeepSeek API Key (sk-...):', '');
            if (key) {
                STATE.apiKey = key.trim();
                GM_setValue('DEEPSEEK_API_KEY', STATE.apiKey);
            } else {
                return;
            }
        }

        if (STATE.isAnalyzing || STATE.isBatchRunning) return;

        const scopeEl = findSingleQuestionScope();
        if (scopeEl && scopeEl !== document.body) {
            scopeEl.classList.add('ds-scope-flash');
            setTimeout(() => scopeEl.classList.remove('ds-scope-flash'), 700);
        }

        const options = extractOptionsFromBlock(scopeEl);
        const inputs = extractInputsFromBlock(scopeEl);
        const stemText = extractPureQuestionStem(scopeEl, options, inputs[0] || null).slice(0, 1200);
        const allQuestions = collectAllQuestionsOnPage();
        const paperContextSummary = buildFullPaperCrossContext(allQuestions);

        if (ui.card) ui.card.style.display = 'block';
        if (ui.contentBox) {
            ui.contentBox.innerHTML = `
                <div style="display:flex;align-items:center;gap:8px;color:#38bdf8;">
                    <span>🌐</span>
                    <span>正在实时联网搜题并结合全卷互证解析...</span>
                </div>
                <div style="font-size:11px;color:#64748b;margin-top:4px;">题目：${escapeHtml(stemText.slice(0, 36))}...</div>
            `;
        }
        if (ui.fab) ui.fab.classList.add('ds-loading');
        STATE.isAnalyzing = true;

        requestSingleQuestionCoTAnalysis({ stemText, options, inputs }, paperContextSummary).then((parsed) => {
            STATE.isAnalyzing = false;
            if (ui.fab) ui.fab.classList.remove('ds-loading');

            if (!parsed) {
                if (ui.contentBox) ui.contentBox.innerHTML = `<div style="color:#ef4444;">❌ 解析失败，请检查 API Key 或网络</div>`;
                return;
            }

            const matchedOpts = matchOptionsAccurately(options, parsed);
            matchedOpts.forEach(opt => opt.el.classList.add('ds-correct-highlight'));

            const firstAnsText = Array.isArray(parsed.answerTexts) ? parsed.answerTexts.join(' | ') : (parsed.answer || '');
            const ansDisplay = matchedOpts.length > 0
                ? matchedOpts.map(o => `${o.letter}. ${o.cleanContent}`).join(' | ')
                : (firstAnsText || '已解析');

            if (ui.contentBox) {
                ui.contentBox.innerHTML = `
                    <div class="ds-answer-box">
                        <div style="font-size:11px;color:#94a3b8;margin-bottom:2px;">${parsed.usedWebSearch ? '🌐 联网搜题+全卷互证结果' : '🧠 推导结果'}（长按或三击 🎯 全卷自动选完）</div>
                        <div class="ds-answer-main">${escapeHtml(ansDisplay)}</div>
                        ${parsed.thinking ? `<div class="ds-answer-sub">${escapeHtml(parsed.thinking)}</div>` : ''}
                    </div>
                `;
            }
        });
    }

    window.addEventListener('keydown', (e) => {
        const isShortcutMod = e.altKey || (IS_MAC && e.ctrlKey && !e.metaKey);
        if (isShortcutMod && e.code === 'KeyQ') {
            e.preventDefault();
            triggerSingleQuestionAnalysis();
        } else if (isShortcutMod && e.code === 'KeyW') {
            e.preventDefault();
            if (STATE.isBatchRunning) STATE.stopBatchRequested = true;
            else startFullPageAutoSweep();
        }
    });

    function setNativeInputValue(el, val) {
        if (!el) return;
        el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: val, bubbles: true }));
        if (el.isContentEditable) {
            el.innerText = val;
        } else {
            const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) setter.call(el, val);
            else el.value = val;
        }
        el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: val, bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function escapeHtml(str) {
        return String(str).replace(/[&<>"']/g, (m) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[m]));
    }
})();
