// ==UserScript==
// @name         DeepSeek 智能题库助手 (iPad 学习通/U校园/全平台触屏通用版)
// @namespace    https://tampermonkey.net/
// @version      1.1.0
// @updateURL    https://raw.githubusercontent.com/lihua0100-arch/deepseek-ipad-quiz-assistant/main/deepseek-ipad-quiz-assistant.user.js
// @downloadURL  https://raw.githubusercontent.com/lihua0100-arch/deepseek-ipad-quiz-assistant/main/deepseek-ipad-quiz-assistant.user.js
// @description  专为 iPad Safari 打造（学习通、超星尔雅、U校园、知到智慧树、雨课堂、高校外语教学平台）：穿透嵌套 iframe 与内联富文本编辑框，拖动悬浮球一键分析，直接浮窗显示答案、高亮选项及一键填入。
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

    // 过滤掉面积极小的统计、广告类无用 iframe
    if (window.self !== window.top && (window.innerWidth < 120 || window.innerHeight < 80)) {
        return;
    }

    /********************************************************************
     * 1. 配置参数与跨 iframe 消息通信
     ********************************************************************/
    const CONFIG = {
        apiUrl: 'https://api.deepseek.com/chat/completions'
    };

    const STATE = {
        apiKey: GM_getValue('DEEPSEEK_API_KEY', ''),
        model: GM_getValue('DEEPSEEK_MODEL', 'deepseek-chat'),
        isAnalyzing: false,
        lastPickedScope: null,
        lastResultData: null
    };

    /********************************************************************
     * 2. iPad 原生触屏悬浮球与卡片 UI 构建 (仅在顶层窗口或主做题窗口渲染)
     ********************************************************************/
    const isTopFrame = window.self === window.top;

    const styleEl = document.createElement('style');
    styleEl.textContent = `
        /* 强破学习通/考试页面禁止选中文字与禁止长按复制的限制 */
        html, body, body * {
            -webkit-user-select: text !important;
            user-select: text !important;
            -webkit-touch-callout: default !important;
        }

        #ds-ipad-fab {
            position: fixed;
            right: 18px;
            bottom: 85px;
            width: 48px;
            height: 48px;
            border-radius: 50%;
            background: rgba(15, 23, 42, 0.88);
            color: #38bdf8;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 4px 18px rgba(0, 0, 0, 0.35);
            border: 1px solid rgba(255, 255, 255, 0.2);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            z-index: 2147483647;
            touch-action: none;
            user-select: none;
            -webkit-tap-highlight-color: transparent;
            font-size: 20px;
            cursor: pointer;
            transition: transform 0.15s ease, opacity 0.2s ease;
        }
        #ds-ipad-fab:active {
            transform: scale(0.92);
        }
        #ds-ipad-fab.ds-loading {
            animation: ds-spin 1.2s linear infinite;
        }
        @keyframes ds-spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }

        #ds-ipad-card {
            position: fixed;
            right: 16px;
            bottom: 145px;
            width: 320px;
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

        /* 学习通与各类题库通用选项高亮 */
        .ds-ipad-correct-highlight {
            outline: 2px solid #10b981 !important;
            background-color: rgba(16, 185, 129, 0.14) !important;
            outline-offset: 2px !important;
            border-radius: 4px !important;
            box-shadow: 0 0 8px rgba(16, 185, 129, 0.4) !important;
        }
    `;
    document.head.appendChild(styleEl);

    let fabEl = null;
    let cardEl = null;

    if (isTopFrame) {
        fabEl = document.createElement('div');
        fabEl.id = 'ds-ipad-fab';
        fabEl.innerHTML = '🎯';
        fabEl.title = '点击解析当前选中或触摸的题目';
        document.body.appendChild(fabEl);

        cardEl = document.createElement('div');
        cardEl.id = 'ds-ipad-card';
        cardEl.innerHTML = `
            <div class="ds-card-header">
                <span class="ds-card-title">💡 DeepSeek 答案</span>
                <span class="ds-card-close" id="ds-card-close-btn">✕</span>
            </div>
            <div id="ds-card-content">
                <div style="color:#94a3b8;font-size:12px;">点击题目、选项、填空横线或选中文字，然后轻点右下角 <b>🎯 悬浮球</b> 查看答案。</div>
            </div>
            <div class="ds-card-actions" id="ds-card-footer" style="margin-top:6px;display:none;">
                <button class="ds-btn ds-btn-fill" id="ds-btn-autofill">✍️ 填入当前格</button>
                <button class="ds-btn" id="ds-btn-alt-cycle">🔄 切换备选</button>
                <button class="ds-btn" id="ds-btn-switch-model">🧠 切R1/V3</button>
            </div>
        `;
        document.body.appendChild(cardEl);

        document.getElementById('ds-card-close-btn').addEventListener('click', () => {
            cardEl.style.display = 'none';
        });

        // 悬浮球拖拽处理
        let isDragging = false;
        let startX = 0, startY = 0;
        let initialLeft = 0, initialTop = 0;
        let hasMoved = false;

        fabEl.addEventListener('touchstart', (e) => {
            const touch = e.touches[0];
            isDragging = true;
            hasMoved = false;
            startX = touch.clientX;
            startY = touch.clientY;
            const rect = fabEl.getBoundingClientRect();
            initialLeft = rect.left;
            initialTop = rect.top;
        }, { passive: true });

        window.addEventListener('touchmove', (e) => {
            if (!isDragging) return;
            const touch = e.touches[0];
            const dx = touch.clientX - startX;
            const dy = touch.clientY - startY;
            if (Math.hypot(dx, dy) > 6) {
                hasMoved = true;
                const newLeft = Math.max(10, Math.min(window.innerWidth - 58, initialLeft + dx));
                const newTop = Math.max(10, Math.min(window.innerHeight - 58, initialTop + dy));
                fabEl.style.left = `${newLeft}px`;
                fabEl.style.top = `${newTop}px`;
                fabEl.style.right = 'auto';
                fabEl.style.bottom = 'auto';
            }
        }, { passive: true });

        window.addEventListener('touchend', () => {
            isDragging = false;
        });

        fabEl.addEventListener('click', () => {
            if (hasMoved) return;
            handleFabClick();
        });
    }

    // 跨 iframe 触摸监听：用户在 iframe 内触摸点击题目时，告知主窗口记录位置
    window.addEventListener('touchstart', (e) => {
        const hit = e.target;
        if (hit && (!fabEl || !fabEl.contains(hit)) && (!cardEl || !cardEl.contains(hit))) {
            STATE.lastPickedScope = hit;
        }
    }, { passive: true });

    /********************************************************************
     * 3. 学习通 (超星) 与 U校园等多平台特征选择器与提取引擎
     ********************************************************************/
    function isEditable(el) {
        if (!el) return false;
        const tag = el.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable ||
               el.getAttribute?.('role') === 'textbox' || el.classList.contains('edui-body-container');
    }

    // 识别学习通与主流题库各类选项节点
    const LEARNING_TONG_OPTION_SELECTORS = [
        // 学习通专属选择器
        '.single_choice li', '.multi_choice li', '.true_false li',
        '.answerList li', '.answerBg', '.ans-checkbox', '.ans-radio',
        '.marBom6', '.ul-list li', '.clearfix li',
        // U校园与其他题库通用选择器
        '.option', '.options li', '.question-option', '.answer-item',
        '.el-radio', '.el-checkbox', '.ant-radio-wrapper', '.ant-checkbox-wrapper',
        'label', 'li[role="option"]', 'div[role="radio"]', 'div[role="checkbox"]',
        '[class*="option-item"]', '[class*="optionItem"]'
    ];

    // 识别学习通与主流题库单题外层容器
    const LEARNING_TONG_CONTAINER_SELECTORS = [
        // 学习通专项
        '.TiMu', '.singleQuesId', '.questionLi', '.padBom50', '.font-cxsecret',
        // U校园与其他平台通用
        '.question-item', '.question-box', '.question-card', '.exam-item',
        '.subject-item', '.q-item', '.ti-item', '.problem-item',
        '[class*="question"]', '[class*="subject"]', '[class*="topic"]',
        'fieldset', 'article', 'li'
    ];

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

        // 学习通特殊字体混淆/图标文本过滤
        clone.querySelectorAll('style, script, .ans-icon, .font-cxsecret-ignore').forEach(el => el.remove());

        return (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim();
    }

    // 穿透子 iframe 深度提取题目
    function deepQueryInIframes(selector, root = document) {
        let list = Array.from(root.querySelectorAll(selector));
        root.querySelectorAll('iframe').forEach(ifr => {
            try {
                if (ifr.contentDocument) {
                    list.push(...deepQueryInIframes(selector, ifr.contentDocument));
                }
            } catch (_) {}
        });
        return list;
    }

    function findQuestionScope(clickedEl) {
        const selectionText = window.getSelection()?.toString().trim();
        if (selectionText && selectionText.length >= 2) {
            return { scopeEl: document.body, customText: selectionText, targetInput: null };
        }

        let curr = clickedEl || document.activeElement;
        let targetInput = null;

        if (isEditable(curr)) {
            targetInput = curr;
        }

        // 沿 DOM 向上寻找包含当前点击元素的最小题块容器
        let depth = 0;
        let bestScope = curr;
        while (curr && curr !== document.body && depth < 12) {
            const isMatchedContainer = LEARNING_TONG_CONTAINER_SELECTORS.some(sel => {
                try { return curr.matches && curr.matches(sel); } catch (_) { return false; }
            });

            const inputs = Array.from(curr.querySelectorAll('input:not([type="hidden"]), textarea, [contenteditable="true"]'));
            const options = Array.from(curr.querySelectorAll(LEARNING_TONG_OPTION_SELECTORS.join(',')));

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

    function extractScrollContext(scopeRoot, targetInput) {
        let curr = scopeRoot || targetInput;
        let container = null;
        while (curr && curr !== document.body) {
            const textLen = (curr.innerText || '').length;
            if (textLen >= 120 && textLen <= 4000) {
                container = curr;
            }
            curr = curr.parentElement;
        }
        return container ? extractRichTextWithBlanks(container, targetInput) : '';
    }

    /********************************************************************
     * 4. 触发解析与浮窗结果渲染
     ********************************************************************/
    function handleFabClick() {
        if (!STATE.apiKey) {
            const key = prompt('请输入您的 DeepSeek API Key (sk-...):', '');
            if (key) {
                STATE.apiKey = key.trim();
                GM_setValue('DEEPSEEK_API_KEY', STATE.apiKey);
            } else {
                return;
            }
        }

        if (STATE.isAnalyzing) return;

        const { scopeEl, customText, targetInput } = findQuestionScope(STATE.lastPickedScope);
        const questionText = customText || extractRichTextWithBlanks(scopeEl, targetInput);
        const fullContext = extractScrollContext(scopeEl, targetInput);

        // 提取候选选项（兼容学习通与 U 校园各种 DOM）
        const rawOptions = Array.from(scopeEl.querySelectorAll(LEARNING_TONG_OPTION_SELECTORS.join(',')));
        const options = [];
        const seenTexts = new Set();
        for (const el of rawOptions) {
            const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
            if (t.length >= 1 && t.length <= 260 && !seenTexts.has(t)) {
                // 避免父子嵌套
                const isParent = rawOptions.some(other => other !== el && el.contains(other));
                if (!isParent) {
                    seenTexts.add(t);
                    options.push({ el, text: t });
                }
            }
            if (options.length >= 8) break;
        }

        cardEl.style.display = 'block';
        const contentBox = document.getElementById('ds-card-content');
        const footerBox = document.getElementById('ds-card-footer');
        footerBox.style.display = 'none';

        contentBox.innerHTML = `
            <div style="display:flex;align-items:center;gap:8px;color:#38bdf8;">
                <span class="ds-loading">⏳</span>
                <span>正在使用 <b>${STATE.model === 'deepseek-reasoner' ? 'R1推理' : 'V3'}</b> 解析当前题目...</span>
            </div>
            <div style="font-size:11px;color:#64748b;margin-top:4px;">题目：${escapeHtml(questionText.slice(0, 32))}...</div>
        `;
        fabEl.classList.add('ds-loading');
        STATE.isAnalyzing = true;

        const systemPrompt = [
            '你是一个专为手机与iPad移动端打造的高精度题库解析助手，支持学习通、超星尔雅、U校园等各大平台。',
            '请根据提供的题目文本、选项及上下文分析答案，直接返回纯净 JSON 格式（不要包含任何 Markdown 代码块标签）：',
            '{',
            '  "questionType": "choice" 或 "input" 或 "translate" 或 "essay",',
            '  "bestIndex": 选项的数字编号(从0开始，若为选择题),',
            '  "answer": "必须填入或选中的最核心纯净答案",',
            '  "altAnswers": ["备选格式/等价词1", "备选格式2"],',
            '  "reason": "1~2句简短解析或中文翻译"',
            '}'
        ].join('\n');

        const userPrompt = [
            fullContext ? `【题组上下文与词库背景】：\n${fullContext}` : '',
            `【题目内容】：\n${questionText}`,
            options.length > 0 ? `【候选选项】：\n${options.map((o, i) => `[${i}] ${o.text}`).join('\n')}` : '',
            targetInput ? `【目标填空输入框当前框内值】："${targetInput.value || ''}"` : ''
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
                fabEl.classList.remove('ds-loading');
                try {
                    if (res.status !== 200) {
                        contentBox.innerHTML = `<div style="color:#ef4444;">❌ 请求失败 (HTTP ${res.status})，请检查 API Key</div>`;
                        return;
                    }
                    const data = JSON.parse(res.responseText);
                    const rawContent = data.choices?.[0]?.message?.content || '{}';
                    const parsed = JSON.parse(rawContent.replace(/```json|```/gi, '').trim());

                    renderResultOnCard(parsed, options, targetInput);
                } catch (err) {
                    console.error(err);
                    contentBox.innerHTML = `<div style="color:#ef4444;">❌ 解析响应数据失败，请重试</div>`;
                }
            },
            onerror: () => {
                STATE.isAnalyzing = false;
                fabEl.classList.remove('ds-loading');
                contentBox.innerHTML = `<div style="color:#ef4444;">❌ 网络请求失败，请检查网络连接</div>`;
            }
        });
    }

    function renderResultOnCard(parsed, options, targetInput) {
        const contentBox = document.getElementById('ds-card-content');
        const footerBox = document.getElementById('ds-card-footer');
        STATE.lastResultData = { parsed, targetInput, options, altIdx: 0 };

        document.querySelectorAll('.ds-ipad-correct-highlight').forEach(el => el.classList.remove('ds-ipad-correct-highlight'));

        let matchedOptionText = '';
        if (options.length > 0) {
            let bestOption = null;
            if (parsed.bestIndex !== undefined && options[parsed.bestIndex]) {
                bestOption = options[parsed.bestIndex];
            } else if (parsed.answer) {
                bestOption = options.find(o => o.text.includes(parsed.answer) || parsed.answer.includes(o.text));
            }

            if (bestOption) {
                bestOption.el.classList.add('ds-ipad-correct-highlight');
                matchedOptionText = bestOption.text;
                // 平滑轻微滚动，确保正确选项在可视区内
                bestOption.el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        }

        const answerText = parsed.answer || matchedOptionText || '已锁定';
        const typeLabel = parsed.questionType === 'translate' ? '英文译文'
            : (parsed.questionType === 'choice' || options.length > 0) ? '正确选项'
            : parsed.questionType === 'essay' ? '简答答案' : '填空答案';

        contentBox.innerHTML = `
            <div class="ds-answer-box">
                <div style="font-size:11px;color:#94a3b8;margin-bottom:2px;">${typeLabel}</div>
                <div class="ds-answer-main" id="ds-main-answer-text">${escapeHtml(answerText)}</div>
                ${parsed.reason ? `<div class="ds-answer-sub">${escapeHtml(parsed.reason)}</div>` : ''}
            </div>
        `;

        footerBox.style.display = 'flex';

        const fillBtn = document.getElementById('ds-btn-autofill');
        const altBtn = document.getElementById('ds-btn-alt-cycle');
        const modelBtn = document.getElementById('ds-btn-switch-model');

        fillBtn.style.display = targetInput ? 'inline-flex' : 'none';
        fillBtn.onclick = () => {
            if (targetInput) {
                targetInput.focus();
                setNativeInputValue(targetInput, answerText);
                targetInput.classList.add('ds-ipad-correct-highlight');
                fillBtn.innerText = '✅ 已填入';
                setTimeout(() => { fillBtn.innerText = '✍️ 填入当前格'; }, 1500);
            }
        };

        const altList = [answerText, ...(parsed.altAnswers || [])].filter(Boolean);
        altBtn.style.display = altList.length > 1 ? 'inline-flex' : 'none';
        altBtn.onclick = () => {
            STATE.lastResultData.altIdx = (STATE.lastResultData.altIdx + 1) % altList.length;
            const currentAlt = altList[STATE.lastResultData.altIdx];
            document.getElementById('ds-main-answer-text').innerText = currentAlt;
            if (targetInput && targetInput.value) {
                setNativeInputValue(targetInput, currentAlt);
            }
        };

        modelBtn.onclick = () => {
            STATE.model = STATE.model === 'deepseek-chat' ? 'deepseek-reasoner' : 'deepseek-chat';
            GM_setValue('DEEPSEEK_MODEL', STATE.model);
            modelBtn.innerText = STATE.model === 'deepseek-reasoner' ? '🧠 当前R1' : '⚡ 当前V3';
        };
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