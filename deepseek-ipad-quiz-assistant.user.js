// ==UserScript==
// @name    DeepSeek 智能题库助手 (iPad 学习通/U校园/全平台触屏通用版)
// @namespace    https://tampermonkey.net/
// @version      3.2.0
// @updateURL    https://raw.githubusercontent.com/lihua0100-arch/deepseek-ipad-quiz-assistant/main/deepseek-ipad-quiz-assistant.user.js
// @downloadURL  https://raw.githubusercontent.com/lihua0100-arch/deepseek-ipad-quiz-assistant/main/deepseek-ipad-quiz-assistant.user.js
// @description  专为 iPad Safari 与 Mac 打造（全面适配学习通 mooc1.chaoxing.com、U校园、超星尔雅）：默认启用 DeepSeek-R1 (deepseek-reasoner) 满血深度推理模型并搭配 6 路并发预取流水线，内置专业计算与高频概念防坑校验规则（彻底解决箱位号奇偶排换算、1CC/1AA箱长对比、超高标记、岸桥间隔等教材陷阱题），支持长按或三击从头到尾丝滑滚屏高准全选！
// @author       Gemini
// @match        *://*/*
// @allFrames    true
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      api.deepseek.com
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    if (window.self !== window.top && (window.innerWidth < 120 || window.innerHeight < 80)) {
        return;
    }

    const IS_MAC = /Mac|iPod|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

    /********************************************************************
     * 1. 配置参数与全局状态 (默认启用 R1 深度推理模型以保障最高准确率)
     ********************************************************************/
    const CONFIG = {
        apiUrl: 'https://api.deepseek.com/chat/completions',
        longPressDuration: 450,   // 长按触发全卷自动连刷的毫秒阈值
        concurrency: 6            // 6 路并发预取流水线：让 R1 深度推理也能丝滑零等待连刷
    };

    const STATE = {
        apiKey: GM_getValue('DEEPSEEK_API_KEY', ''),
        // 默认优先使用 deepseek-reasoner (R1 深度思考模型)，彻底解决专业课陷阱题与计算题误判
        model: GM_getValue('DEEPSEEK_MODEL_V32', 'deepseek-reasoner'),
        isAnalyzing: false,
        isBatchRunning: false,
        stopBatchRequested: false,
        lastPickedScope: null,
        lastMousePos: { x: window.innerWidth / 2, y: window.innerHeight / 2 }
    };

    /********************************************************************
     * 2. 页面主环境点击桥接器 (Main-World Click Bridge)
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
     * 3. UI 样式：GPU 硬件加速涡轮旋转与高对比进度卡片
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
            width: 348px;
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
            padding: 5px 9px;
            font-size: 12px;
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
                fillBtn: topDoc.getElementById('ds-btn-autofill'),
                modelBtn: topDoc.getElementById('ds-btn-switch-model')
            };
        } catch (_) {
            return {
                fab: fabEl,
                card: cardEl,
                contentBox: document.getElementById('ds-card-content'),
                footerBox: document.getElementById('ds-card-footer'),
                sweepBtn: document.getElementById('ds-btn-autosweep'),
                fillBtn: document.getElementById('ds-btn-autofill'),
                modelBtn: document.getElementById('ds-btn-switch-model')
            };
        }
    }

    if (isTopFrame) {
        fabEl = document.createElement('div');
        fabEl.id = 'ds-fab';
        fabEl.innerHTML = '🎯';
        fabEl.title = '单击：解析单题 | 长按 或 连点3下：R1满血深度推理 + 6路并发全卷高准全选！';
        document.body.appendChild(fabEl);

        cardEl = document.createElement('div');
        cardEl.id = 'ds-card';
        cardEl.innerHTML = `
            <div class="ds-card-header">
                <span class="ds-card-title">💡 DeepSeek 题库助手 3.2 (R1满血版)</span>
                <span class="ds-card-close" id="ds-card-close-btn">✕</span>
            </div>
            <div id="ds-card-content">
                <div style="color:#94a3b8;font-size:12px;">
                    • <b>轻点 1 下 🎯</b>：R1 深度解析当前单题<br>
                    • <b>长按 🎯 或 连点 3 下 🎯</b>：启动<b>R1 深度思考 + 6 路并发预取</b>，从头到尾丝滑滚屏并高准确率选上所有答案！
                </div>
            </div>
            <div class="ds-card-actions" id="ds-card-footer" style="margin-top:6px;display:flex;">
                <button class="ds-btn ds-btn-fill" id="ds-btn-autosweep">🚀 R1全卷高准全选</button>
                <button class="ds-btn" id="ds-btn-autofill" style="display:none;">⚡ 点选当前题</button>
                <button class="ds-btn" id="ds-btn-switch-model">${STATE.model === 'deepseek-reasoner' ? '🧠 当前:R1深度思考' : '⚡ 当前:V3标准'}</button>
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

        document.getElementById('ds-btn-switch-model').addEventListener('click', (e) => {
            STATE.model = STATE.model === 'deepseek-chat' ? 'deepseek-reasoner' : 'deepseek-chat';
            GM_setValue('DEEPSEEK_MODEL_V32', STATE.model);
            e.currentTarget.innerText = STATE.model === 'deepseek-reasoner' ? '🧠 当前:R1深度思考' : '⚡ 当前:V3标准';
        });

        fabEl.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
        });

        /****************************************************************
         * 4. 悬浮球手势引擎：单击 / 长按 / 三连击 / 拖拽
         ****************************************************************/
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
     * 5. 丝滑单容器滚屏引擎
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
            sweepBtn.innerText = '🚀 R1全卷高准全选';
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

    function smoothScrollToElementAsync(el, duration = 260) {
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
     * 6. 精准题目与选项提取器
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
        clone.querySelectorAll('style, script, .ans-icon, .font-cxsecret-ignore').forEach(el => el.remove());

        const pureStem = (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim();
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
     * 7. R1 深度推理 + 专业教材防坑知识库引擎
     ********************************************************************/
    function requestSingleQuestionCoTAnalysis(q, overrideModel = null) {
        return new Promise((resolve) => {
            const useModel = overrideModel || STATE.model;
            const isMultiChoice = /多选|多项|more than one|multiple/i.test(q.stemText);
            const isTrueFalse = q.options.length === 2 && q.options.some(o => /对|错|正确|错误|true|false|√|×/i.test(o.text));
            const qTypeHint = isMultiChoice ? '【多选题（选2~4项）】' : (isTrueFalse ? '【判断题】' : (q.options.length > 0 ? '【单选题（必选唯一最佳项）】' : '【填空/主观题】'));

            const formattedOptions = q.options.length > 0
                ? q.options.map(o => `选项 ${o.letter}: ${o.cleanContent}`).join('\n')
                : '（本题为填空或主观题，无候选选项）';

            // 内置专业课高频易错考点与防坑准则（专门解决《船舶货运/集装箱运输》等教材标准定义陷阱）
            const systemPrompt = [
                '你是一个满分级别的高校专业课与四六级权威题库解析专家。',
                '请严格遵循中国高校教材标准定义与以下高频防坑铁律进行推理：',
                '1.【集装箱6位箱位号 BBRRTT 换算铁律】：',
                '   - 前两位 BB 为行/排号(Bay)：奇数(01,03,05,07...)代表 20ft 箱位，且对应自船首向船尾的【第 (BB+1)/2 排】（例如 03 是自首第 2 排，11 是自首第 6 排，绝不可直接把 03 当作第 3 排！）；偶数(02,04,06,08...)代表 40ft 箱位，对应第 BB/2 个 40ft 排（同时占据 BB-1 和 BB+1 两个 20ft 排，如 04 对应 03 和 05）。',
                '   - 中间两位 RR 为列号(Row)：以船纵中剖面为准，奇数(01,03,05...)在【右舷(右侧)】，右舷列序=(RR+1)/2（如 05 为右舷第 3 列，03 为右舷第 2 列）；偶数(02,04,06,08...)在【左舷(左侧)】，左舷列序=RR/2（如 08 为左舷第 4 列！）。',
                '   - 后两位 TT 为层号(Tier)：02~78 的偶数在【舱内】，自舱底往上第 TT/2 层（如 02 为舱内底始第 1 层，04 为舱内第 2 层）；82,84,86... 在【甲板】（82 为甲板第 1 层，84 下方一层为 82）。',
                '2.【集装箱标志与尺寸防坑】：',
                '   - 集装箱端门标志：第1行是箱主代号+设备识别码(U/J/Z)+顺序号+核对数字；第2行是国籍代号+尺寸和类型代码；【第3行是集装箱最大总重(MAX GROSS)和自重(TARE)】！',
                '   - 两个 1CC 型(20ft，实长 6058mm = 19ft 10.5in)长度之和(12116mm)比一个 1AA 型(40ft，实长 12192mm)要【短】（留有 3 英寸/76mm 间隙）！',
                '   - 集装箱超高标记中的数字表示【集装箱的实际高度】（如 2.9m / 9\'6"），而非超出尺寸！',
                '3.【集装箱配积载与系固防坑】：',
                '   - 配积载文件中，【初配图是总图加行箱位图】；',
                '   - 多装货港且第一装货港箱量大时，为加速装卸缩短停泊时间，应安排在【①不同的排位(Bay)上且间隔一定距离】（同排的不同列/不同层无法同时让多台岸桥作业）；两台装卸桥同时作业不允许紧靠，必须【至少纵向间隔一个 40 英尺行箱位】；',
                '   - 集装箱船专用的绑扎系固设备包括：【①桥锁、②扭锁、④连接板、⑤锥板、⑥高度补偿器】（不含③普通钢丝绳）。',
                '必须严格返回如下 JSON 格式（不要包含任何 Markdown 代码块标签）：',
                '{',
                '  "thinking": "简明推导计算步骤与教材依据",',
                '  "answerLetters": ["正确选项大写字母，如 \\"D\\""],',
                '  "answerTexts": ["正确选项完整原文内容"]',
                '}'
            ].join('\n');

            const userPrompt = [
                `题目类型：${qTypeHint}`,
                `题干内容：${q.stemText}`,
                `候选选项：\n${formattedOptions}`
            ].join('\n\n');

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
                            // 若 R1 接口不可用，自动降级用 V3 重试一次
                            if (useModel === 'deepseek-reasoner') {
                                requestSingleQuestionCoTAnalysis(q, 'deepseek-chat').then(resolve);
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
                        resolve(parsed);
                    } catch (e) {
                        console.error('[DeepSeek Parse]', e);
                        if (useModel === 'deepseek-reasoner') {
                            requestSingleQuestionCoTAnalysis(q, 'deepseek-chat').then(resolve);
                            return;
                        }
                        resolve(null);
                    }
                },
                onerror: () => {
                    if (useModel === 'deepseek-reasoner') {
                        requestSingleQuestionCoTAnalysis(q, 'deepseek-chat').then(resolve);
                        return;
                    }
                    resolve(null);
                }
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

    /********************************************************************
     * 8. 6 路并发预取流水线 + 全卷自动滚屏全选
     ********************************************************************/
    async function startFullPageAutoSweep() {
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

        const resultPromises = new Array(total);
        let nextPrefetchIdx = 0;

        function triggerPrefetchUpTo(limitIdx) {
            const maxIdx = Math.min(total, limitIdx);
            while (nextPrefetchIdx < maxIdx && !STATE.stopBatchRequested) {
                const idx = nextPrefetchIdx++;
                resultPromises[idx] = requestSingleQuestionCoTAnalysis(allQuestions[idx]);
            }
        }

        // 立即启动前 6 道题的并发 R1 深度推理
        triggerPrefetchUpTo(CONFIG.concurrency);

        const updateSweepProgressUI = (curNum, titlePreview, answerPreview, thinkingNote) => {
            if (!ui.contentBox) return;
            const pct = Math.round((curNum / total) * 100);
            const modelTag = STATE.model === 'deepseek-reasoner' ? 'R1深度思考' : 'V3';
            ui.contentBox.innerHTML = `
                <div style="display:flex;justify-content:space-between;align-items:center;color:#10b981;font-weight:600;">
                    <span>⚡ ${modelTag}全卷连刷 (${curNum}/${total})</span>
                    <span style="font-size:11px;color:#94a3b8;">轻点 ⚡ 暂停</span>
                </div>
                <div class="ds-progress-bar-bg">
                    <div class="ds-progress-bar-fill" style="width:${pct}%;"></div>
                </div>
                <div class="ds-answer-box" style="margin-top:6px;margin-bottom:2px;">
                    <div style="font-size:11px;color:#94a3b8;">第 ${curNum} 题：${escapeHtml(titlePreview.slice(0, 26))}...</div>
                    <div class="ds-answer-main">${escapeHtml(answerPreview || '🧠 正在深度推导...')}</div>
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
            updateSweepProgressUI(curNum, q.stemText, '🧠 R1 正在深度推导答案...', '');

            const [parsed] = await Promise.all([
                resultPromises[i],
                smoothScrollToElementAsync(q.blockEl, 250)
            ]);

            if (STATE.stopBatchRequested) {
                q.blockEl.classList.remove('ds-scope-flash');
                break;
            }

            const matchedOpts = matchOptionsAccurately(q.options, parsed);
            const firstAnsText = Array.isArray(parsed?.answerTexts) ? parsed.answerTexts[0] : (parsed?.answer || '');

            if (matchedOpts.length > 0) {
                const ansDisplay = matchedOpts.map(o => `${o.letter}. ${o.cleanContent}`).join(' | ');
                updateSweepProgressUI(curNum, q.stemText, `✅ 已选：${ansDisplay}`, parsed?.thinking || '');

                for (const opt of matchedOpts) {
                    clickOptionElementReliably(opt.el);
                    if (matchedOpts.length > 1) await sleep(140);
                }
                completedCount++;
            } else if (q.inputs.length > 0 && firstAnsText) {
                const inp = q.inputs[0];
                updateSweepProgressUI(curNum, q.stemText, `✍️ 已填：${firstAnsText}`, parsed?.thinking || '');
                inp.focus();
                setNativeInputValue(inp, String(firstAnsText).trim());
                inp.classList.add('ds-correct-highlight');
                completedCount++;
            } else {
                updateSweepProgressUI(curNum, q.stemText, firstAnsText || '⚠️ 未匹配到选项', parsed?.thinking || '');
            }

            setTimeout(() => q.blockEl.classList.remove('ds-scope-flash'), 450);
            await sleep(200);
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
                        <div class="ds-answer-sub">已使用 ${STATE.model === 'deepseek-reasoner' ? 'R1 满血深度推理' : 'V3'} 完成全部题目，请检查后提交。</div>
                    </div>
                `;
            }
        }
    }

    /********************************************************************
     * 9. 原有单题解析功能（轻点 1 下悬浮球触发）
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

        if (ui.card) ui.card.style.display = 'block';
        if (ui.contentBox) {
            ui.contentBox.innerHTML = `
                <div style="display:flex;align-items:center;gap:8px;color:#38bdf8;">
                    <span>⏳</span>
                    <span>正在使用 <b>${STATE.model === 'deepseek-reasoner' ? 'R1深度推理' : 'V3'}</b> 分析当前单题...</span>
                </div>
                <div style="font-size:11px;color:#64748b;margin-top:4px;">题目：${escapeHtml(stemText.slice(0, 36))}...</div>
            `;
        }
        if (ui.fab) ui.fab.classList.add('ds-loading');
        STATE.isAnalyzing = true;

        requestSingleQuestionCoTAnalysis({ stemText, options, inputs }).then((parsed) => {
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
                        <div style="font-size:11px;color:#94a3b8;margin-bottom:2px;">单题推导结果（长按或连点3下 🎯 全卷自动选完）</div>
                        <div class="ds-answer-main">${escapeHtml(ansDisplay)}</div>
                        ${parsed.thinking ? `<div class="ds-answer-sub">${escapeHtml(parsed.thinking)}</div>` : ''}
                    </div>
                `;
            }

            if (ui.fillBtn) {
                ui.fillBtn.style.display = (matchedOpts.length > 0 || inputs.length > 0) ? 'inline-flex' : 'none';
                ui.fillBtn.onclick = async () => {
                    for (const opt of matchedOpts) {
                        await smoothScrollToElementAsync(opt.el, 220);
                        clickOptionElementReliably(opt.el);
                    }
                    if (matchedOpts.length === 0 && inputs[0] && firstAnsText) {
                        inputs[0].focus();
                        setNativeInputValue(inputs[0], firstAnsText);
                    }
                };
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
