// ==UserScript==
// @name    DeepSeek 智能题库助手 (iPad 学习通/U校园/全平台触屏通用版)
// @namespace    https://tampermonkey.net/
// @version      3.0.0
// @updateURL    https://raw.githubusercontent.com/lihua0100-arch/deepseek-ipad-quiz-assistant/main/deepseek-ipad-quiz-assistant.user.js
// @downloadURL  https://raw.githubusercontent.com/lihua0100-arch/deepseek-ipad-quiz-assistant/main/deepseek-ipad-quiz-assistant.user.js
// @description  专为 iPad Safari 与 Mac 打造（全面适配学习通 mooc1.chaoxing.com、U校园、超星尔雅、各类网课）：保留单击悬浮球看单题答案；新增“长按悬浮球”或“连续点三下悬浮球”触发高速涡轮旋转特效，直接从第1题到最后一题平滑滚动屏幕，并通过页面主环境桥接器把整张试卷所有正确选项全部自动选上！
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
    const MOD_KEY_LABEL = IS_MAC ? '⌃Ctrl(或⌥Opt)' : 'Alt';

    /********************************************************************
     * 1. 配置参数与全局状态
     ********************************************************************/
    const CONFIG = {
        apiUrl: 'https://api.deepseek.com/chat/completions',
        longPressDuration: 450,   // 长按触发全卷自动连刷的毫秒阈值
        batchSize: 4              // 全卷连刷时每次批量并发解析的题目数（大幅提速，滚屏零等待）
    };

    const STATE = {
        apiKey: GM_getValue('DEEPSEEK_API_KEY', ''),
        model: GM_getValue('DEEPSEEK_MODEL', 'deepseek-chat'),
        isAnalyzing: false,
        isBatchRunning: false,    // 是否正在执行“从头到尾全卷自动滚屏全选”
        stopBatchRequested: false,
        lastPickedScope: null,
        lastMousePos: { x: window.innerWidth / 2, y: window.innerHeight / 2 },
        pickerMode: false,
        hoveredPickerEl: null,
        lastResultData: null
    };

    /********************************************************************
     * 2. 页面主环境点击桥接器 (Main-World Click & Scroll Bridge)
     * 说明：iPad Safari 的 Userscripts / Tampermonkey 运行在隔离沙箱中，
     * 直接在沙箱调 .click() 有时无法触发学习通 (mooc1.chaoxing.com) 页面里的
     * jQuery / Zepto / Vue 或内联 onclick="addChoice(this)"。
     * 通过向页面注入一段原生 <script>，在网页真实主环境中执行点击与 jQuery 触发！
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
                            // 1. 识别学习通/超星、AntD、ElementUI 的核心可点击行与圆圈按钮
                            var row = el.closest('.answerBg, .single_choice li, .multi_choice li, .true_false li, .answerList li, .ant-radio-wrapper, .ant-checkbox-wrapper, .el-radio, .el-checkbox, li') || el;
                            var badge = row.querySelector('.num_option, .num_option_dx, .ans-radio, .ans-checkbox, input[type="radio"], input[type="checkbox"], .ant-radio-input, .ant-checkbox-input, a, label');

                            var isSelected = function(node) {
                                if (!node) return false;
                                if (node.querySelector('input:checked')) return true;
                                if (node.querySelector('.check_answer, .check_answer_dx, .ant-radio-checked, .ant-checkbox-checked, .is-checked')) return true;
                                return /\\b(check_answer|check_answer_dx|checked|selected|active|cur|on)\\b/i.test(node.className || '');
                            };

                            // 若已经是选中状态，则不重复点击（防止把多选题取消勾选）
                            if (isSelected(row)) return;

                            var triggerNode = function(n) {
                                if (!n) return;
                                // 优先尝试调用页面原生的 jQuery / Zepto 事件触发
                                if (window.jQuery) {
                                    try { window.jQuery(n).trigger('tap'); } catch(_) {}
                                    try { window.jQuery(n).trigger('click'); } catch(_) {}
                                } else if (window.$ && typeof window.$.fn === 'object') {
                                    try { window.$(n).trigger('tap'); } catch(_) {}
                                    try { window.$(n).trigger('click'); } catch(_) {}
                                }
                                // 派发原生鼠标与触摸事件并执行 click()
                                try { n.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); } catch(_) {}
                                try { n.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true })); } catch(_) {}
                                try { n.click(); } catch(_) {}
                            };

                            // 先点外层选项行 (.answerBg / li)
                            triggerNode(row);

                            // 若未变为选中态，再补点内部的圆圈字母 (.num_option) 或原节点
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
     * 3. UI 样式：高速涡轮旋转特效 (ds-turbo-spin) 与全卷连刷进度卡片
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
            transition: transform 0.18s ease, box-shadow 0.2s ease, border-color 0.2s ease;
        }
        #ds-fab:active {
            transform: scale(0.92);
        }

        #ds-fab.ds-loading {
            animation: ds-spin-normal 1.1s linear infinite;
        }
        @keyframes ds-spin-normal {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }

        /* 长按/三击触发：高速涡轮旋转特效 + 翡翠流光光环 */
        #ds-fab.ds-turbo-spin {
            border-color: #10b981 !important;
            background: radial-gradient(circle, rgba(6, 95, 70, 0.98) 0%, rgba(15, 23, 42, 0.98) 100%) !important;
            box-shadow: 0 0 28px rgba(16, 185, 129, 0.98), 0 0 56px rgba(56, 189, 248, 0.75) !important;
            animation: ds-spin-turbo 0.18s linear infinite !important;
        }
        @keyframes ds-spin-turbo {
            0% { transform: scale(1.14) rotate(0deg); }
            50% { transform: scale(1.22) rotate(180deg); }
            100% { transform: scale(1.14) rotate(360deg); }
        }

        #ds-card {
            position: fixed;
            right: 16px;
            bottom: 92px;
            width: 340px;
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
            animation: ds-fade-in 0.2s ease-out;
            user-select: text;
        }
        @keyframes ds-fade-in {
            from { opacity: 0; transform: translateY(8px); }
            to { opacity: 1; transform: translateY(0); }
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
            transition: width 0.25s ease;
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
            transition: all 0.25s ease !important;
        }
        .ds-auto-clicked-pulse {
            outline: 3px solid #34d399 !important;
            background-color: rgba(16, 185, 129, 0.32) !important;
            box-shadow: 0 0 25px rgba(16, 185, 129, 0.9) !important;
            transition: all 0.25s ease !important;
        }
        .ds-scope-flash {
            outline: 2px dashed rgba(56, 189, 248, 0.85) !important;
            outline-offset: 4px !important;
            border-radius: 6px !important;
            transition: outline 0.3s ease !important;
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
        fabEl.title = '单击：解析单题 | 长按 或 连点3下：从头到尾自动滚屏并把所有选项全选上！';
        document.body.appendChild(fabEl);

        cardEl = document.createElement('div');
        cardEl.id = 'ds-card';
        cardEl.innerHTML = `
            <div class="ds-card-header">
                <span class="ds-card-title">💡 DeepSeek 题库助手 3.0</span>
                <span class="ds-card-close" id="ds-card-close-btn">✕</span>
            </div>
            <div id="ds-card-content">
                <div style="color:#94a3b8;font-size:12px;">
                    • <b>轻点 1 下 🎯</b>：解析当前单题并显示答案<br>
                    • <b>长按 🎯 或 连续点 3 下 🎯</b>：触发<b>高速涡轮旋转</b>，直接<b>从第 1 题到最后一题自动滚屏并把所有正确选项全部选上</b>！（运行中轻点可随时停止）
                </div>
            </div>
            <div class="ds-card-actions" id="ds-card-footer" style="margin-top:6px;display:flex;">
                <button class="ds-btn ds-btn-fill" id="ds-btn-autosweep">🚀 全卷从头到尾自动全选</button>
                <button class="ds-btn" id="ds-btn-autofill" style="display:none;">⚡ 点选当前题</button>
                <button class="ds-btn" id="ds-btn-switch-model">⚡ 当前V3</button>
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
            e.currentTarget.innerText = STATE.model === 'deepseek-reasoner' ? '🧠 当前R1' : '⚡ 当前V3';
        });

        fabEl.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
        });

        /****************************************************************
         * 4. 悬浮球手势引擎：支持「单击单题」「长按全卷连刷」「三连击全卷连刷」「拖拽」
         ****************************************************************/
        let isPressing = false;
        let startX = 0, startY = 0;
        let initialLeft = 0, initialTop = 0;
        let hasMoved = false;
        let longPressTriggered = false;
        let longPressTimer = null;

        // 记录连续点击次数（检测三连击）
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
                    // 长按直接启动全卷从头到尾自动滚屏全选！
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

        // 点击与三连击判别逻辑
        fabEl.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (hasMoved || longPressTriggered) return;

            // 如果正在全卷连刷过程中，轻点一下悬浮球即可随时紧急暂停/停止
            if (STATE.isBatchRunning) {
                STATE.stopBatchRequested = true;
                return;
            }

            tapCount += 1;
            if (tapResolveTimer) clearTimeout(tapResolveTimer);

            if (tapCount >= 3) {
                // 连续按三下：直接触发全卷从头到尾自动滚屏全选！
                tapCount = 0;
                startFullPageAutoSweep();
            } else {
                // 等待 320ms 看是否继续连点；若只点了 1~2 下，则执行单题解析
                tapResolveTimer = setTimeout(() => {
                    tapCount = 0;
                    triggerSingleQuestionAnalysis();
                }, 320);
            }
        });
    }

    // 记录用户最后触摸或点击的题目节点
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
     * 5. 涡轮旋转动画、跨容器平滑滚屏与页面主环境点击执行
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
            sweepBtn.innerText = '🚀 全卷从头到尾自动全选';
        }
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Promise 版跨容器/跨同源 iframe 强制平滑居中滚屏
    function smoothScrollToElementAsync(el, duration = 340) {
        return new Promise((resolve) => {
            if (!el) {
                resolve();
                return;
            }

            try {
                let totalTopOffset = 0;
                let currWin = el.ownerDocument.defaultView || window;
                const rectInOwnWin = el.getBoundingClientRect();
                totalTopOffset += rectInOwnWin.top + rectInOwnWin.height / 2;

                while (currWin && currWin !== window.top) {
                    try {
                        const frameEl = currWin.frameElement;
                        if (frameEl) {
                            const fr = frameEl.getBoundingClientRect();
                            totalTopOffset += fr.top;
                            currWin = currWin.parent;
                        } else {
                            break;
                        }
                    } catch (_) {
                        break;
                    }
                }

                // 将当前题目/选项滚到屏幕偏上 36% 处（避开右下角卡片遮挡）
                const targetViewportY = window.top.innerHeight * 0.36;
                const deltaY = totalTopOffset - targetViewportY;

                const scrollTargets = [];
                let node = el.parentElement;
                while (node && node !== el.ownerDocument.body && node !== el.ownerDocument.documentElement) {
                    const style = (el.ownerDocument.defaultView || window).getComputedStyle(node);
                    if (/(auto|scroll|overlay)/i.test(style.overflowY + style.overflow) && node.scrollHeight > node.clientHeight + 10) {
                        scrollTargets.push({ type: 'element', target: node, start: node.scrollTop });
                    }
                    node = node.parentElement;
                }

                const ownScrollEl = el.ownerDocument.scrollingElement || el.ownerDocument.documentElement || el.ownerDocument.body;
                if (ownScrollEl && ownScrollEl.scrollHeight > ownScrollEl.clientHeight + 10) {
                    scrollTargets.push({ type: 'element', target: ownScrollEl, start: ownScrollEl.scrollTop });
                }

                try {
                    const topScrollEl = window.top.document.scrollingElement || window.top.document.documentElement || window.top.document.body;
                    if (topScrollEl && !scrollTargets.some(s => s.target === topScrollEl)) {
                        scrollTargets.push({ type: 'window', target: window.top, start: window.top.scrollY || topScrollEl.scrollTop || 0 });
                    }
                } catch (_) {}

                if (Math.abs(deltaY) > 10 && scrollTargets.length > 0) {
                    const startTime = performance.now();
                    const step = (now) => {
                        const progress = Math.min(1, (now - startTime) / duration);
                        const eased = 1 - Math.pow(1 - progress, 3);

                        for (const item of scrollTargets) {
                            if (item.type === 'element') {
                                item.target.scrollTop = item.start + deltaY * eased;
                            } else if (item.type === 'window') {
                                item.target.scrollTo(0, item.start + deltaY * eased);
                            }
                        }

                        if (progress < 1) {
                            requestAnimationFrame(step);
                        } else {
                            resolve();
                        }
                    };
                    requestAnimationFrame(step);
                    return;
                }
            } catch (err) {
                console.warn('[DeepSeek Scroll]', err);
            }

            try {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            } catch (_) {}
            setTimeout(resolve, duration);
        });
    }

    // 通过页面主环境桥接器 + 沙箱双保险点击选项
    function clickOptionElementReliably(optionEl) {
        if (!optionEl) return;
        try {
            // 确保该文档已注入主环境桥接脚本
            const ownerDoc = optionEl.ownerDocument || document;
            if (!ownerDoc.getElementById('ds-mainworld-bridge')) {
                const s = ownerDoc.createElement('script');
                s.id = 'ds-mainworld-bridge';
                s.textContent = document.getElementById('ds-mainworld-bridge')?.textContent || '';
                (ownerDoc.head || ownerDoc.documentElement).appendChild(s);
            }

            // 1. 触发主环境桥接点击（支持学习通 jQuery/Zepto 与内联 onclick="addChoice(this)"）
            optionEl.setAttribute('data-ds-click-target', '1');
            (ownerDoc.defaultView || window).dispatchEvent(new CustomEvent('ds-mainworld-click'));

            // 2. 沙箱兜底点击
            const parentRow = optionEl.closest('.answerBg, .single_choice li, .multi_choice li, .true_false li, .answerList li, .ant-radio-wrapper, .ant-checkbox-wrapper, li') || optionEl;
            parentRow.classList.add('ds-correct-highlight', 'ds-auto-clicked-pulse');
            setTimeout(() => {
                parentRow.classList.remove('ds-auto-clicked-pulse');
            }, 1100);
        } catch (err) {
            console.error('[DeepSeek Click]', err);
        }
    }

    /********************************************************************
     * 6. 全卷题目扫描器：自动识别页面从第 1 题到最后一题的所有题目块
     ********************************************************************/
    const STRICT_QUESTION_BLOCK_SELECTORS = [
        '.TiMu', '.singleQuesId', '.questionLi',
        '.question-common-abs-reply', '.question-inputbox',
        '.question-item', '.question-box', '.question-card', '.exam-item',
        '.subject-item', '.q-item', '.ti-item', '.problem-item',
        '[class*="question-wrapper"]', '[class*="question-container"]', '[class*="exercise-item"]'
    ];

    const OPTION_SELECTORS = [
        '.answerBg', '.single_choice li', '.multi_choice li', '.true_false li', '.answerList li', '.marBom6', '.ul-list li',
        '.ant-radio-wrapper', '.ant-checkbox-wrapper', '[class*="radio-item"]', '[class*="checkbox-item"]',
        '[class*="option-wrap"]', '[class*="option-item"]', '[class*="optionItem"]', '[class*="choice-item"]',
        '.option', '.options li', '.question-option', '.answer-item',
        '.el-radio', '.el-checkbox', 'label', 'li[role="option"]', 'div[role="radio"]', 'div[role="checkbox"]'
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

    // 提取某个题块内的所有选项（注意：不限制视口高度，支持提取屏幕下方尚未滚动到的所有题目选项！）
    function extractOptionsFromBlock(blockEl) {
        let rawOptions = querySelectorAllDeep(OPTION_SELECTORS.join(','), blockEl);

        // 启发式兜底：若网页没有标准类名，扫描以 A/B/C/D 开头的并列选项行
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

        const options = [];
        const seenTexts = new Set();
        for (const el of rawOptions) {
            const r = el.getBoundingClientRect();
            if (r.width < 12 || r.height < 10 || r.height > 280) continue;
            const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
            if (t.length >= 1 && t.length <= 260 && !seenTexts.has(t)) {
                const isParent = rawOptions.some(other => other !== el && el.contains(other));
                if (!isParent) {
                    seenTexts.add(t);
                    options.push({ el, text: t });
                }
            }
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

    function extractCleanQuestionText(blockEl, targetInput = null) {
        if (!blockEl) return '';
        const liveInputs = Array.from(blockEl.querySelectorAll ? blockEl.querySelectorAll('input, textarea, [contenteditable="true"]') : []);
        const cleanupList = [];

        liveInputs.forEach((inp) => {
            if (inp.type === 'hidden' || inp.type === 'radio' || inp.type === 'checkbox') return;
            const curVal = (inp.isContentEditable ? inp.innerText : inp.value || '').trim();
            const marker = (targetInput && inp === targetInput)
                ? ` [[👉目标填空空格👈]] `
                : (curVal ? ` [[空格(已填:"${curVal}")]] ` : ` [[空格]] `);
            inp.setAttribute('data-ds-marker', marker);
            cleanupList.push(inp);
        });

        const clone = blockEl.cloneNode(true);
        cleanupList.forEach(inp => inp.removeAttribute('data-ds-marker'));
        clone.querySelectorAll('[data-ds-marker]').forEach(el => el.replaceWith(el.getAttribute('data-ds-marker')));
        clone.querySelectorAll('style, script, .ans-icon, .font-cxsecret-ignore').forEach(el => el.remove());

        return (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim();
    }

    // 扫描整张页面（含未滚入视口的下方区域），按从上到下顺序返回所有独立题目对象
    function collectAllQuestionsOnPage() {
        let blocks = querySelectorAllDeep(STRICT_QUESTION_BLOCK_SELECTORS.join(','));

        // 过滤掉无效容器或包裹了多道子题目的外层大容器
        let validBlocks = blocks.filter(el => {
            const r = el.getBoundingClientRect();
            if (r.width < 100 || r.height < 24) return false;
            const opts = extractOptionsFromBlock(el);
            const inps = extractInputsFromBlock(el);
            return opts.length >= 2 || inps.length >= 1;
        });

        // 剔除包含其它 validBlock 的父级容器，只保留最内层的单道题目块
        validBlocks = validBlocks.filter(el => !validBlocks.some(other => other !== el && el.contains(other)));

        // 启发式兜底：若页面没有标准题目容器类名，则从所有选项出发向上聚类找各自的题块父节点
        if (validBlocks.length === 0) {
            const allOpts = querySelectorAllDeep(OPTION_SELECTORS.join(','));
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

        // 按页面从上到下的绝对纵向位置排序
        validBlocks.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);

        return validBlocks.map((blockEl, index) => {
            const options = extractOptionsFromBlock(blockEl);
            const inputs = extractInputsFromBlock(blockEl);
            const stemText = extractCleanQuestionText(blockEl, inputs[0] || null).slice(0, 900);
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
     * 7. 全卷从头到尾自动滚屏全选引擎 (Batch Prefetch + Sequential Scroll & Click)
     ********************************************************************/
    function requestDeepSeekBatchAnalysis(questionBatch) {
        return new Promise((resolve) => {
            const batchPromptItems = questionBatch.map((q, idx) => {
                const optsStr = q.options.length > 0
                    ? q.options.map((o, i) => `  [${i}] ${o.text}`).join('\n')
                    : '  （填空/主观题，无选项）';
                return `【第 ${idx} 题】：\n题干与内容：${q.stemText}\n候选选项：\n${optsStr}`;
            }).join('\n\n----------------\n\n');

            const systemPrompt = [
                '你是一个高精度的在线题库全卷批量解析引擎。',
                '请针对用户提供的每道题目，准确判断正确答案，并严格返回如下 JSON 格式（不要包含任何 Markdown 代码块标签）：',
                '{',
                '  "results": [',
                '    { "qIdx": 0, "bestIndices": [正确选项数字编号数组，单选如[2]，多选如[0,2]], "answer": "正确选项或填空文本", "reason": "简短理由" }',
                '  ]',
                '}'
            ].join('\n');

            const payload = {
                model: STATE.model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: batchPromptItems }
                ]
            };
            if (STATE.model === 'deepseek-chat') {
                payload.temperature = 0.1;
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
                            resolve({});
                            return;
                        }
                        const data = JSON.parse(res.responseText);
                        const rawContent = data.choices?.[0]?.message?.content || '{}';
                        const cleaned = rawContent.replace(/```json|```/gi, '').trim();
                        const firstBrace = cleaned.indexOf('{');
                        const lastBrace = cleaned.lastIndexOf('}');
                        const parsed = JSON.parse(firstBrace !== -1 ? cleaned.slice(firstBrace, lastBrace + 1) : cleaned);
                        const map = {};
                        if (Array.isArray(parsed.results)) {
                            parsed.results.forEach((item, i) => {
                                const key = item.qIdx !== undefined ? Number(item.qIdx) : i;
                                map[key] = item;
                            });
                        }
                        resolve(map);
                    } catch (e) {
                        console.error('[DeepSeek Batch Parse]', e);
                        resolve({});
                    }
                },
                onerror: () => resolve({})
            });
        });
    }

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

        const updateSweepProgressUI = (curIdx, titlePreview, answerPreview, statusNote) => {
            if (!ui.contentBox) return;
            const pct = Math.round((curIdx / total) * 100);
            ui.contentBox.innerHTML = `
                <div style="display:flex;justify-content:space-between;align-items:center;color:#10b981;font-weight:600;">
                    <span>⚡ 全卷自动滚屏全选中 (${curIdx}/${total})</span>
                    <span style="font-size:11px;color:#94a3b8;">轻点 ⚡ 可随时暂停</span>
                </div>
                <div class="ds-progress-bar-bg">
                    <div class="ds-progress-bar-fill" style="width:${pct}%;"></div>
                </div>
                <div class="ds-answer-box" style="margin-top:6px;margin-bottom:2px;">
                    <div style="font-size:11px;color:#94a3b8;">当前第 ${curIdx} 题：${escapeHtml(titlePreview.slice(0, 26))}...</div>
                    <div class="ds-answer-main">${escapeHtml(answerPreview || '正在解析...')}</div>
                    ${statusNote ? `<div class="ds-answer-sub">${escapeHtml(statusNote)}</div>` : ''}
                </div>
            `;
        };

        // 按每批 CONFIG.batchSize (4道题) 切片：一边在后台并发拿到这4道题的答案，一边在前台逐题丝滑滚动屏幕并点选！
        for (let startIdx = 0; startIdx < total; startIdx += CONFIG.batchSize) {
            if (STATE.stopBatchRequested) break;

            const batch = allQuestions.slice(startIdx, startIdx + CONFIG.batchSize);

            // 先平滑滚动到本批次的第 1 道题，同时发起本批次 4 道题的 DeepSeek 请求
            const firstQ = batch[0];
            updateSweepProgressUI(startIdx + 1, firstQ.stemText, `⏳ 正在并发解析第 ${startIdx + 1}~${Math.min(total, startIdx + batch.length)} 题...`, '');

            const [batchAnswersMap] = await Promise.all([
                requestDeepSeekBatchAnalysis(batch),
                smoothScrollToElementAsync(firstQ.blockEl, 380)
            ]);

            // 依次滚动到本批次的每一道题并自动点击正确选项！
            for (let bIdx = 0; bIdx < batch.length; bIdx++) {
                if (STATE.stopBatchRequested) break;

                const q = batch[bIdx];
                const globalNum = startIdx + bIdx + 1;
                const ansObj = batchAnswersMap[bIdx] || {};

                // 滚动屏幕将该题居中并闪烁边框
                q.blockEl.classList.add('ds-scope-flash');
                await smoothScrollToElementAsync(q.blockEl, 320);

                const matchedOpts = [];
                if (q.options.length > 0) {
                    const indices = Array.isArray(ansObj.bestIndices)
                        ? ansObj.bestIndices.map(Number).filter(n => !Number.isNaN(n))
                        : [];

                    for (const i of indices) {
                        if (q.options[i]) matchedOpts.push(q.options[i]);
                    }

                    // 文本模糊匹配兜底
                    if (matchedOpts.length === 0 && ansObj.answer) {
                        const ansClean = String(ansObj.answer).replace(/^[A-H][.、\s)\]]*/i, '').trim();
                        const fb = q.options.find(o =>
                            o.text.includes(ansObj.answer) ||
                            String(ansObj.answer).includes(o.text) ||
                            (ansClean.length >= 2 && o.text.includes(ansClean))
                        );
                        if (fb) matchedOpts.push(fb);
                    }
                }

                // 执行自动点选或自动填空
                if (matchedOpts.length > 0) {
                    const ansDisplay = matchedOpts.map(o => o.text).join(' | ');
                    updateSweepProgressUI(globalNum, q.stemText, `✅ 已选：${ansDisplay}`, ansObj.reason || '');

                    for (const opt of matchedOpts) {
                        await smoothScrollToElementAsync(opt.el, 220);
                        clickOptionElementReliably(opt.el);
                        await sleep(220);
                    }
                    completedCount++;
                } else if (q.inputs.length > 0 && ansObj.answer) {
                    const inp = q.inputs[0];
                    updateSweepProgressUI(globalNum, q.stemText, `✍️ 已填：${ansObj.answer}`, ansObj.reason || '');
                    await smoothScrollToElementAsync(inp, 220);
                    inp.focus();
                    setNativeInputValue(inp, String(ansObj.answer).trim());
                    inp.classList.add('ds-correct-highlight');
                    completedCount++;
                } else {
                    updateSweepProgressUI(globalNum, q.stemText, ansObj.answer || '⚠️ 未匹配到选项', ansObj.reason || '');
                }

                setTimeout(() => q.blockEl.classList.remove('ds-scope-flash'), 600);
                await sleep(360);
            }
        }

        STATE.isBatchRunning = false;
        stopTurboSpinEffect();

        if (ui.contentBox) {
            if (STATE.stopBatchRequested) {
                ui.contentBox.innerHTML = `
                    <div class="ds-answer-box" style="border-left-color:#f59e0b;">
                        <div class="ds-answer-main" style="color:#f59e0b;">⏸️ 全卷连刷已手动暂停</div>
                        <div class="ds-answer-sub">已完成 ${completedCount} / ${total} 题。长按或连点 3 下 🎯 可重新开始。</div>
                    </div>
                `;
            } else {
                ui.contentBox.innerHTML = `
                    <div class="ds-answer-box">
                        <div class="ds-answer-main">🎉 全卷 ${completedCount} / ${total} 题已全部自动选完！</div>
                        <div class="ds-answer-sub">已从头到尾滚动并完成所有题目点选，请检查确认后提交。</div>
                    </div>
                `;
            }
        }
    }

    /********************************************************************
     * 8. 原有单题解析功能（轻点 1 下悬浮球触发）
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
        const questionText = extractCleanQuestionText(scopeEl, inputs[0] || null).slice(0, 1200);

        if (ui.card) ui.card.style.display = 'block';
        if (ui.contentBox) {
            ui.contentBox.innerHTML = `
                <div style="display:flex;align-items:center;gap:8px;color:#38bdf8;">
                    <span>⏳</span>
                    <span>正在解析当前单题 (长按或三击 🎯 可全卷自动连刷)...</span>
                </div>
                <div style="font-size:11px;color:#64748b;margin-top:4px;">题目：${escapeHtml(questionText.slice(0, 36))}...</div>
            `;
        }
        if (ui.fab) ui.fab.classList.add('ds-loading');
        STATE.isAnalyzing = true;

        requestDeepSeekBatchAnalysis([{ stemText: questionText, options, inputs }]).then((map) => {
            STATE.isAnalyzing = false;
            if (ui.fab) ui.fab.classList.remove('ds-loading');

            const ansObj = map[0];
            if (!ansObj) {
                if (ui.contentBox) ui.contentBox.innerHTML = `<div style="color:#ef4444;">❌ 解析失败，请检查 API Key 或网络</div>`;
                return;
            }

            const matchedOpts = [];
            if (options.length > 0 && Array.isArray(ansObj.bestIndices)) {
                ansObj.bestIndices.forEach(idx => {
                    if (options[Number(idx)]) matchedOpts.push(options[Number(idx)]);
                });
            }
            if (matchedOpts.length === 0 && ansObj.answer && options.length > 0) {
                const fb = options.find(o => o.text.includes(ansObj.answer) || String(ansObj.answer).includes(o.text));
                if (fb) matchedOpts.push(fb);
            }

            matchedOpts.forEach(opt => opt.el.classList.add('ds-correct-highlight'));
            const ansText = ansObj.answer || matchedOpts.map(o => o.text).join(' | ') || '已解析';

            if (ui.contentBox) {
                ui.contentBox.innerHTML = `
                    <div class="ds-answer-box">
                        <div style="font-size:11px;color:#94a3b8;margin-bottom:2px;">单题解析结果（长按或连点3下 🎯 全卷自动选完）</div>
                        <div class="ds-answer-main">${escapeHtml(ansText)}</div>
                        ${ansObj.reason ? `<div class="ds-answer-sub">${escapeHtml(ansObj.reason)}</div>` : ''}
                    </div>
                `;
            }

            if (ui.fillBtn) {
                ui.fillBtn.style.display = (matchedOpts.length > 0 || inputs.length > 0) ? 'inline-flex' : 'none';
                ui.fillBtn.onclick = async () => {
                    for (const opt of matchedOpts) {
                        await smoothScrollToElementAsync(opt.el, 240);
                        clickOptionElementReliably(opt.el);
                    }
                    if (matchedOpts.length === 0 && inputs[0] && ansText) {
                        inputs[0].focus();
                        setNativeInputValue(inputs[0], ansText);
                    }
                };
            }
        });
    }

    // 快捷键支持：Alt/Ctrl + W 直接触发全卷从头到尾自动全选
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
