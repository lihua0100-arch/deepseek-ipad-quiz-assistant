// ==UserScript==
// @name         DeepSeek 智能题库助手 (iPad 学习通/U校园/全平台触屏通用版)
// @namespace    https://tampermonkey.net/
// @version      2.0.0
// @updateURL    https://raw.githubusercontent.com/lihua0100-arch/deepseek-ipad-quiz-assistant/main/deepseek-ipad-quiz-assistant.user.js
// @downloadURL  https://raw.githubusercontent.com/lihua0100-arch/deepseek-ipad-quiz-assistant/main/deepseek-ipad-quiz-assistant.user.js
// @description  专为 iPad Safari 打造（完美兼容 U校园AI版、学习通、超星、各类网课）：保留轻点悬浮球弹窗看答案、拖拽摆放与快捷键功能；新增长按悬浮球触发“高速涡轮旋转特效 + 页面平滑滚动定位 + 自动点击选中正确选项/自动填空中英文”功能。
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
        longPressDuration: 480    // 长按触发高速旋转与自动点选的毫秒阈值
    };

    // 保持脚本 @name、@namespace 和 GM 存储字段稳定，原位更新时沿用旧 Key 与模型设置。
    const STATE = {
        apiKey: GM_getValue('DEEPSEEK_API_KEY', ''),
        model: GM_getValue('DEEPSEEK_MODEL', 'deepseek-chat'),
        isAnalyzing: false,
        lastPickedScope: null,
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
            right: 18px;
            bottom: 85px;
            width: 50px;
            height: 50px;
            border-radius: 50%;
            background: rgba(15, 23, 42, 0.9);
            color: #38bdf8;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 4px 18px rgba(0, 0, 0, 0.35);
            border: 1.5px solid rgba(56, 189, 248, 0.35);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            z-index: 2147483647;
            touch-action: none;
            user-select: none;
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

        /* 长按触发：高速涡轮旋转特效 + 霓虹流光光环 */
        #ds-fab.ds-turbo-spin {
            border-color: #10b981 !important;
            background: radial-gradient(circle, rgba(6, 95, 70, 0.95) 0%, rgba(15, 23, 42, 0.95) 100%) !important;
            box-shadow: 0 0 24px rgba(16, 185, 129, 0.95), 0 0 48px rgba(56, 189, 248, 0.65) !important;
            animation: ds-spin-turbo 0.22s linear infinite !important;
        }
        @keyframes ds-spin-turbo {
            0% { transform: scale(1.12) rotate(0deg); }
            50% { transform: scale(1.18) rotate(180deg); }
            100% { transform: scale(1.12) rotate(360deg); }
        }

        /* 答案弹窗卡片 */
        #ds-card {
            position: fixed;
            right: 16px;
            bottom: 148px;
            width: 335px;
            max-width: calc(100vw - 32px);
            background: rgba(15, 23, 42, 0.94);
            color: #f8fafc;
            border-radius: 14px;
            border: 1px solid rgba(148, 163, 184, 0.3);
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
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
            background: rgba(30, 41, 59, 0.7);
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
            padding: 4px 8px;
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
            border-radius: 4px !important;
            box-shadow: 0 0 10px rgba(16, 185, 129, 0.45) !important;
            transition: all 0.25s ease !important;
        }
        .ds-auto-clicked-pulse {
            outline: 3px solid #34d399 !important;
            background-color: rgba(16, 185, 129, 0.28) !important;
            box-shadow: 0 0 22px rgba(16, 185, 129, 0.85) !important;
            transform: scale(1.01);
            transition: all 0.2s ease !important;
        }
        .ds-scope-flash {
            outline: 2px dashed rgba(16, 185, 129, 0.85) !important;
            outline-offset: 3px !important;
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

    if (isTopFrame) {
        fabEl = document.createElement('div');
        fabEl.id = 'ds-fab';
        fabEl.innerHTML = '🎯';
        fabEl.title = '轻点：显示答案 | 长按：高速旋转并自动滚动点选正确选项';
        document.body.appendChild(fabEl);

        cardEl = document.createElement('div');
        cardEl.id = 'ds-card';
        cardEl.innerHTML = `
            <div class="ds-card-header">
                <span class="ds-card-title">💡 DeepSeek 题库助手 2.0</span>
                <span class="ds-card-close" id="ds-card-close-btn">✕</span>
            </div>
            <div id="ds-card-content">
                <div style="color:#94a3b8;font-size:12px;">
                    • <b>轻点 🎯 悬浮球</b>：解析题目并弹窗显示答案<br>
                    • <b>长按 🎯 悬浮球 (0.5秒)</b>：触发<b>高速涡轮旋转</b>，自动平滑滚动页面并<b>自动点击正确选项</b>
                </div>
            </div>
            <div class="ds-card-actions" id="ds-card-footer" style="margin-top:6px;display:none;">
                <button class="ds-btn ds-btn-fill" id="ds-btn-autofill">⚡ 滚屏并自动点选/填入</button>
                <button class="ds-btn" id="ds-btn-alt-cycle">🔄 切换备选</button>
                <button class="ds-btn" id="ds-btn-switch-model">🧠 切R1/V3</button>
            </div>
        `;
        document.body.appendChild(cardEl);

        document.getElementById('ds-card-close-btn').addEventListener('click', () => {
            cardEl.style.display = 'none';
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
            if (Math.hypot(dx, dy) > 8) {
                hasMoved = true;
                clearLongPressTimer();
                const newLeft = Math.max(10, Math.min(window.innerWidth - 58, initialLeft + dx));
                const newTop = Math.max(10, Math.min(window.innerHeight - 58, initialTop + dy));
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

        // 触摸事件 (iPad / iPhone)
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

        window.addEventListener('touchend', () => {
            onPointerEnd();
        });

        window.addEventListener('touchcancel', () => {
            onPointerEnd();
        });

        // 鼠标事件 (Mac / Win 桌面端兼容)
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

        window.addEventListener('mouseup', () => {
            onPointerEnd();
        });

        // 轻点事件（仅在未移动且未触发长按涡轮时执行普通解析）
        fabEl.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (hasMoved || longPressTriggered) return;
            triggerAnalysis({ autoExecute: false });
        });
    }

    // 记录用户在页面上最近触摸或点击的题目位置
    window.addEventListener('mousemove', (e) => {
        STATE.lastMousePos.x = e.clientX;
        STATE.lastMousePos.y = e.clientY;
        if (STATE.pickerMode) {
            updatePickerHighlight(e.clientX, e.clientY);
        }
    }, { passive: true });

    window.addEventListener('click', (e) => {
        const hit = e.target;
        if (hit && (!fabEl || !fabEl.contains(hit)) && (!cardEl || !cardEl.contains(hit))) {
            STATE.lastPickedScope = hit;
            STATE.lastTouchTime = Date.now();
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
        if (hit && (!fabEl || !fabEl.contains(hit)) && (!cardEl || !cardEl.contains(hit))) {
            STATE.lastPickedScope = hit;
            STATE.lastTouchTime = Date.now();
            if (e.touches[0]) {
                STATE.lastMousePos.x = e.touches[0].clientX;
                STATE.lastMousePos.y = e.touches[0].clientY;
            }
        }
    }, { passive: true });

    /********************************************************************
     * 4. 长按悬浮球：高速涡轮旋转特效 + 页面平滑滚动 + 自动点击正确选项
     ********************************************************************/
    function startTurboSpinEffect() {
        if (!fabEl) return;
        fabEl.classList.remove('ds-loading');
        fabEl.classList.add('ds-turbo-spin');
        fabEl.innerHTML = '⚡';
    }

    function stopTurboSpinEffect() {
        if (!fabEl) return;
        fabEl.classList.remove('ds-turbo-spin');
        fabEl.classList.remove('ds-loading');
        fabEl.innerHTML = '🎯';
    }

    // 模拟真实触屏/鼠标点击事件链，确保 U校园(React/AntD)、学习通(超星) 等框架 100% 响应选中
    function simulateRealOptionClick(optionEl) {
        if (!optionEl) return;

        // 寻找内部最适合触发选中的可交互子节点（如 radio/checkbox input、label 或选项主体）
        const innerTarget = optionEl.querySelector(
            'input[type="radio"], input[type="checkbox"], .ant-radio-input, .ant-checkbox-input, .ans-radio, .ans-checkbox, label, a, button'
        ) || optionEl;

        const rect = innerTarget.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;

        const eventInit = {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: cx,
            clientY: cy
        };

        innerTarget.dispatchEvent(new PointerEvent('pointerdown', eventInit));
        innerTarget.dispatchEvent(new MouseEvent('mousedown', eventInit));
        innerTarget.dispatchEvent(new PointerEvent('pointerup', eventInit));
        innerTarget.dispatchEvent(new MouseEvent('mouseup', eventInit));
        innerTarget.click();

        // 若内部有 input 但点击在了外层容器，确保外层 optionEl 也收到 click
        if (innerTarget !== optionEl) {
            optionEl.click();
        }

        optionEl.classList.add('ds-auto-clicked-pulse');
        setTimeout(() => {
            optionEl.classList.remove('ds-auto-clicked-pulse');
        }, 1200);
    }

    // 执行“平滑滚动至正确选项 + 自动点击选中（或填空自动填入）”
    function performScrollAndAutoClick(resultData) {
        if (!resultData) return;
        const { matchedOptions, targetInput, answerText } = resultData;

        // 情况 A：选择题（单选或多选） -> 平滑滚动到正确选项并依次自动点击
        if (matchedOptions && matchedOptions.length > 0) {
            matchedOptions.forEach((optObj, idx) => {
                setTimeout(() => {
                    const el = optObj.el;
                    if (!el || !document.body.contains(el)) return;

                    // 1. 页面平滑滚动将该选项居中展现
                    try {
                        el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
                    } catch (_) {
                        el.scrollIntoView();
                    }

                    // 2. 等待滚动动画到位后自动点击该选项
                    setTimeout(() => {
                        simulateRealOptionClick(el);
                        if (idx === matchedOptions.length - 1) {
                            setTimeout(stopTurboSpinEffect, 350);
                        }
                    }, 380);
                }, idx * 520);
            });
            return;
        }

        // 情况 B：填空题 / 翻译题 / 简答题 -> 平滑滚动到输入框并自动填入答案
        if (targetInput && answerText) {
            try {
                targetInput.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
            } catch (_) {
                targetInput.scrollIntoView();
            }

            setTimeout(() => {
                targetInput.focus();
                setNativeInputValue(targetInput, answerText);
                targetInput.classList.add('ds-correct-highlight', 'ds-auto-clicked-pulse');
                setTimeout(() => {
                    targetInput.classList.remove('ds-auto-clicked-pulse');
                    stopTurboSpinEffect();
                }, 600);
            }, 380);
            return;
        }

        // 若页面无可点击元素，停止旋转
        setTimeout(stopTurboSpinEffect, 500);
    }

    // 长按悬浮球主入口
    function handleLongPressTurboAction() {
        startTurboSpinEffect();

        // 如果之前已经解析出当前题目的结果，且用户自上次解析后没有点击新题目，则直接高速旋转并滚屏点击！
        if (
            STATE.lastResultData &&
            STATE.lastResultData.timestamp > STATE.lastTouchTime &&
            ((STATE.lastResultData.matchedOptions && STATE.lastResultData.matchedOptions.length > 0) ||
             STATE.lastResultData.targetInput)
        ) {
            if (cardEl) cardEl.style.display = 'block';
            performScrollAndAutoClick(STATE.lastResultData);
            return;
        }

        // 否则立即发起 DeepSeek 解析，并在解析返回后自动执行滚屏与点选！
        triggerAnalysis({ autoExecute: true });
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
            if (cardEl && cardEl.style.display !== 'none') {
                cardEl.style.display = 'none';
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
     * 6. 核心选题算法：U校园 + 学习通 + 通用题库
     ********************************************************************/
    function isEditable(el) {
        if (!el) return false;
        const tag = el.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable ||
               el.getAttribute?.('role') === 'textbox' || el.classList?.contains('edui-body-container');
    }

    const CONTAINER_SELECTORS = [
        '.question-common-abs-reply', '.question-inputbox',
        '[class*="question-wrapper"]', '[class*="question-container"]', '[class*="exercise-item"]',
        '.TiMu', '.singleQuesId', '.questionLi', '.padBom50', '.font-cxsecret',
        '.question-item', '.question-box', '.question-card', '.exam-item',
        '.subject-item', '.q-item', '.ti-item', '.problem-item',
        '[class*="question"]', '[class*="subject"]', '[class*="topic"]',
        'fieldset', 'article', 'li'
    ];

    const OPTION_SELECTORS = [
        '.ant-radio-wrapper', '.ant-checkbox-wrapper', '[class*="radio-item"]', '[class*="checkbox-item"]',
        '[class*="option-wrap"]', '[class*="option-item"]', '[class*="optionItem"]', '[class*="choice-item"]',
        '.single_choice li', '.multi_choice li', '.true_false li', '.answerList li', '.marBom6', '.ul-list li',
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
        const selectionText = window.getSelection()?.toString().trim();
        if (selectionText && selectionText.length >= 2) {
            return { scopeEl: document.body, customText: selectionText, targetInput: null };
        }

        if (explicitScope) {
            return { scopeEl: explicitScope, customText: null, targetInput: explicitScope.querySelector('input, textarea, [contenteditable="true"]') };
        }

        const hitUnderMouse = document.elementFromPoint(STATE.lastMousePos.x, STATE.lastMousePos.y);
        let curr = (STATE.lastPickedScope && document.body.contains(STATE.lastPickedScope))
            ? STATE.lastPickedScope
            : (hitUnderMouse || document.activeElement);

        if (curr && (curr === fabEl || fabEl?.contains(curr) || curr === cardEl || cardEl?.contains(curr))) {
            curr = document.activeElement;
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
        while (curr && curr !== document.body && depth < 12) {
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
        const hit = document.elementFromPoint(x, y);
        if (!hit || hit === fabEl || hit === cardEl || cardEl?.contains(hit)) return;

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
        setTimeout(() => el.classList.remove('ds-scope-flash'), 700);
    }

    /********************************************************************
     * 7. API 解析与浮窗结果呈现（支持 autoExecute 长按自动滚屏点选）
     ********************************************************************/
    function triggerAnalysis({ explicitScope = null, autoExecute = false } = {}) {
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

        // 提取选项（支持穿透同源子 iframe 与启发式 A/B/C/D 识别）
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

        if (cardEl) cardEl.style.display = 'block';
        const contentBox = document.getElementById('ds-card-content');
        const footerBox = document.getElementById('ds-card-footer');
        if (footerBox) footerBox.style.display = 'none';

        if (contentBox) {
            contentBox.innerHTML = `
                <div style="display:flex;align-items:center;gap:8px;color:${autoExecute ? '#10b981' : '#38bdf8'};">
                    <span>${autoExecute ? '⚡' : '⏳'}</span>
                    <span>${autoExecute
                        ? `<b>涡轮自动点选模式</b>：正在解析并定位正确选项...`
                        : `正在使用 <b>${STATE.model === 'deepseek-reasoner' ? 'R1推理' : 'V3'}</b> 解析题目...`}</span>
                </div>
                <div style="font-size:11px;color:#64748b;margin-top:4px;">题目：${escapeHtml(questionText.slice(0, 36))}...</div>
            `;
        }

        if (autoExecute) {
            startTurboSpinEffect();
        } else if (fabEl) {
            fabEl.classList.add('ds-loading');
        }

        STATE.isAnalyzing = true;

        const systemPrompt = [
            '你是一个专为 iPad/Mac 学习通、超星、U校园等多平台打造的高精度解题助手。',
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
                if (!autoExecute && fabEl) fabEl.classList.remove('ds-loading');
                try {
                    if (res.status !== 200) {
                        stopTurboSpinEffect();
                        if (contentBox) contentBox.innerHTML = `<div style="color:#ef4444;">❌ 请求失败 (HTTP ${res.status})，请检查 API Key</div>`;
                        return;
                    }
                    const data = JSON.parse(res.responseText);
                    const rawContent = data.choices?.[0]?.message?.content || '{}';
                    const cleaned = rawContent.replace(/```json|```/gi, '').trim();
                    const firstBrace = cleaned.indexOf('{');
                    const lastBrace = cleaned.lastIndexOf('}');
                    const parsed = JSON.parse(firstBrace !== -1 ? cleaned.slice(firstBrace, lastBrace + 1) : cleaned);

                    renderResult(parsed, options, targetInput, autoExecute);
                } catch (err) {
                    stopTurboSpinEffect();
                    console.error(err);
                    if (contentBox) contentBox.innerHTML = `<div style="color:#ef4444;">❌ 解析响应失败，请重试</div>`;
                }
            },
            onerror: () => {
                STATE.isAnalyzing = false;
                stopTurboSpinEffect();
                if (contentBox) contentBox.innerHTML = `<div style="color:#ef4444;">❌ 网络请求失败，请检查网络连接</div>`;
            }
        });
    }

    function renderResult(parsed, options, targetInput, autoExecute = false) {
        const contentBox = document.getElementById('ds-card-content');
        const footerBox = document.getElementById('ds-card-footer');

        document.querySelectorAll('.ds-correct-highlight').forEach(el => el.classList.remove('ds-correct-highlight'));

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
                const fallbackOpt = options.find(o => o.text.includes(parsed.answer) || parsed.answer.includes(o.text));
                if (fallbackOpt) matchedOptions.push(fallbackOpt);
            }

            matchedOptions.forEach(opt => {
                opt.el.classList.add('ds-correct-highlight');
            });

            if (!autoExecute && matchedOptions[0]) {
                try {
                    matchedOptions[0].el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                } catch (_) {}
            }
        }

        const answerText = parsed.answer || matchedOptions.map(o => o.text).join(' / ') || '已锁定';
        const typeLabel = parsed.questionType === 'translate' ? '英文译文'
            : (parsed.questionType === 'choice' || options.length > 0) ? (autoExecute ? '⚡ 已自动滚屏并点选正确项' : '正确选项')
            : parsed.questionType === 'essay' ? '简答答案' : '填空答案';

        STATE.lastResultData = {
            parsed,
            targetInput,
            options,
            matchedOptions,
            answerText,
            altIdx: 0,
            timestamp: Date.now()
        };

        if (contentBox) {
            contentBox.innerHTML = `
                <div class="ds-answer-box">
                    <div style="font-size:11px;color:#94a3b8;margin-bottom:2px;">${typeLabel}</div>
                    <div class="ds-answer-main" id="ds-main-answer-text">${escapeHtml(answerText)}</div>
                    ${parsed.reason ? `<div class="ds-answer-sub">${escapeHtml(parsed.reason)}</div>` : ''}
                </div>
            `;
        }

        if (footerBox) footerBox.style.display = 'flex';

        const fillBtn = document.getElementById('ds-btn-autofill');
        const altBtn = document.getElementById('ds-btn-alt-cycle');
        const modelBtn = document.getElementById('ds-btn-switch-model');

        if (fillBtn) {
            const canAutoAct = matchedOptions.length > 0 || Boolean(targetInput);
            fillBtn.style.display = canAutoAct ? 'inline-flex' : 'none';
            fillBtn.innerText = matchedOptions.length > 0 ? '⚡ 滚屏并自动点选' : '✍️ 填入当前格';
            fillBtn.onclick = () => {
                startTurboSpinEffect();
                performScrollAndAutoClick(STATE.lastResultData);
                fillBtn.innerText = '✅ 已执行';
                setTimeout(() => {
                    fillBtn.innerText = matchedOptions.length > 0 ? '⚡ 滚屏并自动点选' : '✍️ 填入当前格';
                }, 1500);
            };
        }

        const altList = [answerText, ...(parsed.altAnswers || [])].filter(Boolean);
        if (altBtn) {
            altBtn.style.display = altList.length > 1 ? 'inline-flex' : 'none';
            altBtn.onclick = () => {
                STATE.lastResultData.altIdx = (STATE.lastResultData.altIdx + 1) % altList.length;
                const currentAlt = altList[STATE.lastResultData.altIdx];
                STATE.lastResultData.answerText = currentAlt;
                const mainEl = document.getElementById('ds-main-answer-text');
                if (mainEl) mainEl.innerText = currentAlt;
                if (targetInput && (targetInput.value || targetInput.innerText)) {
                    setNativeInputValue(targetInput, currentAlt);
                }
            };
        }

        if (modelBtn) {
            modelBtn.innerText = STATE.model === 'deepseek-reasoner' ? '🧠 当前R1' : '⚡ 当前V3';
            modelBtn.onclick = () => {
                STATE.model = STATE.model === 'deepseek-chat' ? 'deepseek-reasoner' : 'deepseek-chat';
                GM_setValue('DEEPSEEK_MODEL', STATE.model);
                modelBtn.innerText = STATE.model === 'deepseek-reasoner' ? '🧠 当前R1' : '⚡ 当前V3';
            };
        }

        // 若是长按触发的涡轮自动执行模式，立即平滑滚动页面并自动点击正确选项！
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
