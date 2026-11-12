// ==UserScript==
// @name         DeepSeek 智能题库助手 (iPad 学习通/U校园/全平台触屏通用版)
// @namespace    https://tampermonkey.net/
// @version      2.1.0
// @updateURL    https://raw.githubusercontent.com/lihua0100-arch/deepseek-ipad-quiz-assistant/main/deepseek-ipad-quiz-assistant.user.js
// @downloadURL  https://raw.githubusercontent.com/lihua0100-arch/deepseek-ipad-quiz-assistant/main/deepseek-ipad-quiz-assistant.user.js
// @description  专为 iPad Safari (学习通 mooc1.chaoxing.com / U校园 / 各类网课) 打造：修复沙箱 PointerEvent 报错导致无法自动点击与卡死旋转的问题；支持长按悬浮球触发“高速涡轮旋转 + 强制平滑滚屏居中 + 自动选中学习通/U校园选项”，再次长按还可自动滚屏推进到下一题连刷！
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
     * 1. 配置参数与状态管理
     ********************************************************************/
    const CONFIG = {
        apiUrl: 'https://api.deepseek.com/chat/completions',
        longPressDuration: 450    // 长按触发高速旋转与自动滚屏点选的毫秒阈值
    };

    // 保持脚本 @name、@namespace 和 GM 存储字段稳定，原位更新时沿用旧 Key 与模型设置。
    const STATE = {
        apiKey: GM_getValue('DEEPSEEK_API_KEY', ''),
        model: GM_getValue('DEEPSEEK_MODEL', 'deepseek-chat'),
        isAnalyzing: false,
        lastPickedScope: null,
        lastSolvedScopeEl: null,  // 记录上一道已完成的题块容器（用于连续长按自动推进下一题）
        lastTouchTime: 0,
        lastMousePos: { x: window.innerWidth / 2, y: window.innerHeight / 2 },
        pickerMode: false,
        hoveredPickerEl: null,
        lastResultData: null      // 缓存最近一次解析出的结果与对应 DOM 节点
    };

    /********************************************************************
     * 2. UI 样式：含高速涡轮旋转特效 (ds-turbo-spin) 与点选波纹动画
     ********************************************************************/
    const isTopFrame = window.self === window.top;

    const styleEl = document.createElement('style');
    styleEl.textContent = `
        /* 强力解封网页文字选中限制 */
        html, body, body * {
            -webkit-user-select: text !important;
            user-select: text !important;
            -webkit-touch-callout: default !important;
        }

        /* 可拖动悬浮球 */
        #ds-fab {
            position: fixed;
            right: 22px;
            bottom: 240px;
            width: 52px;
            height: 52px;
            border-radius: 50%;
            background: rgba(15, 23, 42, 0.9);
            color: #38bdf8;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 4px 18px rgba(0, 0, 0, 0.4);
            border: 1.5px solid rgba(56, 189, 248, 0.4);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            z-index: 2147483647;
            touch-action: none;
            user-select: none !important;
            -webkit-user-select: none !important;
            -webkit-touch-callout: none !important;
            -webkit-tap-highlight-color: transparent;
            font-size: 22px;
            cursor: pointer;
            transition: transform 0.18s ease, box-shadow 0.2s ease, border-color 0.2s ease;
        }
        #ds-fab:active {
            transform: scale(0.92);
        }

        /* 普通解析加载中旋转 */
        #ds-fab.ds-loading {
            animation: ds-spin-normal 1.1s linear infinite;
        }
        @keyframes ds-spin-normal {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }

        /* 长按触发：高速涡轮旋转特效 + 翡翠霓虹光环 */
        #ds-fab.ds-turbo-spin {
            border-color: #10b981 !important;
            background: radial-gradient(circle, rgba(6, 95, 70, 0.96) 0%, rgba(15, 23, 42, 0.96) 100%) !important;
            box-shadow: 0 0 25px rgba(16, 185, 129, 0.95), 0 0 50px rgba(56, 189, 248, 0.7) !important;
            animation: ds-spin-turbo 0.2s linear infinite !important;
        }
        @keyframes ds-spin-turbo {
            0% { transform: scale(1.14) rotate(0deg); }
            50% { transform: scale(1.2) rotate(180deg); }
            100% { transform: scale(1.14) rotate(360deg); }
        }

        /* 答案弹窗卡片 */
        #ds-card {
            position: fixed;
            right: 16px;
            bottom: 95px;
            width: 335px;
            max-width: calc(100vw - 32px);
            background: rgba(15, 23, 42, 0.95);
            color: #f8fafc;
            border-radius: 14px;
            border: 1px solid rgba(148, 163, 184, 0.3);
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
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
            background: rgba(30, 41, 59, 0.75);
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

        /* 正确选项高亮与自动点选脉冲动画 */
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
        .ds-picker-highlight {
            outline: 2px solid rgba(56, 189, 248, 0.9) !important;
            background-color: rgba(56, 189, 248, 0.08) !important;
            outline-offset: 3px !important;
            border-radius: 4px !important;
        }
    `;
    document.head.appendChild(styleEl);

    window.addEventListener('selectstart', (e) => e.stopPropagation(), true);
    window.addEventListener('copy', (e) => e.stopPropagation(), true);

    let fabEl = null;
    let cardEl = null;

    // 供主窗口或同源内层框架统一获取 UI 节点
    function getUIElements() {
        try {
            const topDoc = window.top.document;
            return {
                fab: topDoc.getElementById('ds-fab') || fabEl,
                card: topDoc.getElementById('ds-card') || cardEl,
                contentBox: topDoc.getElementById('ds-card-content'),
                footerBox: topDoc.getElementById('ds-card-footer'),
                fillBtn: topDoc.getElementById('ds-btn-autofill'),
                altBtn: topDoc.getElementById('ds-btn-alt-cycle'),
                modelBtn: topDoc.getElementById('ds-btn-switch-model')
            };
        } catch (_) {
            return {
                fab: fabEl,
                card: cardEl,
                contentBox: document.getElementById('ds-card-content'),
                footerBox: document.getElementById('ds-card-footer'),
                fillBtn: document.getElementById('ds-btn-autofill'),
                altBtn: document.getElementById('ds-btn-alt-cycle'),
                modelBtn: document.getElementById('ds-btn-switch-model')
            };
        }
    }

    if (isTopFrame) {
        fabEl = document.createElement('div');
        fabEl.id = 'ds-fab';
        fabEl.innerHTML = '🎯';
        fabEl.title = '轻点：显示答案 | 长按：高速旋转 + 滚屏居中 + 自动点击选项（再长按自动连刷下一题）';
        document.body.appendChild(fabEl);

        cardEl = document.createElement('div');
        cardEl.id = 'ds-card';
        cardEl.innerHTML = `
            <div class="ds-card-header">
                <span class="ds-card-title">💡 DeepSeek 题库助手 2.1</span>
                <span class="ds-card-close" id="ds-card-close-btn">✕</span>
            </div>
            <div id="ds-card-content">
                <div style="color:#94a3b8;font-size:12px;">
                    • <b>轻点 🎯 悬浮球</b>：解析当前题目并显示答案<br>
                    • <b>长按 🎯 悬浮球 (0.45秒)</b>：触发<b>高速涡轮旋转</b>，平滑滚屏居中并<b>自动点击正确选项</b>（再次长按自动跳到下一题连刷！）
                </div>
            </div>
            <div class="ds-card-actions" id="ds-card-footer" style="margin-top:6px;display:none;">
                <button class="ds-btn ds-btn-fill" id="ds-btn-autofill">⚡ 滚屏并自动点选</button>
                <button class="ds-btn" id="ds-btn-alt-cycle">🔄 切换备选</button>
                <button class="ds-btn" id="ds-btn-switch-model">🧠 切R1/V3</button>
            </div>
        `;
        document.body.appendChild(cardEl);

        document.getElementById('ds-card-close-btn').addEventListener('click', () => {
            cardEl.style.display = 'none';
        });

        // 阻止 iPad 长按悬浮球时弹出系统放大镜或右键菜单
        fabEl.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
        });

        /****************************************************************
         * 3. 悬浮球手势引擎：区分「轻点」「拖拽移动」与「长按涡轮自动点选」
         ****************************************************************/
        let isPressing = false;
        let startX = 0, startY = 0;
        let initialLeft = 0, initialTop = 0;
        let hasMoved = false;
        let longPressTriggered = false;
        let longPressTimer = null;

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
                    handleLongPressTurboAction();
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
            triggerAnalysis({ autoExecute: false });
        });
    }

    // 在主窗口与所有同源子 iframe 中记录用户的触摸/点击位置
    window.addEventListener('mousemove', (e) => {
        STATE.lastMousePos.x = e.clientX;
        STATE.lastMousePos.y = e.clientY;
        if (STATE.pickerMode) {
            updatePickerHighlight(e.clientX, e.clientY);
        }
    }, { passive: true });

    window.addEventListener('click', (e) => {
        const hit = e.target;
        const ui = getUIElements();
        if (hit && (!ui.fab || !ui.fab.contains(hit)) && (!ui.card || !ui.card.contains(hit))) {
            // 如果不是脚本自动触发的合成点击，则记录为用户主动手点选的题目
            if (e.isTrusted) {
                STATE.lastPickedScope = hit;
                STATE.lastTouchTime = Date.now();
            }
        }

        if (STATE.pickerMode) {
            e.preventDefault();
            e.stopPropagation();
            const picked = STATE.hoveredPickerEl;
            togglePickerMode(false);
            if (picked) {
                triggerAnalysis({ explicitScope: picked, autoExecute: false });
            }
        }
    }, true);

    window.addEventListener('touchstart', (e) => {
        const hit = e.target;
        const ui = getUIElements();
        if (hit && (!ui.fab || !ui.fab.contains(hit)) && (!ui.card || !ui.card.contains(hit))) {
            STATE.lastPickedScope = hit;
            STATE.lastTouchTime = Date.now();
            if (e.touches[0]) {
                STATE.lastMousePos.x = e.touches[0].clientX;
                STATE.lastMousePos.y = e.touches[0].clientY;
            }
        }
    }, { passive: true });

    /********************************************************************
     * 4. 核心修复：iPad Safari 跨容器/跨 iframe 平滑居中滚屏 + 零报错真实点击引擎
     ********************************************************************/
    let turboSafetyTimer = null;

    function startTurboSpinEffect() {
        const { fab } = getUIElements();
        if (!fab) return;
        fab.classList.remove('ds-loading');
        fab.classList.add('ds-turbo-spin');
        fab.innerHTML = '⚡';

        // 安全保底：最多旋转 6 秒后必定恢复，绝不卡死在旋转态
        if (turboSafetyTimer) clearTimeout(turboSafetyTimer);
        turboSafetyTimer = setTimeout(stopTurboSpinEffect, 6000);
    }

    function stopTurboSpinEffect() {
        if (turboSafetyTimer) {
            clearTimeout(turboSafetyTimer);
            turboSafetyTimer = null;
        }
        const { fab } = getUIElements();
        if (!fab) return;
        fab.classList.remove('ds-turbo-spin');
        fab.classList.remove('ds-loading');
        fab.innerHTML = '🎯';
    }

    // 跨容器/跨同源 iframe 强制平滑居中滚动（解决 iPad Safari 下 scrollIntoView 不滚动外层窗口或滚动容器的问题）
    function smoothScrollElementToCenter(el, callback) {
        if (!el) {
            if (callback) callback();
            return;
        }

        try {
            // 1. 计算元素相对于顶层视口 (window.top) 的真实坐标偏移
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

            // 目标位置：将元素滚到屏幕偏上 38% 的黄金视觉与操作中心（避开底部浮窗卡片）
            const targetViewportY = window.top.innerHeight * 0.38;
            const deltaY = totalTopOffset - targetViewportY;

            // 2. 收集所有可滚动的祖先容器（含内部 overflow:auto/scroll 容器、当前文档与顶层窗口）
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

            // 3. 使用 requestAnimationFrame 执行 340ms 丝滑阻尼滚屏动画
            if (Math.abs(deltaY) > 12 && scrollTargets.length > 0) {
                const duration = 340;
                const startTime = performance.now();

                const step = (now) => {
                    const progress = Math.min(1, (now - startTime) / duration);
                    // easeOutCubic 曲线
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
                    } else if (callback) {
                        callback();
                    }
                };
                requestAnimationFrame(step);
                return;
            }
        } catch (err) {
            console.warn('[DeepSeek Scroll]', err);
        }

        // 兜底原生平滑滚动
        try {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } catch (_) {}
        setTimeout(() => {
            if (callback) callback();
        }, 320);
    }

    // 检查学习通/U校园的某个选项是否已经处于被选中状态（防止多选题或重复点击导致取消选中）
    function isOptionAlreadySelected(optionEl) {
        if (!optionEl) return false;
        const checkContainer = optionEl.closest('li, .answerBg, .ant-radio-wrapper, .ant-checkbox-wrapper') || optionEl;
        if (checkContainer.querySelector('input:checked')) return true;
        if (checkContainer.querySelector('.check_answer, .check_answer_dx, .ant-radio-checked, .ant-checkbox-checked, .is-checked')) return true;
        if (/\b(check_answer|check_answer_dx|checked|selected|active|cur|on)\b/i.test(checkContainer.className)) return true;
        return false;
    }

    // 零报错真实点击引擎：专为学习通 (mooc1.chaoxing.com) 与 U校园设计
    // 注意：绝不向 MouseEvent 传入油猴沙箱的 Proxy window (view: window)，否则 WebKit 会抛 TypeError 中断点击！
    function simulateRealOptionClick(optionEl) {
        if (!optionEl) return;

        try {
            // 收集学习通与通用题库中可能绑定了 onclick / addChoice(this) 的候选节点（从内到外）
            const parentRow = optionEl.closest('.answerBg, .single_choice li, .multi_choice li, .true_false li, .answerList li, .clearfix, li') || optionEl;
            const clickCandidates = [
                parentRow.querySelector('input[type="radio"], input[type="checkbox"], .ant-radio-input, .ant-checkbox-input'),
                parentRow.querySelector('.num_option, .num_option_dx, .ans-radio, .ans-checkbox, [class*="option-icon"], span[data]'),
                parentRow.querySelector('.answer_p, a, label, p'),
                optionEl,
                parentRow
            ].filter(Boolean);

            // 去重
            const uniqueTargets = Array.from(new Set(clickCandidates));

            const dispatchCleanClick = (node) => {
                if (!node) return;
                const rect = node.getBoundingClientRect();
                const cx = rect.left + rect.width / 2;
                const cy = rect.top + rect.height / 2;

                // 不传 view 属性，完美避开 Tampermonkey 沙箱 Proxy Window 类型校验异常
                const evtOpts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy };
                try { node.dispatchEvent(new MouseEvent('mousedown', evtOpts)); } catch (_) {}
                try { node.dispatchEvent(new MouseEvent('mouseup', evtOpts)); } catch (_) {}
                try { node.click(); } catch (_) {}
            };

            // 1. 先点击最核心的目标节点（事件会自动向上冒泡触发父级的 onclick="addChoice(this)"）
            dispatchCleanClick(uniqueTargets[0]);

            // 2. 40ms 后检查是否已成功变为蓝色选中态；若网页把事件绑在其它兄弟或外层节点上，则依次补点直至选中！
            setTimeout(() => {
                for (let i = 1; i < uniqueTargets.length; i++) {
                    if (isOptionAlreadySelected(parentRow)) break;
                    dispatchCleanClick(uniqueTargets[i]);
                }
            }, 40);

            parentRow.classList.add('ds-auto-clicked-pulse');
            setTimeout(() => {
                parentRow.classList.remove('ds-auto-clicked-pulse');
            }, 1200);
        } catch (err) {
            console.error('[DeepSeek AutoClick]', err);
        }
    }

    // 执行“平滑滚屏居中 + 自动点击正确选项（或自动填入）”
    function performScrollAndAutoClick(resultData) {
        if (!resultData) {
            stopTurboSpinEffect();
            return;
        }

        resultData.autoClicked = true;
        const { matchedOptions, targetInput, answerText, scopeEl } = resultData;
        if (scopeEl && scopeEl !== document.body) {
            STATE.lastSolvedScopeEl = scopeEl;
        }

        // 情况 A：选择题（单选或多选） -> 平滑滚屏居中并自动点击
        if (matchedOptions && matchedOptions.length > 0) {
            matchedOptions.forEach((optObj, idx) => {
                setTimeout(() => {
                    const el = optObj.el;
                    if (!el) {
                        if (idx === matchedOptions.length - 1) stopTurboSpinEffect();
                        return;
                    }

                    smoothScrollElementToCenter(el, () => {
                        setTimeout(() => {
                            simulateRealOptionClick(el);
                            if (idx === matchedOptions.length - 1) {
                                const { contentBox } = getUIElements();
                                const statusLabel = contentBox?.querySelector('.ds-answer-box div:first-child');
                                if (statusLabel) {
                                    statusLabel.innerHTML = '⚡ <b style="color:#10b981;">已滚屏并自动点选正确项</b>（再次长按 🎯 自动做下一题）';
                                }
                                setTimeout(stopTurboSpinEffect, 280);
                            }
                        }, 120);
                    });
                }, idx * 550);
            });
            return;
        }

        // 情况 B：填空题 / 翻译题 / 简答题 -> 平滑滚屏居中并自动填入答案
        if (targetInput && answerText) {
            smoothScrollElementToCenter(targetInput, () => {
                setTimeout(() => {
                    targetInput.focus();
                    setNativeInputValue(targetInput, answerText);
                    targetInput.classList.add('ds-correct-highlight', 'ds-auto-clicked-pulse');
                    setTimeout(() => {
                        targetInput.classList.remove('ds-auto-clicked-pulse');
                        stopTurboSpinEffect();
                    }, 450);
                }, 120);
            });
            return;
        }

        stopTurboSpinEffect();
    }

    // 查找页面上的“下一道题目”（支持长按悬浮球一路往下自动滚屏连刷！）
    function findNextQuestionScopeOnPage() {
        const allQuestionBlocks = querySelectorAllDeep(STRICT_QUESTION_BLOCK_SELECTORS.join(',')).filter(el => {
            const r = el.getBoundingClientRect();
            if (r.width < 120 || r.height < 30 || r.height > window.innerHeight * 1.5) return false;
            // 过滤掉嵌套父容器，只保留最内层的独立题块（如学习通的每个 .TiMu / .singleQuesId）
            const hasChildQuestion = Array.from(el.children).some(ch =>
                STRICT_QUESTION_BLOCK_SELECTORS.some(sel => {
                    try { return ch.matches && ch.matches(sel); } catch (_) { return false; }
                })
            );
            return !hasChildQuestion;
        });

        if (allQuestionBlocks.length === 0) return null;

        // 1. 如果已有上一道刚完成的题块 lastSolvedScopeEl，直接找排在它后面的下一道题！
        if (STATE.lastSolvedScopeEl) {
            const lastIdx = allQuestionBlocks.indexOf(STATE.lastSolvedScopeEl);
            if (lastIdx !== -1 && lastIdx + 1 < allQuestionBlocks.length) {
                return allQuestionBlocks[lastIdx + 1];
            }
            // 或者按页面纵向坐标找在它下方的第一道题
            const lastRect = STATE.lastSolvedScopeEl.getBoundingClientRect();
            const nextBelow = allQuestionBlocks.find(el => el !== STATE.lastSolvedScopeEl && el.getBoundingClientRect().top > lastRect.top + 25);
            if (nextBelow) return nextBelow;
        }

        // 2. 否则，优先找当前视口内第一道“尚未作答”的题目，或视口最上方的第一道题
        const inViewBlocks = allQuestionBlocks.filter(el => {
            const r = el.getBoundingClientRect();
            return r.bottom > 60 && r.top < window.innerHeight - 40;
        });

        const unansweredInView = inViewBlocks.find(el => !isOptionAlreadySelected(el));
        return unansweredInView || inViewBlocks[0] || allQuestionBlocks[0];
    }

    // 长按悬浮球主入口
    function handleLongPressTurboAction() {
        startTurboSpinEffect();
        const { card } = getUIElements();
        if (card) card.style.display = 'block';

        // 情况 1：如果刚才已经轻点解析出了某道题的答案（例如截图中的第1题 C 常规集装箱），且还没自动点选过它：
        // 立即滚屏居中这道题的正确选项并自动点击它！
        if (
            STATE.lastResultData &&
            !STATE.lastResultData.autoClicked &&
            STATE.lastResultData.timestamp >= STATE.lastTouchTime &&
            ((STATE.lastResultData.matchedOptions && STATE.lastResultData.matchedOptions.length > 0) ||
             STATE.lastResultData.targetInput)
        ) {
            performScrollAndAutoClick(STATE.lastResultData);
            return;
        }

        // 情况 2：如果用户在长按前刚刚用手指点过某道新题，则针对用户刚点的这道题执行“解析 + 滚屏 + 自动点选”
        if (STATE.lastPickedScope && (!STATE.lastResultData || STATE.lastTouchTime > STATE.lastResultData.timestamp)) {
            triggerAnalysis({ explicitScope: null, autoExecute: true });
            return;
        }

        // 情况 3：如果上一道题已经自动点选过了（或刚打开页面直接长按），自动寻找页面上的下一道题目，先平滑滚屏过去，再解析并自动点选！
        const nextScope = findNextQuestionScopeOnPage();
        if (nextScope) {
            STATE.lastSolvedScopeEl = nextScope;
            smoothScrollElementToCenter(nextScope, () => {
                triggerAnalysis({ explicitScope: nextScope, autoExecute: true });
            });
            return;
        }

        triggerAnalysis({ explicitScope: null, autoExecute: true });
    }

    /********************************************************************
     * 5. 快捷键监听 (Mac / iPad 妙控键盘 / Win 兼容)
     ********************************************************************/
    window.addEventListener('keydown', (e) => {
        const isShortcutMod = e.altKey || (IS_MAC && e.ctrlKey && !e.metaKey);

        if (e.code === 'Escape') {
            if (STATE.pickerMode) {
                togglePickerMode(false);
                return;
            }
            const { card } = getUIElements();
            if (card && card.style.display !== 'none') {
                card.style.display = 'none';
                return;
            }
        }

        if (isShortcutMod && e.code === 'KeyQ') {
            e.preventDefault();
            triggerAnalysis({ autoExecute: false });
            return;
        }

        if (isShortcutMod && e.code === 'KeyW') {
            e.preventDefault();
            handleLongPressTurboAction();
            return;
        }

        if (isShortcutMod && e.code === 'KeyS') {
            e.preventDefault();
            togglePickerMode();
            return;
        }
    });

    /********************************************************************
     * 6. 核心选题算法：学习通 (mooc1.chaoxing.com) + U校园 + 通用题库
     ********************************************************************/
    function isEditable(el) {
        if (!el) return false;
        const tag = el.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable ||
               el.getAttribute?.('role') === 'textbox' || el.classList?.contains('edui-body-container');
    }

    // 严格的单题外层容器选择器（用于自动寻找下一题）
    const STRICT_QUESTION_BLOCK_SELECTORS = [
        '.TiMu', '.singleQuesId', '.questionLi', '.question-common-abs-reply', '.question-inputbox',
        '.question-item', '.question-box', '.question-card', '.exam-item',
        '.subject-item', '.q-item', '.ti-item', '.problem-item',
        '[class*="question-wrapper"]', '[class*="question-container"]', '[class*="exercise-item"]'
    ];

    const CONTAINER_SELECTORS = [
        ...STRICT_QUESTION_BLOCK_SELECTORS,
        '.padBom50', '.font-cxsecret',
        '[class*="question"]', '[class*="subject"]', '[class*="topic"]',
        'fieldset', 'article', 'li'
    ];

    const OPTION_SELECTORS = [
        // 学习通 (mooc1.chaoxing.com) 专属选项行
        '.answerBg', '.single_choice li', '.multi_choice li', '.true_false li', '.answerList li', '.marBom6', '.ul-list li',
        // U校园 / AntDesign / React
        '.ant-radio-wrapper', '.ant-checkbox-wrapper', '[class*="radio-item"]', '[class*="checkbox-item"]',
        '[class*="option-wrap"]', '[class*="option-item"]', '[class*="optionItem"]', '[class*="choice-item"]',
        // 通用题库
        '.option', '.options li', '.question-option', '.answer-item',
        '.el-radio', '.el-checkbox', 'label', 'li[role="option"]', 'div[role="radio"]', 'div[role="checkbox"]'
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

    function extractRichTextWithBlanks(node, targetBlankEl = null) {
        if (!node) return '';
        const liveInputs = Array.from(node.querySelectorAll ? node.querySelectorAll('input, textarea, [contenteditable="true"], .edui-body-container') : []);
        const cleanupList = [];

        liveInputs.forEach((inp) => {
            if (inp.type === 'hidden' || inp.type === 'radio' || inp.type === 'checkbox') return;
            const curVal = (inp.isContentEditable ? inp.innerText : inp.value || '').trim();
            const marker = (targetBlankEl && inp === targetBlankEl)
                ? (curVal ? ` [[👉当前需要作答的目标空格(已填:"${curVal}")👈]] ` : ` [[👉当前需要作答的目标空格👈]] `)
                : (curVal ? ` [[空格(已填:"${curVal}")]] ` : ` [[空格(待填)]] `);
            inp.setAttribute('data-ds-marker', marker);
            cleanupList.push(inp);
        });

        const clone = node.cloneNode(true);
        cleanupList.forEach(inp => inp.removeAttribute('data-ds-marker'));

        clone.querySelectorAll('[data-ds-marker]').forEach(el => {
            el.replaceWith(el.getAttribute('data-ds-marker'));
        });
        clone.querySelectorAll('style, script, .ans-icon, .font-cxsecret-ignore').forEach(el => el.remove());

        return (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function findSmartQuestionScope(explicitScope = null) {
        if (explicitScope) {
            return {
                scopeEl: explicitScope,
                customText: null,
                targetInput: explicitScope.querySelector?.('input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), textarea, [contenteditable="true"]') || null
            };
        }

        const selectionText = window.getSelection()?.toString().trim();
        if (selectionText && selectionText.length >= 2) {
            return { scopeEl: document.body, customText: selectionText, targetInput: null };
        }

        const ui = getUIElements();
        const hitUnderMouse = document.elementFromPoint(STATE.lastMousePos.x, STATE.lastMousePos.y);
        let curr = (STATE.lastPickedScope && STATE.lastPickedScope.ownerDocument?.body.contains(STATE.lastPickedScope))
            ? STATE.lastPickedScope
            : (hitUnderMouse || document.activeElement);

        if (curr && (curr === ui.fab || ui.fab?.contains(curr) || curr === ui.card || ui.card?.contains(curr))) {
            curr = null;
        }

        // 若用户尚未点选任何题目，自动取视口中央或第一道题目
        if (!curr || curr === document.body || curr === document.documentElement) {
            const firstScope = findNextQuestionScopeOnPage();
            if (firstScope) {
                return {
                    scopeEl: firstScope,
                    customText: null,
                    targetInput: firstScope.querySelector?.('input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), textarea, [contenteditable="true"]') || null
                };
            }
            curr = document.body;
        }

        let targetInput = null;
        if (isEditable(curr)) {
            targetInput = curr;
        }

        const unipusReply = curr?.closest?.('.question-common-abs-reply, .question-inputbox');
        if (unipusReply) {
            return {
                scopeEl: unipusReply,
                customText: null,
                targetInput: targetInput || unipusReply.querySelector('textarea, input, [contenteditable="true"]')
            };
        }

        let depth = 0;
        let bestScope = curr;
        while (curr && curr !== curr.ownerDocument?.body && depth < 12) {
            const isMatchedContainer = CONTAINER_SELECTORS.some(sel => {
                try { return curr.matches && curr.matches(sel); } catch (_) { return false; }
            });

            const inputs = Array.from(curr.querySelectorAll('input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), textarea, [contenteditable="true"]'));
            const options = Array.from(curr.querySelectorAll(OPTION_SELECTORS.join(',')));

            if (!targetInput && inputs.length > 0) {
                targetInput = inputs[0];
            }

            if (isMatchedContainer || (inputs.length === 1 && (curr.innerText || '').length >= 6) || (options.length >= 2 && options.length <= 8)) {
                bestScope = curr;
                break;
            }
            curr = curr.parentElement;
            depth++;
        }

        return {
            scopeEl: bestScope || document.body,
            customText: null,
            targetInput
        };
    }

    function togglePickerMode(forceState) {
        STATE.pickerMode = typeof forceState === 'boolean' ? forceState : !STATE.pickerMode;
        if (!STATE.pickerMode) {
            if (STATE.hoveredPickerEl) {
                STATE.hoveredPickerEl.classList.remove('ds-picker-highlight');
                STATE.hoveredPickerEl = null;
            }
        } else {
            updatePickerHighlight(STATE.lastMousePos.x, STATE.lastMousePos.y);
        }
    }

    function updatePickerHighlight(x, y) {
        if (!STATE.pickerMode) return;
        const ui = getUIElements();
        const hit = document.elementFromPoint(x, y);
        if (!hit || hit === ui.fab || hit === ui.card || ui.card?.contains(hit)) return;

        let scope = hit;
        let depth = 0;
        while (scope && scope !== document.body && depth < 8) {
            const r = scope.getBoundingClientRect();
            if (r.width > 120 && r.height > 24 && r.height < window.innerHeight * 0.8) {
                break;
            }
            scope = scope.parentElement;
            depth++;
        }

        if (scope && scope !== STATE.hoveredPickerEl) {
            if (STATE.hoveredPickerEl) {
                STATE.hoveredPickerEl.classList.remove('ds-picker-highlight');
            }
            STATE.hoveredPickerEl = scope;
            STATE.hoveredPickerEl.classList.add('ds-picker-highlight');
        }
    }

    function flashScope(el) {
        if (!el || el === document.body) return;
        el.classList.add('ds-scope-flash');
        setTimeout(() => el.classList.remove('ds-scope-flash'), 800);
    }

    /********************************************************************
     * 7. API 解析与浮窗结果呈现（支持 autoExecute 长按自动滚屏点选）
     ********************************************************************/
    function triggerAnalysis({ explicitScope = null, autoExecute = false } = {}) {
        const ui = getUIElements();
        if (!STATE.apiKey) {
            stopTurboSpinEffect();
            const key = prompt('请输入您的 DeepSeek API Key (sk-...):', '');
            if (key) {
                STATE.apiKey = key.trim();
                GM_setValue('DEEPSEEK_API_KEY', STATE.apiKey);
            } else {
                return;
            }
        }

        if (STATE.isAnalyzing) return;

        const { scopeEl, customText, targetInput } = findSmartQuestionScope(explicitScope);
        flashScope(scopeEl);

        const questionText = customText || extractRichTextWithBlanks(scopeEl, targetInput);

        let rawOptions = querySelectorAllDeep(OPTION_SELECTORS.join(','), scopeEl);
        if (rawOptions.length === 0 && scopeEl === document.body) {
            rawOptions = querySelectorAllDeep(OPTION_SELECTORS.join(','), document);
        }

        const options = [];
        const seenTexts = new Set();
        for (const el of rawOptions) {
            const r = el.getBoundingClientRect();
            if (r.width < 16 || r.height < 12) continue;
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

        if (ui.card) ui.card.style.display = 'block';
        if (ui.footerBox) ui.footerBox.style.display = 'none';

        if (ui.contentBox) {
            ui.contentBox.innerHTML = `
                <div style="display:flex;align-items:center;gap:8px;color:${autoExecute ? '#10b981' : '#38bdf8'};">
                    <span>${autoExecute ? '⚡' : '⏳'}</span>
                    <span>${autoExecute
                        ? `<b>涡轮自动点选模式</b>：正在解析并自动滚屏点选...`
                        : `正在使用 <b>${STATE.model === 'deepseek-reasoner' ? 'R1推理' : 'V3'}</b> 解析题目...`}</span>
                </div>
                <div style="font-size:11px;color:#64748b;margin-top:4px;">题目：${escapeHtml(questionText.slice(0, 38))}...</div>
            `;
        }

        if (autoExecute) {
            startTurboSpinEffect();
        } else if (ui.fab) {
            ui.fab.classList.add('ds-loading');
        }

        STATE.isAnalyzing = true;

        const systemPrompt = [
            '你是一个专为 iPad/Mac 学习通(超星尔雅)、U校园等多平台打造的高精度解题助手。',
            '请直接返回纯净 JSON 格式（不要包含任何 Markdown 代码块标签）：',
            '{',
            '  "questionType": "choice" 或 "input" 或 "translate" 或 "essay",',
            '  "bestIndices": [选项数字编号数组，单选题如 [0]，多选题如 [0, 2]],',
            '  "answer": "必须选中或填入的最准确答案文本",',
            '  "altAnswers": ["备选格式1", "备选格式2"],',
            '  "reason": "1句简短解析或中文翻译"',
            '}'
        ].join('\n');

        const userPrompt = [
            `【题目内容】：\n${questionText}`,
            options.length > 0 ? `【候选选项】：\n${options.map((o, i) => `[${i}] ${o.text}`).join('\n')}` : '',
            targetInput ? `【填空输入框当前框内值】："${targetInput.value || ''}"` : ''
        ].filter(Boolean).join('\n\n');

        const payload = {
            model: STATE.model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
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
                STATE.isAnalyzing = false;
                if (!autoExecute && ui.fab) ui.fab.classList.remove('ds-loading');
                try {
                    if (res.status !== 200) {
                        stopTurboSpinEffect();
                        if (ui.contentBox) ui.contentBox.innerHTML = `<div style="color:#ef4444;">❌ 请求失败 (HTTP ${res.status})，请检查 API Key</div>`;
                        return;
                    }
                    const data = JSON.parse(res.responseText);
                    const rawContent = data.choices?.[0]?.message?.content || '{}';
                    const cleaned = rawContent.replace(/```json|```/gi, '').trim();
                    const firstBrace = cleaned.indexOf('{');
                    const lastBrace = cleaned.lastIndexOf('}');
                    const parsed = JSON.parse(firstBrace !== -1 ? cleaned.slice(firstBrace, lastBrace + 1) : cleaned);

                    renderResult(parsed, options, targetInput, scopeEl, autoExecute);
                } catch (err) {
                    stopTurboSpinEffect();
                    console.error(err);
                    if (ui.contentBox) ui.contentBox.innerHTML = `<div style="color:#ef4444;">❌ 解析响应失败，请重试</div>`;
                }
            },
            onerror: () => {
                STATE.isAnalyzing = false;
                stopTurboSpinEffect();
                if (ui.contentBox) ui.contentBox.innerHTML = `<div style="color:#ef4444;">❌ 网络请求失败，请检查网络连接</div>`;
            }
        });
    }

    function renderResult(parsed, options, targetInput, scopeEl, autoExecute = false) {
        const ui = getUIElements();

        querySelectorAllDeep('.ds-correct-highlight').forEach(el => el.classList.remove('ds-correct-highlight'));

        const matchedOptions = [];
        if (options.length > 0) {
            const indices = Array.isArray(parsed.bestIndices)
                ? parsed.bestIndices.map(Number).filter(n => !Number.isNaN(n))
                : (parsed.bestIndex !== undefined ? [Number(parsed.bestIndex)] : []);

            for (const idx of indices) {
                if (options[idx]) {
                    matchedOptions.push(options[idx]);
                }
            }

            if (matchedOptions.length === 0 && parsed.answer) {
                const ansClean = String(parsed.answer).replace(/^[A-H][.、\s)\]]*/i, '').trim();
                const fallbackOpt = options.find(o =>
                    o.text.includes(parsed.answer) ||
                    parsed.answer.includes(o.text) ||
                    (ansClean.length >= 2 && o.text.includes(ansClean))
                );
                if (fallbackOpt) matchedOptions.push(fallbackOpt);
            }

            matchedOptions.forEach(opt => {
                opt.el.classList.add('ds-correct-highlight');
            });
        }

        const answerText = parsed.answer || matchedOptions.map(o => o.text).join(' / ') || '已锁定';
        const typeLabel = parsed.questionType === 'translate' ? '英文译文'
            : (parsed.questionType === 'choice' || options.length > 0)
                ? (autoExecute ? '⚡ <b style="color:#10b981;">正在滚屏并自动点选...</b>' : '正确选项（长按 🎯 自动滚屏点选）')
            : parsed.questionType === 'essay' ? '简答答案' : '填空答案';

        STATE.lastResultData = {
            parsed,
            scopeEl,
            targetInput,
            options,
            matchedOptions,
            answerText,
            autoClicked: false,
            altIdx: 0,
            timestamp: Date.now()
        };

        if (ui.contentBox) {
            ui.contentBox.innerHTML = `
                <div class="ds-answer-box">
                    <div style="font-size:11px;color:#94a3b8;margin-bottom:2px;">${typeLabel}</div>
                    <div class="ds-answer-main" id="ds-main-answer-text">${escapeHtml(answerText)}</div>
                    ${parsed.reason ? `<div class="ds-answer-sub">${escapeHtml(parsed.reason)}</div>` : ''}
                </div>
            `;
        }

        if (ui.footerBox) ui.footerBox.style.display = 'flex';

        if (ui.fillBtn) {
            const canAutoAct = matchedOptions.length > 0 || Boolean(targetInput);
            ui.fillBtn.style.display = canAutoAct ? 'inline-flex' : 'none';
            ui.fillBtn.innerText = matchedOptions.length > 0 ? '⚡ 滚屏并自动点选' : '✍️ 填入当前格';
            ui.fillBtn.onclick = () => {
                startTurboSpinEffect();
                performScrollAndAutoClick(STATE.lastResultData);
                ui.fillBtn.innerText = '✅ 已执行';
                setTimeout(() => {
                    ui.fillBtn.innerText = matchedOptions.length > 0 ? '⚡ 滚屏并自动点选' : '✍️ 填入当前格';
                }, 1500);
            };
        }

        const altList = [answerText, ...(parsed.altAnswers || [])].filter(Boolean);
        if (ui.altBtn) {
            ui.altBtn.style.display = altList.length > 1 ? 'inline-flex' : 'none';
            ui.altBtn.onclick = () => {
                STATE.lastResultData.altIdx = (STATE.lastResultData.altIdx + 1) % altList.length;
                const currentAlt = altList[STATE.lastResultData.altIdx];
                STATE.lastResultData.answerText = currentAlt;
                const mainEl = (window.top.document || document).getElementById('ds-main-answer-text');
                if (mainEl) mainEl.innerText = currentAlt;
                if (targetInput && (targetInput.value || targetInput.innerText)) {
                    setNativeInputValue(targetInput, currentAlt);
                }
            };
        }

        if (ui.modelBtn) {
            ui.modelBtn.innerText = STATE.model === 'deepseek-reasoner' ? '🧠 当前R1' : '⚡ 当前V3';
            ui.modelBtn.onclick = () => {
                STATE.model = STATE.model === 'deepseek-chat' ? 'deepseek-reasoner' : 'deepseek-chat';
                GM_setValue('DEEPSEEK_MODEL', STATE.model);
                ui.modelBtn.innerText = STATE.model === 'deepseek-reasoner' ? '🧠 当前R1' : '⚡ 当前V3';
            };
        }

        if (autoExecute) {
            performScrollAndAutoClick(STATE.lastResultData);
        }
    }

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
