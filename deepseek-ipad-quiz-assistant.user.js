// ==UserScript==
// @name    DeepSeek 智能题库助手 (iPad 学习通/U校园/全平台触屏通用版)
// @namespace    https://tampermonkey.net/
// @version      3.1.0
// @updateURL    https://raw.githubusercontent.com/lihua0100-arch/deepseek-ipad-quiz-assistant/main/deepseek-ipad-quiz-assistant.user.js
// @downloadURL  https://raw.githubusercontent.com/lihua0100-arch/deepseek-ipad-quiz-assistant/main/deepseek-ipad-quiz-assistant.user.js
// @description  专为 iPad Safari 与 Mac 打造（全面适配学习通 mooc1.chaoxing.com、U校园、超星尔雅）：1.采用“单题独立并发预取 + 强制先写推导过程(thinking)再输出答案字母(A/B/C/D)与文本双重校验”大幅提升专业题与计算题准确率，根除0/1下标错位；2.采用滑动窗口预取流水线与单次精准滚屏，消除每批次停顿与双重滚动卡顿。
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
     * 1. 配置参数与全局状态
     ********************************************************************/
    const CONFIG = {
        apiUrl: 'https://api.deepseek.com/chat/completions',
        longPressDuration: 450,   // 长按触发全卷自动连刷的毫秒阈值
        concurrency: 3            // 后台滑动窗口并发预取线程数（既保证每题独立深度思考，又让滚屏零等待）
    };

    const STATE = {
        apiKey: GM_getValue('DEEPSEEK_API_KEY', ''),
        model: GM_getValue('DEEPSEEK_MODEL', 'deepseek-chat'),
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

        /* GPU 硬件加速涡轮旋转 */
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
            width: 345px;
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
        fabEl.title = '单击：解析单题 | 长按 或 连点3下：高准确率从头到尾丝滑滚屏全选！';
        document.body.appendChild(fabEl);

        cardEl = document.createElement('div');
        cardEl.id = 'ds-card';
        cardEl.innerHTML = `
            <div class="ds-card-header">
                <span class="ds-card-title">💡 DeepSeek 题库助手 3.1 (高准版)</span>
                <span class="ds-card-close" id="ds-card-close-btn">✕</span>
            </div>
            <div id="ds-card-content">
                <div style="color:#94a3b8;font-size:12px;">
                    • <b>轻点 1 下 🎯</b>：深度解析当前单题<br>
                    • <b>长按 🎯 或 连点 3 下 🎯</b>：启动<b>单题独立CoT推理 + 3路流水线预取</b>，从头到尾丝滑滚屏并高准确率选上所有答案！
                </div>
            </div>
            <div class="ds-card-actions" id="ds-card-footer" style="margin-top:6px;display:flex;">
                <button class="ds-btn ds-btn-fill" id="ds-btn-autosweep">🚀 全卷从头到尾高准全选</button>
                <button class="ds-btn" id="ds-btn-autofill" style="display:none;">⚡ 点选当前题</button>
                <button class="ds-btn" id="ds-btn-switch-model">${STATE.model === 'deepseek-reasoner' ? '🧠 当前R1(最高准)' : '⚡ 当前V3(带推理)'}</button>
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
            GM_setValue('DEEPSEEK_MODEL', STATE.model);
            e.currentTarget.innerText = STATE.model === 'deepseek-reasoner' ? '🧠 当前R1(最高准)' : '⚡ 当前V3(带推理)';
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
     * 5. 丝滑单容器滚屏引擎（解决旧版多重滚动冲突导致的微卡顿）
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
            sweepBtn.innerText = '🚀 全卷从头到尾高准全选';
        }
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // 寻找真正控制当前元素滚动的【唯一主滚动容器】，避免同时写多个父容器造成画面抖动卡顿
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

    // 单次丝滑滚屏动画：采用 easeInOutSine 曲线，只驱动唯一主滚动容器
    function smoothScrollToElementAsync(el, duration = 280) {
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

                // 将目标放在屏幕黄金位置 35% 处，如果已经在舒适区内（误差 < 45px）则无需滚动，直接跳过节省时间！
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
                    // easeInOutSine 极其平顺的丝滑曲线
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
     * 6. 精准题目与选项提取器（彻底修复学习通/U校园选项字母与题干分离，杜绝下标错位）
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

    // 精细提取题块内的每个选项，并为每个选项绑定明确的 A/B/C/D 字母与纯净内容
    function extractOptionsFromBlock(blockEl) {
        // 1. 优先匹配学习通专属选项行 (.answerBg) 或标准单/多选组件，避免宽泛的 label 抓到无关元素导致下标错乱！
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

        // 启发式兜底：扫描以 A/B/C/D 开头的并列选项节点
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

        // 过滤掉父级包裹容器，确保只留最准确的选项行
        rawOptions = rawOptions.filter(el => !rawOptions.some(other => other !== el && el.contains(other)));

        const options = [];
        const seenTexts = new Set();

        for (let i = 0; i < rawOptions.length; i++) {
            const el = rawOptions[i];
            const rawText = (el.innerText || '').replace(/\s+/g, ' ').trim();
            if (!rawText || rawText.length > 300 || seenTexts.has(rawText)) continue;
            seenTexts.add(rawText);

            // 提取选项自带的字母 (如学习通的 <span class="num_option" data="C">C</span>)，否则按顺序赋予 A, B, C, D
            const badgeNode = el.querySelector('.num_option, .num_option_dx, [data]');
            const dataLetter = badgeNode?.getAttribute('data')?.trim() || '';
            const prefixMatch = rawText.match(/^\s*([A-H])(?=[.、．:：\s)]|$)/i);
            const letter = (
                (/^[A-H]$/i.test(dataLetter) ? dataLetter : '') ||
                (prefixMatch ? prefixMatch[1] : '') ||
                String.fromCharCode(65 + options.length)
            ).toUpperCase();

            // 剥离选项开头的重复字母（如 "C 常规集装箱" -> 纯文本 "常规集装箱"），方便精准比对
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

    // 提取纯净题干：克隆题块并移除底部的选项列表节点，防止题干与选项混杂干扰模型推理
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

        // 标记选项节点以便在克隆体中剥离，得到 100% 纯净的题目题干
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
     * 7. 高准确率单题独立 CoT 推理引擎（强制先写推导过程，再用字母+文本双重校验）
     * 说明：
     * - 为什么之前批量 4 题准确率低？因为大模型是按从左到右顺序生成 Token 的，
     *   旧版要求模型第一个字段就输出 bestIndices，模型还没开始算就被迫盲猜了一个数字；
     *   而且数字下标 [0,1,2,3] 极易与第 1,2,3,4 个选项发生“加一错位（选C却点到了D）”。
     * - 3.1 版改为：每道题独立请求，且 JSON 第一个字段强制为 "thinking"（先一步步推导计算），
     *   推导完毕后再输出显式选项字母 "answerLetters": ["C"] 与选项原文 "answerTexts"！
     ********************************************************************/
    function requestSingleQuestionCoTAnalysis(q) {
        return new Promise((resolve) => {
            const isMultiChoice = /多选|多项|more than one|multiple/i.test(q.stemText);
            const isTrueFalse = q.options.length === 2 && q.options.some(o => /对|错|正确|错误|true|false|√|×/i.test(o.text));
            const qTypeHint = isMultiChoice ? '【多选题（可能有2~4个正确项）】' : (isTrueFalse ? '【判断题】' : (q.options.length > 0 ? '【单选题】' : '【填空/主观题】'));

            const formattedOptions = q.options.length > 0
                ? q.options.map(o => `选项 ${o.letter}: ${o.cleanContent}`).join('\n')
                : '（本题为填空或主观题，无候选选项）';

            const systemPrompt = [
                '你是一个极高准确率的学科考试与专业题库解析专家（精通航运集装箱配积载、大学英语四六级、理工科计算与通识课）。',
                '为了保证 100% 的答题准确率，你必须严格按照以下顺序输出 JSON（绝不要输出任何 Markdown 代码块标签）：',
                '{',
                '  "thinking": "第一步：审题提取核心概念、规则或计算公式（若是箱位号/数理计算题，必须在此逐步写出计算过程，例如040684表示40ft第04贝06列84层，装2个20ft则对应03和05奇数贝，在84层下面一层则是82层，故为030682/050682）；第二步：逐一比对各个选项，排除干扰项，确定最终正确选项字母。",',
                '  "answerLetters": ["最终确定的正确选项大写字母，单选题如 \\"C\\"，多选题如 [\\"A\\", \\"C\\"]"],',
                '  "answerTexts": ["最终确定的正确选项完整原文内容（若是填空题则写应填入的准确答案）"]',
                '}'
            ].join('\n');

            const userPrompt = [
                `题目类型：${qTypeHint}`,
                `题干内容：${q.stemText}`,
                `候选选项：\n${formattedOptions}`
            ].join('\n\n');

            const payload = {
                model: STATE.model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ]
            };
            if (STATE.model === 'deepseek-chat') {
                payload.temperature = 0.0; // 零温度，确保最严谨的确定性逻辑推理
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
                            resolve(null);
                            return;
                        }
                        const data = JSON.parse(res.responseText);
                        const rawContent = data.choices?.[0]?.message?.content || '{}';
                        const cleaned = rawContent.replace(/```json|```/gi, '').trim();
                        const firstBrace = cleaned.indexOf('{');
                        const lastBrace = cleaned.lastIndexOf('}');
                        const parsed = JSON.parse(firstBrace !== -1 ? cleaned.slice(firstBrace, lastBrace + 1) : cleaned);
                        resolve(parsed);
                    } catch (e) {
                        console.error('[DeepSeek CoT Parse]', e);
                        resolve(null);
                    }
                },
                onerror: () => resolve(null)
            });
        });
    }

    // 根据模型返回的 answerTexts 与 answerLetters 双重校验，精准匹配出对应的选项 DOM 节点（彻底杜绝 0/1 错位）
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

        // 1. 若是单选题（letters.length <= 1 且 texts.length <= 1）：
        // 优先检查 answerTexts 是否与某个选项的 cleanContent 精确吻合（防止字母写错），若吻合则直接锁定该项！
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

        // 2. 按显式选项字母 A / B / C / D 精准匹配
        for (const letChar of letters) {
            const byLetter = qOptions.find(o => o.letter === letChar);
            if (byLetter) addUnique(byLetter);
        }

        // 3. 若字母未命中，使用文本包含匹配兜底
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
     * 8. 滑动窗口预取流水线 + 丝滑全卷自动滚屏全选
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

        // 建立滑动窗口异步预取池：保持最多 CONFIG.concurrency (3) 道题在后台提前并发推理！
        const resultPromises = new Array(total);
        let nextPrefetchIdx = 0;

        function triggerPrefetchUpTo(limitIdx) {
            const maxIdx = Math.min(total, limitIdx);
            while (nextPrefetchIdx < maxIdx && !STATE.stopBatchRequested) {
                const idx = nextPrefetchIdx++;
                resultPromises[idx] = requestSingleQuestionCoTAnalysis(allQuestions[idx]);
            }
        }

        // 立即启动前 3 道题的并发推理
        triggerPrefetchUpTo(CONFIG.concurrency);

        const updateSweepProgressUI = (curNum, titlePreview, answerPreview, thinkingNote) => {
            if (!ui.contentBox) return;
            const pct = Math.round((curNum / total) * 100);
            ui.contentBox.innerHTML = `
                <div style="display:flex;justify-content:space-between;align-items:center;color:#10b981;font-weight:600;">
                    <span>⚡ 高准全卷连刷 (${curNum}/${total})</span>
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

        // 主循环：从第 1 题一路平滑滚屏到最后一题
        for (let i = 0; i < total; i++) {
            if (STATE.stopBatchRequested) break;

            // 每往前走 1 题，立即唤醒后台预取下 1 题，始终保持前方有 3 道题提前算好！
            triggerPrefetchUpTo(i + 1 + CONFIG.concurrency);

            const q = allQuestions[i];
            const curNum = i + 1;

            q.blockEl.classList.add('ds-scope-flash');
            updateSweepProgressUI(curNum, q.stemText, '🧠 正在定位并推导答案...', '');

            // 一边平滑滚屏到当前题，一边等待后台已经提前启动的该题推理结果
            const [parsed] = await Promise.all([
                resultPromises[i],
                smoothScrollToElementAsync(q.blockEl, 260)
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
            await sleep(220);
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
                        <div class="ds-answer-main">🎉 全卷 ${completedCount} / ${total} 题已高准选完！</div>
                        <div class="ds-answer-sub">每题均已完成独立推导并自动点选，请检查后提交。</div>
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
                    <span>正在独立推导当前单题 (长按或三击 🎯 全卷连刷)...</span>
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
