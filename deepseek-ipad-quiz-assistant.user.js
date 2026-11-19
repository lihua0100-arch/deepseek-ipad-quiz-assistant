// ==UserScript==
// @name    DeepSeek 智能题库助手 (iPad 学习通/U校园/全平台触屏通用版)
// @namespace    https://tampermonkey.net/
// @version      3.7.0
// @updateURL    https://raw.githubusercontent.com/lihua0100-arch/deepseek-ipad-quiz-assistant/main/deepseek-ipad-quiz-assistant.user.js
// @downloadURL  https://raw.githubusercontent.com/lihua0100-arch/deepseek-ipad-quiz-assistant/main/deepseek-ipad-quiz-assistant.user.js
// @description  全题型准确率优先旗舰版（适配手机 / iPad Safari Stay / Tampermonkey，支持学习通、U校园、超星尔雅、雨课堂、智慧树）：1.全面支持选择题（单/多/判断）、填空题（多空顺序自动填入+富文本自动保存）、大题（简答/计算/证明/论述完整分步解答+一键复制/填入，含无输入框拍照题）；2.默认全题 DeepSeek-R1 深度推理+高数反向验算；3.无损提取 KaTeX/MathJax/MathML/上下标/公式图片，限速联网搜题+会话缓存彻底消除单题与连刷不一致！
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
    const IS_MOBILE_UA = /Android|webOS|iPhone|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(navigator.userAgent);

    function isCompactViewport() {
        try {
            return (window.top.innerWidth || window.innerWidth) <= 640 || (IS_MOBILE_UA && (window.top.innerWidth || window.innerWidth) <= 768);
        } catch (_) {
            return window.innerWidth <= 640;
        }
    }

    /********************************************************************
     * 1. 配置参数与全局状态（保留原有 Key 与本地题库兼容性）
     ********************************************************************/
    const CONFIG = {
        apiUrl: 'https://api.deepseek.com/chat/completions',
        longPressDuration: 520,
        concurrencyChat: 4,       // V3 并发数
        concurrencyReasoner: 3,   // R1 深度推理并发数（稳健防限流，优先保证准确率）
        searchConcurrency: 2,     // 联网搜题独立限速并发数（防止 12 并发被 Bing/百度封杀导致单题与连刷不一致）
        searchIntervalMs: 180,    // 联网搜题错峰间隔
        searchTimeoutMs: 4200,    // 联网搜索超时（毫秒）
        chatTimeoutMs: 40000,     // V3 请求超时
        reasonerTimeoutMs: 110000,// R1 深度推理超时（高数/复杂题充裕验算时间）
        maxRetries: 2,            // 遇到 429 / 5xx / 网络波动自动重试次数
        autoEscalateThreshold: 0.85
    };

    const MODEL_MODES = ['deepseek-reasoner', 'auto', 'deepseek-chat'];

    function loadSavedModelMode() {
        const v36 = GM_getValue('DEEPSEEK_MODEL_V36', '');
        if (MODEL_MODES.includes(v36)) return v36;
        return 'deepseek-reasoner'; // v3.6 准确率优先：默认全题走 R1 深度推理 + 联网核对
    }

    const STATE = {
        apiKey: GM_getValue('DEEPSEEK_API_KEY', ''),
        modelMode: loadSavedModelMode(),
        webSearchEnabled: GM_getValue('DEEPSEEK_WEB_SEARCH', true),
        verifiedBank: GM_getValue('DEEPSEEK_VERIFIED_BANK', {}),
        sessionCache: new Map(),  // 页面会话级结果缓存，保证单题与连刷 100% 一致
        searchCache: new Map(),   // 联网搜题结果缓存，避免重复搜索被限流
        logs: [],                 // 内置诊断日志
        isAnalyzing: false,
        isBatchRunning: false,
        stopBatchRequested: false,
        lastPickedScope: null,
        lastSingleContext: null,
        lastMousePos: { x: window.innerWidth / 2, y: window.innerHeight / 2 }
    };

    function addLog(entry) {
        const now = new Date();
        const ts = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
        STATE.logs.unshift(Object.assign({ ts }, entry));
        if (STATE.logs.length > 120) STATE.logs.length = 120;
        const ui = getUIElements();
        if (ui.logPanel && ui.logPanel.classList.contains('ds-show')) {
            renderLogPanel();
        }
    }

    function getModelModeLabel(mode = STATE.modelMode) {
        if (mode === 'deepseek-reasoner') return '🔬 全题R1(最高准)';
        if (mode === 'auto') return '🧠 智能分流';
        return '⚡ V3极速';
    }

    // 统一清理平台干扰词（如学习通题干右侧的“AI讲解”按钮文字）
    function stripPlatformNoiseText(text) {
        return String(text || '')
            .replace(/\bAI\s*讲解/gi, ' ')
            .replace(/(?:查看解析|收藏本题|纠错|记笔记)\s*$/g, '')
            .replace(/[ \t\r\n]+/g, ' ')
            .trim();
    }

    // 新版题干归一化键：保留数学运算符号（+ - * / ^ = < > √ ∫ ∑ ∞），防止高数 f(x) 与 f(-x) 撞键
    function normalizeStemKey(text) {
        return stripPlatformNoiseText(text)
            .replace(/^\s*\d+[.、\s)）]*/, '')
            .replace(/[（(]\s*[单多判填简计算证明]选题?[^)）]*[)）]/g, '')
            .replace(/[\s_—，。；：？！、,.?;:!（）【】\[\]"'“”‘’$]/g, '')
            .slice(0, 100);
    }

    // 兼容 3.4 及以前版本的旧题库键，确保已记忆的满分题库无缝命中
    function normalizeLegacyStemKey(text) {
        return stripPlatformNoiseText(text)
            .replace(/^\s*\d+[.、\s)）]*/, '')
            .replace(/\([单多判填简]选题.*?\)/g, '')
            .replace(/[\s_—\-，。；：？！、,.?;:!()（）【】\[\]"'“”‘’]/g, '')
            .slice(0, 80);
    }

    function lookupVerifiedBank(bank, stemText) {
        if (!bank) return null;
        const kNew = normalizeStemKey(stemText);
        if (kNew && bank[kNew]) return bank[kNew];
        const kOld = normalizeLegacyStemKey(stemText);
        if (kOld && bank[kOld]) return bank[kOld];
        return null;
    }

    /********************************************************************
     * 2. 高等数学无损公式提取与题型识别引擎
     ********************************************************************/
    function mathmlToLatex(node) {
        if (!node) return '';
        if (node.nodeType === 3) {
            return (node.nodeValue || '').replace(/\s+/g, ' ');
        }
        if (node.nodeType !== 1) return '';

        const tag = (node.localName || node.tagName || '').toLowerCase();
        if (tag === 'annotation' || tag === 'annotation-xml') return '';

        if (tag === 'semantics') {
            const ann = node.querySelector('annotation[encoding*="tex"], annotation[encoding*="latex"]');
            if (ann && ann.textContent && ann.textContent.trim()) {
                return ann.textContent.trim();
            }
            return node.firstElementChild ? mathmlToLatex(node.firstElementChild) : '';
        }

        const kids = Array.from(node.children || []);
        const mapKids = () => Array.from(node.childNodes || []).map(mathmlToLatex).join('');

        switch (tag) {
            case 'math':
            case 'mrow':
            case 'mstyle':
            case 'mpadded':
            case 'mphantom':
                return mapKids();
            case 'mi':
            case 'mn':
            case 'mo':
            case 'mtext':
            case 'ms':
                return (node.textContent || '').trim();
            case 'mfrac': {
                const num = kids[0] ? mathmlToLatex(kids[0]).trim() : '';
                const den = kids[1] ? mathmlToLatex(kids[1]).trim() : '';
                return `\\frac{${num}}{${den}}`;
            }
            case 'msup': {
                const base = kids[0] ? mathmlToLatex(kids[0]).trim() : '';
                const exp = kids[1] ? mathmlToLatex(kids[1]).trim() : '';
                return `${base}^{${exp}}`;
            }
            case 'msub': {
                const base = kids[0] ? mathmlToLatex(kids[0]).trim() : '';
                const sub = kids[1] ? mathmlToLatex(kids[1]).trim() : '';
                return `${base}_{${sub}}`;
            }
            case 'msubsup': {
                const base = kids[0] ? mathmlToLatex(kids[0]).trim() : '';
                const sub = kids[1] ? mathmlToLatex(kids[1]).trim() : '';
                const sup = kids[2] ? mathmlToLatex(kids[2]).trim() : '';
                return `${base}_{${sub}}^{${sup}}`;
            }
            case 'msqrt':
                return `\\sqrt{${mapKids().trim()}}`;
            case 'mroot': {
                const rad = kids[0] ? mathmlToLatex(kids[0]).trim() : '';
                const idx = kids[1] ? mathmlToLatex(kids[1]).trim() : '';
                return `\\sqrt[${idx}]{${rad}}`;
            }
            case 'munder': {
                const base = kids[0] ? mathmlToLatex(kids[0]).trim() : '';
                const under = kids[1] ? mathmlToLatex(kids[1]).trim() : '';
                return `${base}_{${under}}`;
            }
            case 'mover': {
                const base = kids[0] ? mathmlToLatex(kids[0]).trim() : '';
                const over = kids[1] ? mathmlToLatex(kids[1]).trim() : '';
                if (/^[¯\-_]$/.test(over)) return `\\overline{${base}}`;
                if (/^[→⃗]$/.test(over)) return `\\vec{${base}}`;
                return `${base}^{${over}}`;
            }
            case 'munderover': {
                const base = kids[0] ? mathmlToLatex(kids[0]).trim() : '';
                const under = kids[1] ? mathmlToLatex(kids[1]).trim() : '';
                const over = kids[2] ? mathmlToLatex(kids[2]).trim() : '';
                return `${base}_{${under}}^{${over}}`;
            }
            case 'mfenced': {
                const open = node.getAttribute('open') ?? '(';
                const close = node.getAttribute('close') ?? ')';
                const sep = node.getAttribute('separators') ?? ',';
                return `${open}${kids.map(mathmlToLatex).join(sep)}${close}`;
            }
            case 'mtable': {
                const rows = kids.map(tr =>
                    Array.from(tr.children || []).map(td => mathmlToLatex(td).trim()).join(' & ')
                ).join(' \\\\ ');
                return `\\begin{matrix} ${rows} \\end{matrix}`;
            }
            default:
                return mapKids();
        }
    }

    function extractFormulaFromImg(imgEl) {
        if (!imgEl) return '';
        const attrCandidates = [
            imgEl.getAttribute('data-latex'),
            imgEl.getAttribute('data-tex'),
            imgEl.getAttribute('data-formula'),
            imgEl.getAttribute('data-original-latex'),
            imgEl.getAttribute('latex'),
            imgEl.getAttribute('tex')
        ].filter(Boolean);

        for (const cand of attrCandidates) {
            const clean = String(cand).trim();
            if (clean) return ` $${clean}$ `;
        }

        const dataMathml = imgEl.getAttribute('data-mathml');
        if (dataMathml) {
            try {
                const mDoc = new DOMParser().parseFromString(dataMathml, 'application/xml');
                const mRoot = mDoc.querySelector('math');
                if (mRoot) {
                    const tex = mathmlToLatex(mRoot).trim();
                    if (tex) return ` $${tex}$ `;
                }
            } catch (_) {}
        }

        const altOrTitle = (imgEl.getAttribute('alt') || imgEl.getAttribute('title') || '').trim();
        if (altOrTitle && !/^(image|img|图片|icon|logo|公式)$/i.test(altOrTitle) && altOrTitle.length <= 240) {
            return ` ${altOrTitle} `;
        }

        const src = imgEl.getAttribute('src') || imgEl.getAttribute('data-original') || '';
        if (src) {
            try {
                const u = new URL(src, location.href);
                for (const param of ['latex', 'tex', 'formula', 'chl', 'tex_str', 'math']) {
                    const v = u.searchParams.get(param);
                    if (v && v.trim()) return ` $${v.trim()}$ `;
                }
            } catch (_) {}
            if (/latex|math|formula|equation|katex|codecogs|mathtype|wiris/i.test(src)) {
                return ' [公式图片] ';
            }
        }
        return '';
    }

    /**
     * 无损提取含高等数学公式的节点文本，并自动剔除“AI讲解”等平台按钮噪声
     */
    function extractRichMathText(node) {
        if (!node) return '';
        const clone = node.cloneNode(true);
        const doc = clone.ownerDocument || document;

        const replaceWithText = (el, text) => {
            if (!el || !el.parentNode) return;
            el.replaceWith(doc.createTextNode(text));
        };

        // 1. 移除干扰与不可见元素（含平台 AI讲解 按钮，保留 script[type^="math/tex"]）
        clone.querySelectorAll('style, noscript, .ans-icon, .font-cxsecret-ignore, .marking_duigou, .marking_cuowu, [class*="ai-explain"], [class*="aiExplain"], [class*="ai_explain"]').forEach(el => el.remove());
        clone.querySelectorAll('button, a, span, div').forEach(el => {
            if (el.children.length <= 2 && /^\s*(AI\s*讲解|查看解析|收藏|纠错)\s*$/i.test(el.textContent || '')) {
                el.remove();
            }
        });
        clone.querySelectorAll('script').forEach(sc => {
            const t = (sc.getAttribute('type') || '').toLowerCase();
            if (!t.startsWith('math/tex') && !t.startsWith('math/mml')) {
                sc.remove();
            }
        });

        // 2. 处理 KaTeX
        clone.querySelectorAll('.katex-display, .katex').forEach(el => {
            if (!el.isConnected) return;
            const ann = el.querySelector('annotation[encoding*="tex"], annotation[encoding*="latex"]');
            if (ann && ann.textContent && ann.textContent.trim()) {
                replaceWithText(el, ` $${ann.textContent.trim()}$ `);
            }
        });

        // 3. 处理 MathJax v3 (mjx-container)
        clone.querySelectorAll('mjx-container').forEach(el => {
            if (!el.isConnected) return;
            const ann = el.querySelector('annotation[encoding*="tex"], annotation[encoding*="latex"]');
            if (ann && ann.textContent && ann.textContent.trim()) {
                replaceWithText(el, ` $${ann.textContent.trim()}$ `);
                return;
            }
            const mml = el.querySelector('math');
            if (mml) {
                const tex = mathmlToLatex(mml).replace(/\s+/g, ' ').trim();
                if (tex) {
                    replaceWithText(el, ` $${tex}$ `);
                    return;
                }
            }
            el.querySelectorAll('mjx-assistive-mml').forEach(a => a.remove());
        });

        // 4. 处理 MathJax v2
        clone.querySelectorAll('script[type^="math/tex"]').forEach(sc => {
            const tex = (sc.textContent || '').trim();
            if (tex) {
                const prev = sc.previousElementSibling;
                if (prev && /MathJax/i.test(prev.className || '')) prev.remove();
                replaceWithText(sc, ` $${tex}$ `);
            } else {
                sc.remove();
            }
        });
        clone.querySelectorAll('.MathJax_Preview, .MJX_Assistive_MathML').forEach(el => el.remove());

        // 5. 处理带 data-latex / data-tex / data-formula / .ql-formula 的节点
        clone.querySelectorAll('[data-latex], [data-tex], [data-formula], .ql-formula[data-value]').forEach(el => {
            if (!el.isConnected || el.tagName === 'IMG') return;
            const tex = (
                el.getAttribute('data-latex') ||
                el.getAttribute('data-tex') ||
                el.getAttribute('data-formula') ||
                el.getAttribute('data-value') || ''
            ).trim();
            if (tex) {
                replaceWithText(el, ` $${tex}$ `);
            }
        });

        // 6. 处理残留的原生 MathML <math>
        clone.querySelectorAll('math').forEach(m => {
            if (!m.isConnected) return;
            const ann = m.querySelector('annotation[encoding*="tex"], annotation[encoding*="latex"]');
            const tex = (ann && ann.textContent && ann.textContent.trim())
                ? ann.textContent.trim()
                : mathmlToLatex(m).replace(/\s+/g, ' ').trim();
            if (tex) replaceWithText(m, ` $${tex}$ `);
        });

        // 7. 处理公式图片 <img>
        clone.querySelectorAll('img').forEach(img => {
            const extracted = extractFormulaFromImg(img);
            if (extracted) {
                replaceWithText(img, extracted);
            }
        });

        // 8. 处理 HTML <sup> / <sub>
        const supSubNodes = Array.from(clone.querySelectorAll('sup, sub')).reverse();
        for (const el of supSubNodes) {
            if (!el.isConnected) continue;
            const inner = (el.textContent || '').replace(/\s+/g, '').trim();
            if (!inner) continue;
            const prefix = el.tagName.toLowerCase() === 'sup' ? '^' : '_';
            replaceWithText(el, inner.length === 1 ? `${prefix}${inner}` : `${prefix}{${inner}}`);
        }

        // 9. 读取最终文本并清理零宽字符与平台噪声
        const raw = (clone.textContent || '')
            .replace(/[\u200B-\u200D\uFEFF]/g, '')
            .replace(/\u00A0/g, ' ');
        return stripPlatformNoiseText(raw);
    }

    function isMathQuestion(stemText, optionsList = []) {
        const combined = `${stemText || ''} ${(optionsList || []).map(o => o.cleanContent || o.text || '').join(' ')}`;

        if (/\\(frac|int|lim|sum|prod|sqrt|sin|cos|tan|cot|sec|csc|arcsin|arccos|arctan|ln|log|exp|infty|to|rightarrow|partial|nabla|cdot|times|leq|geq|neq|approx|equiv|alpha|beta|gamma|delta|theta|lambda|mu|sigma|phi|omega|pi|Delta|Sigma|Omega|begin\{matrix\})/i.test(combined)) {
            return true;
        }
        if (/[∫∬∭∮∑∏∂∇∞√≤≥≠≈≡∈∉⊂⊆∪∩∀∃⇒⇔]/.test(combined)) {
            return true;
        }
        if (/(高等数学|高数|微积分|极限|求导|导数|高阶导|隐函数|参数方程求导|微分|偏导|全微分|方向导数|梯度|散度|旋度|原函数|不定积分|定积分|反常积分|广义积分|二重积分|三重积分|曲线积分|曲面积分|格林公式|高斯公式|斯托克斯|级数|收敛|发散|收敛域|收敛半径|幂级数|傅里叶|泰勒|麦克劳林|洛必达|罗尔定理|拉格朗日|柯西中值|中值定理|间断点|可去间断|跳跃间断|无穷间断|连续性|可导|可微|拐点|凹凸性|极值|驻点|渐近线|切线方程|法线方程|曲率|微分方程|通解|特解|齐次|非齐次|特征方程|等价无穷小|无穷小|无穷大|矩阵|行列式|秩|特征值|特征向量|线性相关|线性无关|极大无关组|向量空间|二次型|正定|逆矩阵|伴随矩阵|随机变量|概率密度|分布函数|数学期望|方差|协方差|正态分布|泊松分布|二项分布|指数分布|均匀分布|中心极限定理|大数定律|参数估计|极大似然|假设检验)/.test(combined)) {
            return true;
        }
        if (/\b(f\s*['′″]?\s*\([a-z,\s]+\)|y\s*['′″]+|d[xyzt]\s*\/\s*d[xyzt]|lim\s*[\(_]?[a-z]|sin\s*[a-z(]|cos\s*[a-z(]|tan\s*[a-z(]|ln\s*[\|(x]|log_?\d*\s*\(|e\^\{?[-\w+]+|\^[{\-]?\d+|_[{\-]?\d+)/i.test(combined)) {
            return true;
        }
        if (/(\b[xy]\s*(->|→)\s*[0∞+\-\d]|d[xyz]\b.*\b(积分|求|等于|=))/.test(combined)) {
            return true;
        }
        return false;
    }

    function isComplexReasoningQuestion(stemText, optionsList = []) {
        const combined = `${stemText || ''} ${(optionsList || []).map(o => o.cleanContent || '').join(' ')}`;
        // 否定题、组合编号题、物理/工程稳性计算题、多选题 -> 均需深度推理
        if (/(不包括|不正确|错误的是|不属于|无关|不是|以下哪项不|不能|不恰当)/.test(stemText || '')) return true;
        if (/[①②③④⑤]/.test(combined)) return true;
        if (/(横倾角|倾侧力矩|初稳性高度|排水量|GM|KG|弯矩|剪力|稳性|浮心|重心|吃水|力矩|功率|电阻|压强|加速度|动量)/.test(combined)) return true;
        if (/多选|多项|more than one|multiple/i.test(stemText || '')) return true;
        return false;
    }

    function isMaritimeQuestion(stemText, optionsList = []) {
        const combined = `${stemText || ''} ${(optionsList || []).map(o => o.cleanContent || '').join(' ')}`;
        return /(集装箱|散装|散货|散粮|谷物|围井|IMSBC|箱位|船舶|横倾|初稳性|配载|岸桥|舱内|甲板|底舱|二层舱|积载因数|下沉性|止移|1CC|1AA|种子饼|平舱)/i.test(combined);
    }

    /********************************************************************
     * 3. 限速队列式实时联网搜题引擎 (Rate-Limited Web Search RAG)
     * 彻底解决连刷时 12 路并发轰炸 Bing/百度被限流超时导致单题与连刷不一致的问题
     ********************************************************************/
    const searchQueue = {
        active: 0,
        pending: [],
        lastDispatchAt: 0
    };

    function runInSearchQueue(taskFn) {
        return new Promise((resolve) => {
            const execute = async () => {
                searchQueue.active++;
                const waitGap = Math.max(0, CONFIG.searchIntervalMs - (Date.now() - searchQueue.lastDispatchAt));
                if (waitGap > 0) await sleep(waitGap);
                searchQueue.lastDispatchAt = Date.now();
                try {
                    resolve(await taskFn());
                } catch (_) {
                    resolve({ clues: '', count: 0, status: 'error' });
                } finally {
                    searchQueue.active--;
                    if (searchQueue.pending.length > 0) {
                        const next = searchQueue.pending.shift();
                        next();
                    }
                }
            };

            if (searchQueue.active < CONFIG.searchConcurrency) {
                execute();
            } else {
                searchQueue.pending.push(execute);
            }
        });
    }

    function cleanSearchQuery(stemText) {
        return stripPlatformNoiseText(stemText)
            .replace(/^\s*\d+[.、\s)）]*/, '')
            .replace(/[（(]\s*[单多判填简计算]选题?[^)）]*[)）]/g, '')
            .replace(/\[\[.*?\]\]/g, ' ')
            .replace(/\$+/g, ' ')
            .replace(/_{2,}/g, ' ')
            .replace(/[①②③④⑤⑥⑦⑧⑨⑩]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 68);
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
        const selectors = [
            '.b_algo', '.b_caption p', '.b_snippet',
            '.c-container', '.c-abstract', '[class*="content-right"]', '[class*="summary"]', '.result'
        ];
        const nodes = doc.querySelectorAll(selectors.join(','));
        for (const node of nodes) {
            const txt = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
            if (txt.length >= 20 && txt.length <= 480 && !snippets.includes(txt)) {
                snippets.push(txt);
            }
            if (snippets.length >= 5) break;
        }
        return snippets;
    }

    async function searchWebForQuestionClues(stemText, optionsList = [], isMath = false) {
        if (!STATE.webSearchEnabled) {
            return { clues: '', count: 0, status: 'disabled' };
        }
        const query = cleanSearchQuery(stemText);
        if (query.length < 6) {
            return { clues: '', count: 0, status: 'too-short' };
        }
        // 纯符号高数计算题跳过网搜，避免搜到正负号/系数不同的近似题产生误导
        if (isMath && (query.replace(/[^a-zA-Z0-9\\^_{}()+\-*/=]/g, '').length / Math.max(1, query.length) > 0.55)) {
            return { clues: '', count: 0, status: 'skipped-math' };
        }

        const cacheKey = normalizeStemKey(stemText);
        if (cacheKey && STATE.searchCache.has(cacheKey)) {
            return STATE.searchCache.get(cacheKey);
        }

        const result = await runInSearchQueue(async () => {
            // 如果题干较短，附带前2个非编号选项词提升精准命中率；题干本身已含丰富关键词则直接搜纯题干
            const nonNumOpts = optionsList
                .map(o => o.cleanContent.replace(/[①②③④⑤⑥⑦⑧⑨⑩\$]/g, '').trim())
                .filter(s => s.length >= 2 && s.length <= 24)
                .slice(0, 2)
                .join(' ');
            const bingQuery = (query.length < 28 && nonNumOpts) ? `${query} ${nonNumOpts}`.slice(0, 82) : query;

            const bingUrl = `https://cn.bing.com/search?q=${encodeURIComponent(bingQuery)}`;
            const baiduUrl = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=5`;

            const [bingHtml, baiduHtml] = await Promise.all([
                fetchUrlTextWithTimeout(bingUrl, CONFIG.searchTimeoutMs),
                fetchUrlTextWithTimeout(baiduUrl, CONFIG.searchTimeoutMs)
            ]);

            const combinedSnippets = [
                ...parseSearchSnippetsFromHTML(bingHtml),
                ...parseSearchSnippetsFromHTML(baiduHtml)
            ].slice(0, 6);

            return {
                clues: combinedSnippets.join('\n---\n').slice(0, 1800),
                count: combinedSnippets.length,
                status: combinedSnippets.length > 0 ? 'hit' : 'miss'
            };
        });

        if (cacheKey) {
            STATE.searchCache.set(cacheKey, result);
        }
        return result;
    }

    /********************************************************************
     * 4. 页面主环境点击桥接器 (Main-World Click Bridge)
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
                                try { n.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true })); } catch(_) {}
                                try { n.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); } catch(_) {}
                                try { n.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true })); } catch(_) {}
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
     * 5. 手机 + iPad + PC 响应式 UI 样式（含内置日志面板）
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
            right: max(16px, env(safe-area-inset-right, 0px));
            bottom: calc(180px + env(safe-area-inset-bottom, 0px));
            width: 54px;
            height: 54px;
            border-radius: 50%;
            background: rgba(15, 23, 42, 0.92);
            color: #38bdf8;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 4px 18px rgba(0, 0, 0, 0.42);
            border: 1.5px solid rgba(56, 189, 248, 0.5);
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
            will-change: transform;
            transition: transform 0.16s ease, box-shadow 0.2s ease, border-color 0.2s ease;
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
            animation: ds-spin-turbo 0.22s linear infinite !important;
        }
        @keyframes ds-spin-turbo {
            0% { transform: scale3d(1.12, 1.12, 1) rotate3d(0, 0, 1, 0deg); }
            50% { transform: scale3d(1.18, 1.18, 1) rotate3d(0, 0, 1, 180deg); }
            100% { transform: scale3d(1.12, 1.12, 1) rotate3d(0, 0, 1, 360deg); }
        }

        #ds-card {
            position: fixed;
            right: max(16px, env(safe-area-inset-right, 0px));
            bottom: calc(24px + env(safe-area-inset-bottom, 0px));
            width: 384px;
            max-width: calc(100vw - 24px);
            max-height: 72vh;
            background: rgba(15, 23, 42, 0.96);
            color: #f8fafc;
            border-radius: 16px;
            border: 1px solid rgba(148, 163, 184, 0.34);
            box-shadow: 0 12px 32px rgba(0, 0, 0, 0.56);
            backdrop-filter: blur(16px);
            -webkit-backdrop-filter: blur(16px);
            z-index: 2147483646;
            font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", system-ui, sans-serif;
            font-size: 13px;
            line-height: 1.5;
            padding: 12px 14px;
            display: none;
            flex-direction: column;
            box-sizing: border-box;
            user-select: text;
        }
        #ds-card.ds-open {
            display: flex;
        }

        .ds-card-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            border-bottom: 1px solid rgba(148, 163, 184, 0.22);
            padding-bottom: 8px;
            margin-bottom: 8px;
            flex-shrink: 0;
            gap: 8px;
        }
        .ds-card-title {
            font-weight: 600;
            color: #38bdf8;
            font-size: 13.5px;
            display: flex;
            align-items: center;
            gap: 6px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .ds-header-icons {
            display: flex;
            align-items: center;
            gap: 4px;
            flex-shrink: 0;
        }
        .ds-icon-btn {
            color: #cbd5e1;
            background: rgba(30, 41, 59, 0.8);
            border: 1px solid rgba(148, 163, 184, 0.25);
            border-radius: 8px;
            min-width: 30px;
            height: 30px;
            font-size: 14px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            user-select: none !important;
            -webkit-user-select: none !important;
            -webkit-tap-highlight-color: transparent;
        }
        .ds-icon-btn:active {
            background: #334155;
        }

        #ds-card-content {
            overflow-y: auto;
            -webkit-overflow-scrolling: touch;
            flex: 1 1 auto;
            min-height: 0;
            padding-right: 2px;
        }

        .ds-subpanel {
            display: none;
            background: rgba(30, 41, 59, 0.92);
            border: 1px solid rgba(56, 189, 248, 0.35);
            border-radius: 10px;
            padding: 10px;
            margin-bottom: 8px;
            flex-shrink: 0;
        }
        .ds-subpanel.ds-show {
            display: block;
        }
        #ds-log-list {
            max-height: 180px;
            overflow-y: auto;
            -webkit-overflow-scrolling: touch;
            font-size: 11px;
            color: #cbd5e1;
            margin-top: 6px;
            display: flex;
            flex-direction: column;
            gap: 5px;
        }
        .ds-log-item {
            background: rgba(15, 23, 42, 0.78);
            border-left: 2px solid #38bdf8;
            border-radius: 6px;
            padding: 5px 7px;
            word-break: break-word;
            line-height: 1.4;
        }
        .ds-setting-row {
            display: flex;
            gap: 6px;
            align-items: center;
            margin-top: 6px;
        }
        .ds-input {
            flex: 1;
            min-width: 0;
            background: #0f172a;
            color: #f8fafc;
            border: 1px solid rgba(148, 163, 184, 0.4);
            border-radius: 8px;
            padding: 7px 9px;
            font-size: 14px;
            outline: none;
        }
        .ds-input:focus {
            border-color: #38bdf8;
        }

        .ds-answer-box {
            background: rgba(30, 41, 59, 0.82);
            border-radius: 10px;
            padding: 9px 11px;
            margin-bottom: 8px;
            border-left: 3px solid #10b981;
            word-break: break-word;
        }
        .ds-answer-meta {
            display: flex;
            flex-wrap: wrap;
            gap: 5px;
            align-items: center;
            font-size: 11px;
            color: #94a3b8;
            margin-bottom: 4px;
        }
        .ds-badge {
            display: inline-block;
            padding: 1px 6px;
            border-radius: 999px;
            font-size: 10.5px;
            font-weight: 600;
            background: rgba(56, 189, 248, 0.16);
            color: #7dd3fc;
            border: 1px solid rgba(56, 189, 248, 0.32);
        }
        .ds-badge-math {
            background: rgba(168, 85, 247, 0.2);
            color: #d8b4fe;
            border-color: rgba(168, 85, 247, 0.42);
        }
        .ds-answer-main {
            font-size: 15px;
            font-weight: 600;
            color: #34d399;
            margin-bottom: 4px;
            user-select: all;
            white-space: pre-wrap;
        }
        .ds-answer-main.ds-answer-essay {
            font-size: 13.5px;
            font-weight: 500;
            line-height: 1.65;
            color: #e2e8f0;
            user-select: text;
        }
        .ds-answer-sub {
            font-size: 12px;
            color: #cbd5e1;
            margin-top: 4px;
            line-height: 1.5;
            white-space: pre-wrap;
        }

        .ds-progress-bar-bg {
            width: 100%;
            height: 6px;
            background: rgba(51, 65, 85, 0.85);
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
            flex-shrink: 0;
            margin-top: 8px;
        }
        .ds-btn {
            background: #1e293b;
            color: #f1f5f9;
            border: 1px solid rgba(148, 163, 184, 0.32);
            border-radius: 8px;
            padding: 6px 10px;
            min-height: 32px;
            font-size: 12px;
            cursor: pointer;
            user-select: none !important;
            -webkit-user-select: none !important;
            -webkit-tap-highlight-color: transparent;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 4px;
            box-sizing: border-box;
        }
        .ds-btn:active {
            background: #334155;
            transform: scale(0.97);
        }
        .ds-btn-fill {
            background: #065f46;
            color: #a7f3d0;
            border-color: #059669;
            font-weight: 600;
        }
        .ds-btn-accent {
            background: rgba(91, 33, 182, 0.55);
            color: #e9d5ff;
            border-color: rgba(168, 85, 247, 0.55);
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

        @media (max-width: 640px) {
            #ds-fab {
                width: 48px;
                height: 48px;
                font-size: 20px;
                right: 12px;
                bottom: calc(130px + env(safe-area-inset-bottom, 0px));
            }
            #ds-card {
                left: 8px;
                right: 8px;
                width: auto;
                max-width: none;
                bottom: calc(8px + env(safe-area-inset-bottom, 0px));
                max-height: 60vh;
                padding: 10px 12px;
                border-radius: 16px;
            }
            .ds-btn {
                min-height: 36px;
                padding: 6px 10px;
                font-size: 12.5px;
                flex: 1 1 auto;
            }
            .ds-icon-btn {
                min-width: 34px;
                height: 34px;
            }
        }
    `;
    (document.head || document.documentElement).appendChild(styleEl);

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
                settingsPanel: topDoc.getElementById('ds-settings-panel'),
                logPanel: topDoc.getElementById('ds-log-panel'),
                logList: topDoc.getElementById('ds-log-list'),
                apiKeyInput: topDoc.getElementById('ds-apikey-input'),
                bankCountEl: topDoc.getElementById('ds-bank-count'),
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
                settingsPanel: document.getElementById('ds-settings-panel'),
                logPanel: document.getElementById('ds-log-panel'),
                logList: document.getElementById('ds-log-list'),
                apiKeyInput: document.getElementById('ds-apikey-input'),
                bankCountEl: document.getElementById('ds-bank-count'),
                sweepBtn: document.getElementById('ds-btn-autosweep'),
                searchBtn: document.getElementById('ds-btn-websearch'),
                modelBtn: document.getElementById('ds-btn-switch-model')
            };
        }
    }

    function showCard() {
        const { card } = getUIElements();
        if (card) card.classList.add('ds-open');
    }

    function hideCard() {
        const { card } = getUIElements();
        if (card) card.classList.remove('ds-open');
    }

    function renderLogPanel() {
        const { logList } = getUIElements();
        if (!logList) return;
        if (STATE.logs.length === 0) {
            logList.innerHTML = `<div style="color:#64748b;">暂无答题日志，开始答题后会自动记录每题的模型、网搜命中数与耗时。</div>`;
            return;
        }
        logList.innerHTML = STATE.logs.map(l => `
            <div class="ds-log-item">
                <div><b>[${escapeHtml(l.ts)}] ${escapeHtml(l.scene)}</b> · ${escapeHtml(l.model)} · 网搜:${escapeHtml(l.web)} · ${l.ms}ms</div>
                <div style="color:#94a3b8;">题：${escapeHtml(l.stem)}</div>
                <div style="color:#34d399;">答：${escapeHtml(l.answer)}</div>
            </div>
        `).join('');
    }

    function formatLogsAsText() {
        return STATE.logs.map(l =>
            `[${l.ts}][${l.scene}] 模型=${l.model} 网搜=${l.web} 耗时=${l.ms}ms | 题=${l.stem} | 答=${l.answer} | 思路=${l.thinking || ''}`
        ).join('\n');
    }

    function openSettingsInCard(tipMsg = '') {
        const ui = getUIElements();
        showCard();
        if (ui.logPanel) ui.logPanel.classList.remove('ds-show');
        if (ui.settingsPanel) ui.settingsPanel.classList.add('ds-show');
        if (ui.apiKeyInput) {
            ui.apiKeyInput.value = STATE.apiKey || '';
            setTimeout(() => { try { ui.apiKeyInput.focus(); } catch (_) {} }, 80);
        }
        if (ui.bankCountEl) {
            const count = Object.keys(GM_getValue('DEEPSEEK_VERIFIED_BANK', STATE.verifiedBank || {})).length;
            ui.bankCountEl.textContent = String(count);
        }
        if (tipMsg && ui.contentBox) {
            ui.contentBox.innerHTML = `<div style="color:#f59e0b;font-size:12.5px;padding:4px 0;">${escapeHtml(tipMsg)}</div>`;
        }
    }

    function ensureApiKeyReady() {
        if (STATE.apiKey && STATE.apiKey.trim()) return true;
        if (isCompactViewport()) {
            openSettingsInCard('🔑 请先在上方输入您的 DeepSeek API Key (sk-...) 并点击保存。');
            return false;
        }
        const key = prompt('请输入您的 DeepSeek API Key (sk-...):', '');
        if (key && key.trim()) {
            STATE.apiKey = key.trim();
            GM_setValue('DEEPSEEK_API_KEY', STATE.apiKey);
            return true;
        }
        openSettingsInCard('🔑 未设置 API Key，可在此处粘贴保存。');
        return false;
    }

    function clampFabIntoViewport() {
        if (!fabEl) return;
        const rect = fabEl.getBoundingClientRect();
        if (fabEl.style.left && fabEl.style.left !== 'auto') {
            const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
            const maxTop = Math.max(8, window.innerHeight - rect.height - 8);
            const curLeft = parseFloat(fabEl.style.left) || rect.left;
            const curTop = parseFloat(fabEl.style.top) || rect.top;
            fabEl.style.left = `${Math.max(8, Math.min(maxLeft, curLeft))}px`;
            fabEl.style.top = `${Math.max(8, Math.min(maxTop, curTop))}px`;
        }
    }

    if (isTopFrame) {
        fabEl = document.createElement('div');
        fabEl.id = 'ds-fab';
        fabEl.innerHTML = '🎯';
        fabEl.title = '轻点1下：R1深度解析单题 | 长按或连点3下：全卷最高准自动连刷！';
        document.body.appendChild(fabEl);

        cardEl = document.createElement('div');
        cardEl.id = 'ds-card';
        cardEl.innerHTML = `
            <div class="ds-card-header">
                <span class="ds-card-title">🔬 DeepSeek 题库助手 3.7 (全题型高准)</span>
                <span class="ds-header-icons">
                    <button class="ds-icon-btn" id="ds-card-log-btn" title="查看/复制诊断日志">📋</button>
                    <button class="ds-icon-btn" id="ds-card-settings-btn" title="设置 API Key 与题库">⚙️</button>
                    <button class="ds-icon-btn" id="ds-card-close-btn" title="关闭">✕</button>
                </span>
            </div>
            <div class="ds-subpanel" id="ds-log-panel">
                <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;color:#38bdf8;">
                    <b>📋 答题诊断日志（模型 / 网搜 / 耗时）</b>
                    <span style="display:flex;gap:4px;">
                        <button class="ds-btn" id="ds-log-copy-btn" style="flex:0 0 auto;min-height:26px;padding:2px 8px;font-size:11px;">复制日志</button>
                        <button class="ds-btn" id="ds-log-clear-btn" style="flex:0 0 auto;min-height:26px;padding:2px 8px;font-size:11px;">清空</button>
                    </span>
                </div>
                <div id="ds-log-list"></div>
            </div>
            <div class="ds-subpanel" id="ds-settings-panel">
                <div style="font-size:12px;color:#94a3b8;">DeepSeek API Key（保存在本地油猴存储，跨版本保留）：</div>
                <div class="ds-setting-row">
                    <input class="ds-input" id="ds-apikey-input" type="password" placeholder="sk-..." autocomplete="off" />
                    <button class="ds-btn ds-btn-fill" id="ds-apikey-save-btn" style="flex:0 0 auto;">保存</button>
                </div>
                <div class="ds-setting-row" style="justify-content:space-between;margin-top:8px;font-size:11.5px;color:#94a3b8;">
                    <span>本地已记忆题库：<b id="ds-bank-count" style="color:#38bdf8;">0</b> 题</span>
                    <span style="display:flex;gap:4px;">
                        <button class="ds-btn" id="ds-cache-clear-btn" style="flex:0 0 auto;min-height:28px;padding:3px 8px;font-size:11px;">清本页缓存</button>
                        <button class="ds-btn" id="ds-bank-clear-btn" style="flex:0 0 auto;min-height:28px;padding:3px 8px;font-size:11px;">清记忆库</button>
                    </span>
                </div>
            </div>
            <div id="ds-card-content">
                <div style="color:#cbd5e1;font-size:12px;line-height:1.6;">
                    • <b>全题型高准支持</b>：选择题自动点选、填空题多空顺序填入、<b>大题（计算/证明/简答/论述）输出完整步骤</b>支持一键填入或复制！<br>
                    • <b>轻点 1 下 🎯</b>：R1 深度解析当前题（无输入框的拍照大题也能解）<br>
                    • <b>长按 🎯 或 连点 3 下 🎯</b>：全卷 R1 深度高准自动连刷（右上角 📋 可看每题日志）
                </div>
            </div>
            <div class="ds-card-actions" id="ds-card-footer">
                <button class="ds-btn ds-btn-fill" id="ds-btn-autosweep">🚀 全卷高准全选</button>
                <button class="ds-btn" id="ds-btn-switch-model">${getModelModeLabel()}</button>
                <button class="ds-btn" id="ds-btn-websearch">${STATE.webSearchEnabled ? '🌐 联网:开' : '📴 联网:关'}</button>
            </div>
        `;
        document.body.appendChild(cardEl);

        document.getElementById('ds-card-close-btn').addEventListener('click', hideCard);

        document.getElementById('ds-card-log-btn').addEventListener('click', () => {
            const logPanel = document.getElementById('ds-log-panel');
            const settingsPanel = document.getElementById('ds-settings-panel');
            if (!logPanel) return;
            if (settingsPanel) settingsPanel.classList.remove('ds-show');
            const willShow = !logPanel.classList.contains('ds-show');
            logPanel.classList.toggle('ds-show', willShow);
            if (willShow) renderLogPanel();
        });

        document.getElementById('ds-log-copy-btn').addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            const txt = formatLogsAsText() || '暂无日志';
            try {
                await navigator.clipboard.writeText(txt);
                btn.innerText = '已复制';
                setTimeout(() => { btn.innerText = '复制日志'; }, 1200);
            } catch (_) {
                prompt('复制以下诊断日志：', txt);
            }
        });

        document.getElementById('ds-log-clear-btn').addEventListener('click', () => {
            STATE.logs = [];
            renderLogPanel();
        });

        document.getElementById('ds-card-settings-btn').addEventListener('click', () => {
            const panel = document.getElementById('ds-settings-panel');
            const logPanel = document.getElementById('ds-log-panel');
            if (!panel) return;
            if (logPanel) logPanel.classList.remove('ds-show');
            const willShow = !panel.classList.contains('ds-show');
            panel.classList.toggle('ds-show', willShow);
            if (willShow) {
                const inp = document.getElementById('ds-apikey-input');
                if (inp) inp.value = STATE.apiKey || '';
                const cnt = document.getElementById('ds-bank-count');
                if (cnt) cnt.textContent = String(Object.keys(GM_getValue('DEEPSEEK_VERIFIED_BANK', STATE.verifiedBank || {})).length);
            }
        });

        document.getElementById('ds-apikey-save-btn').addEventListener('click', () => {
            const inp = document.getElementById('ds-apikey-input');
            const val = (inp?.value || '').trim();
            if (!val) return;
            STATE.apiKey = val;
            GM_setValue('DEEPSEEK_API_KEY', val);
            document.getElementById('ds-settings-panel')?.classList.remove('ds-show');
            const contentBox = document.getElementById('ds-card-content');
            if (contentBox) {
                contentBox.innerHTML = `<div class="ds-answer-box"><div class="ds-answer-main">✅ API Key 已保存</div><div class="ds-answer-sub">现在可轻点 🎯 解析单题，或长按 🎯 全卷连刷。</div></div>`;
            }
        });

        document.getElementById('ds-cache-clear-btn').addEventListener('click', (e) => {
            STATE.sessionCache.clear();
            STATE.searchCache.clear();
            e.currentTarget.innerText = '已清空';
            setTimeout(() => { e.currentTarget.innerText = '清本页缓存'; }, 1000);
        });

        document.getElementById('ds-bank-clear-btn').addEventListener('click', () => {
            STATE.verifiedBank = {};
            GM_setValue('DEEPSEEK_VERIFIED_BANK', {});
            const cnt = document.getElementById('ds-bank-count');
            if (cnt) cnt.textContent = '0';
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
            e.currentTarget.innerText = STATE.webSearchEnabled ? '🌐 联网:开' : '📴 联网:关';
        });

        document.getElementById('ds-btn-switch-model').addEventListener('click', (e) => {
            const idx = MODEL_MODES.indexOf(STATE.modelMode);
            STATE.modelMode = MODEL_MODES[(idx + 1) % MODEL_MODES.length];
            GM_setValue('DEEPSEEK_MODEL_V36', STATE.modelMode);
            e.currentTarget.innerText = getModelModeLabel(STATE.modelMode);
        });

        if (typeof GM_registerMenuCommand === 'function') {
            GM_registerMenuCommand('🔑 设置 DeepSeek API Key', () => openSettingsInCard('🔑 请在下方输入 DeepSeek API Key'));
            GM_registerMenuCommand('🚀 启动全卷高准自动全选', () => startFullPageAutoSweep());
        }

        fabEl.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
        });

        let isPressing = false;
        let lastTouchTimestamp = 0;
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
                    try { navigator.vibrate && navigator.vibrate(20); } catch (_) {}
                    startFullPageAutoSweep();
                }
            }, CONFIG.longPressDuration);
        };

        const onPointerMove = (clientX, clientY, rawEvent) => {
            if (!isPressing) return;
            const dx = clientX - startX;
            const dy = clientY - startY;
            if (Math.hypot(dx, dy) > 10) {
                hasMoved = true;
                clearLongPressTimer();
                if (rawEvent && rawEvent.cancelable) rawEvent.preventDefault();
                const rect = fabEl.getBoundingClientRect();
                const newLeft = Math.max(8, Math.min(window.innerWidth - rect.width - 8, initialLeft + dx));
                const newTop = Math.max(8, Math.min(window.innerHeight - rect.height - 8, initialTop + dy));
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
            lastTouchTimestamp = Date.now();
            if (e.touches.length === 1) {
                onPointerStart(e.touches[0].clientX, e.touches[0].clientY);
            }
        }, { passive: true });

        window.addEventListener('touchmove', (e) => {
            if (isPressing && e.touches.length === 1) {
                onPointerMove(e.touches[0].clientX, e.touches[0].clientY, e);
            }
        }, { passive: false });

        window.addEventListener('touchend', onPointerEnd);
        window.addEventListener('touchcancel', onPointerEnd);

        fabEl.addEventListener('mousedown', (e) => {
            if (Date.now() - lastTouchTimestamp < 600) return;
            if (e.button === 0) {
                onPointerStart(e.clientX, e.clientY);
            }
        });

        window.addEventListener('mousemove', (e) => {
            if (isPressing && Date.now() - lastTouchTimestamp >= 600) {
                onPointerMove(e.clientX, e.clientY, e);
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
                }, 280);
            }
        });

        window.addEventListener('resize', clampFabIntoViewport);
        window.addEventListener('orientationchange', () => setTimeout(clampFabIntoViewport, 200));
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', clampFabIntoViewport);
        }
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
     * 6. 批改结果页自动记忆引擎
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
                showCard();
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
     * 7. 丝滑单容器滚屏与可靠点击引擎
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
            sweepBtn.innerText = '🚀 全卷高准全选';
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
                totalTopOffset += rect.top + Math.min(rect.height / 2, 110);

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

                const ratio = isCompactViewport() ? 0.22 : 0.34;
                const targetViewportY = window.top.innerHeight * ratio;
                const deltaY = totalTopOffset - targetViewportY;
                if (Math.abs(deltaY) < 40) {
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
     * 8. 精准题目与选项提取器（单题与连刷完全统一）
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
                return r.width >= 12 && r.height >= 10 && r.height <= 360;
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
                if (n.children.length > 8) continue;
                const txt = extractRichMathText(n);
                if (txt.length >= 1 && txt.length <= 360 && optionPrefixRegex.test(txt)) {
                    rawOptions.push(n);
                }
            }
        }

        rawOptions = rawOptions.filter(el => !rawOptions.some(other => other !== el && el.contains(other)));

        const options = [];
        const seenKeys = new Set();

        for (let i = 0; i < rawOptions.length; i++) {
            const el = rawOptions[i];
            const rawText = extractRichMathText(el);
            if (!rawText || rawText.length > 420) continue;

            const badgeNode = el.querySelector('.num_option, .num_option_dx, [data]');
            const dataLetter = badgeNode?.getAttribute('data')?.trim() || '';
            const prefixMatch = rawText.match(/^\s*[（(]?([A-H])(?=[)）.、．:：\s]|$)/i);
            const letter = (
                (/^[A-H]$/i.test(dataLetter) ? dataLetter : '') ||
                (prefixMatch ? prefixMatch[1] : '') ||
                String.fromCharCode(65 + options.length)
            ).toUpperCase();

            const dedupKey = `${letter}::${rawText}`;
            if (seenKeys.has(dedupKey)) continue;
            seenKeys.add(dedupKey);

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

    function isEssayStemHint(text) {
        return /(简答题|计算题|证明题|论述题|解答题|分析题|应用题|综合题|案例分析|名词解释|问答题|作图题|试证|求证|证明\s*[：:]|请简述|试述|试分析|请论述|写出.*过程|详细步骤|计算下列|求解下列)/i.test(String(text || ''));
    }

    function classifyQuestionType(q) {
        const stem = String(q?.stemText || '');
        const opts = Array.isArray(q?.options) ? q.options : [];
        const inps = Array.isArray(q?.inputs) ? q.inputs : [];

        if (opts.length >= 2) {
            if (/多选|多项|more than one|multiple/i.test(stem)) {
                return { kind: 'multi', label: '多选题', blankCount: 0 };
            }
            if (opts.length === 2 && opts.some(o => /对|错|正确|错误|true|false|√|×/i.test(o.text || ''))) {
                return { kind: 'truefalse', label: '判断题', blankCount: 0 };
            }
            return { kind: 'single', label: '单选题', blankCount: 0 };
        }

        // 无选项：区分【填空题】vs【大题（计算/证明/简答/论述/拍照上传题）】
        const isExplicitBlank = /填空题|fill\s*in/i.test(stem);
        const hasBlankMarkers = /_{2,}|\[\[空格\d+/.test(stem);
        const isExplicitEssay = isEssayStemHint(stem);

        let hasLargeEditor = false;
        for (const inp of inps) {
            try {
                const tag = (inp.tagName || '').toUpperCase();
                const r = inp.getBoundingClientRect ? inp.getBoundingClientRect() : { height: 0 };
                if (tag === 'TEXTAREA' || inp.isContentEditable || /edui/i.test(inp.className || '') || r.height >= 72) {
                    hasLargeEditor = true;
                    break;
                }
            } catch (_) {}
        }

        // 明确标注为大题，或没有输入框（纯拍照上传大题），或只有一个大尺寸富文本框且非明确填空题 -> 判为大题
        if (!isExplicitBlank && (isExplicitEssay || inps.length === 0 || (inps.length === 1 && hasLargeEditor && !hasBlankMarkers))) {
            return { kind: 'essay', label: '大题', blankCount: 0 };
        }

        const blankCount = inps.length > 0 ? inps.length : Math.max(1, (stem.match(/_{2,}/g) || []).length);
        return { kind: 'blank', label: '填空题', blankCount };
    }

    function extractPureQuestionStem(blockEl, optionsList = [], targetInput = null) {
        if (!blockEl) return '';

        const liveInputs = Array.from(blockEl.querySelectorAll ? blockEl.querySelectorAll('input, textarea, [contenteditable="true"]') : []);
        const cleanupInputs = [];
        let blankIdx = 0;
        liveInputs.forEach((inp) => {
            if (inp.type === 'hidden' || inp.type === 'radio' || inp.type === 'checkbox') return;
            blankIdx++;
            const curVal = (inp.isContentEditable ? inp.innerText : inp.value || '').trim();
            const marker = (targetInput && inp === targetInput)
                ? ` [[空格${blankIdx}(待作答)]] `
                : (curVal ? ` [[空格${blankIdx}(已填:"${curVal}")]] ` : ` [[空格${blankIdx}]] `);
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
        clone.querySelectorAll('.edui-editor, .edui-default, iframe[id*="ueditor"]').forEach(el => el.remove());

        const pureStem = extractRichMathText(clone)
            .replace(/我的答案\s*[:：].*$/g, '')
            .trim();
        return pureStem.length >= 3 ? pureStem : extractRichMathText(blockEl);
    }

    function collectAllQuestionsOnPage() {
        let blocks = querySelectorAllDeep(STRICT_QUESTION_BLOCK_SELECTORS.join(','));

        let validBlocks = blocks.filter(el => {
            const r = el.getBoundingClientRect();
            if (r.width < 100 || r.height < 24) return false;
            const opts = extractOptionsFromBlock(el);
            const inps = extractInputsFromBlock(el);
            if (opts.length >= 2 || inps.length >= 1) return true;
            // 也收纳无输入框的拍照/手写上传大题（如高数证明/计算题）
            const rawTxt = extractRichMathText(el);
            return rawTxt.length >= 10 && (isEssayStemHint(rawTxt) || /上传图片|上传附件|拍照上传/.test(rawTxt));
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
                    const txtLen = extractRichMathText(curr).length;
                    if (optsInCurr.length >= 2 && optsInCurr.length <= 8 && txtLen > optsInCurr.reduce((s, o) => s + o.text.length, 0) + 4) {
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
            const stemText = extractPureQuestionStem(blockEl, options, inputs[0] || null).slice(0, 1400);
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
     * 9. 高容错 JSON 解析器（修复高数 LaTeX 反斜杠崩溃问题）
     ********************************************************************/
    function repairJsonBackslashes(str) {
        return str
            .replace(/\\(frac|forall|beta|binom|bar|big|nabla|neq|nu|not|natural|rho|rightarrow|rangle|to|tan|theta|times|tilde|tau|text|triangle)/g, '\\\\$1')
            .replace(/\\(?!["\\/bfnrtu])/g, '\\\\')
            .replace(/,\s*([}\]])/g, '$1');
    }

    function safeParseAIJson(rawContent, reasoningText = '') {
        const cleaned = String(rawContent || '').replace(/```json|```/gi, '').trim();
        const firstBrace = cleaned.indexOf('{');
        const lastBrace = cleaned.lastIndexOf('}');
        const candidate = (firstBrace !== -1 && lastBrace > firstBrace)
            ? cleaned.slice(firstBrace, lastBrace + 1)
            : cleaned;

        let parsed = null;
        try {
            parsed = JSON.parse(candidate);
        } catch (_) {
            try {
                parsed = JSON.parse(repairJsonBackslashes(candidate));
            } catch (__) {
                const lettersMatch = cleaned.match(/"answerLetters"\s*:\s*\[([^\]]*)\]/i);
                const textsMatch = cleaned.match(/"answerTexts"\s*:\s*\[([^\]]*)\]/i);
                const thinkingMatch = cleaned.match(/"thinking"\s*:\s*"([\s\S]*?)"(?=\s*,\s*"|\s*})/);
                const confMatch = cleaned.match(/"confidence"\s*:\s*([0-9.]+)/i);

                const answerLetters = lettersMatch
                    ? (lettersMatch[1].match(/[A-H]/gi) || []).map(s => s.toUpperCase())
                    : [];
                const answerTexts = textsMatch
                    ? Array.from(textsMatch[1].matchAll(/"([^"]*)"/g)).map(m => m[1])
                    : [];

                if (answerLetters.length > 0 || answerTexts.length > 0) {
                    parsed = {
                        thinking: thinkingMatch ? thinkingMatch[1] : '',
                        answerLetters,
                        answerTexts,
                        confidence: confMatch ? parseFloat(confMatch[1]) : 0.8
                    };
                } else {
                    const bareLetter = cleaned.match(/(?:正确答案|最终答案|选|答案(?:为|是)?)\s*[:：]?\s*([A-H]{1,6})\b/i);
                    if (bareLetter) {
                        parsed = {
                            thinking: cleaned.slice(0, 180),
                            answerLetters: bareLetter[1].toUpperCase().split(''),
                            answerTexts: [],
                            confidence: 0.72
                        };
                    }
                }
            }
        }

        if (!parsed) return null;
        if (!parsed.thinking && reasoningText) {
            parsed.thinking = reasoningText.replace(/\s+/g, ' ').trim().slice(-160);
        }
        return parsed;
    }

    /********************************************************************
     * 10. 准确率优先 R1 深度推理 + 联网 RAG + 全卷互证引擎
     ********************************************************************/
    function callDeepSeekAPIOnce(payload, timeoutMs) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: CONFIG.apiUrl,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${STATE.apiKey}`
                },
                timeout: timeoutMs,
                data: JSON.stringify(payload),
                onload: (res) => {
                    resolve({ ok: res.status === 200, status: res.status, text: res.responseText || '' });
                },
                onerror: () => resolve({ ok: false, status: 0, text: '' }),
                ontimeout: () => resolve({ ok: false, status: 408, text: '' })
            });
        });
    }

    async function callDeepSeekWithRetry(payload, useModel) {
        const timeoutMs = useModel === 'deepseek-reasoner' ? CONFIG.reasonerTimeoutMs : CONFIG.chatTimeoutMs;
        for (let attempt = 0; attempt <= CONFIG.maxRetries; attempt++) {
            const res = await callDeepSeekAPIOnce(payload, timeoutMs);
            if (res.ok) return res;
            const retryable = res.status === 0 || res.status === 408 || res.status === 429 || (res.status >= 500 && res.status < 600);
            if (!retryable || attempt === CONFIG.maxRetries) return res;
            await sleep(800 * (attempt + 1));
        }
        return { ok: false, status: 0, text: '' };
    }

    function buildSystemPrompt(isMath, isMaritime, qTypeInfo) {
        const { kind = 'single', blankCount = 0 } = qTypeInfo || {};
        const baseLines = [
            '你是一位满分级高校学科、大学数学（高等数学/线代/概率）与海运/工程专业课解题专家。',
            '核心目标：追求 100% 准确率，严禁凭第一直觉草率作答。'
        ];

        if (isMath) {
            baseLines.push(
                '',
                '【📐 高等数学与计算推导专项验算协议（必须严格执行）】：',
                '1. 严谨分步求解：先明确定义域、连续性、可导性、收敛条件与积分上下限，再规范推导。',
                '2. 强制反向验算（缺一不可）：',
                '   - 不定积分：对所得原函数求导，核对是否完全还原被积函数（注意常数 C）；',
                '   - 定积分/重积分：核对对称区间奇偶性、换元后上下限变换、分部积分负号；',
                '   - 极限题：先判未定式类型（0/0、∞/∞、1^∞ 等），加减项中严禁盲目等价无穷小替换，优先用泰勒展开至足够阶数或洛必达法则交叉验算；',
                '   - 微分方程：把通解/特解代回原方程及初值条件检验；',
                '   - 级数题：先查通项极限是否为 0，再按比值/根值/比较/莱布尼茨判别法核对端点收敛性；',
                '   - 极值/拐点/间断点/渐近线：严格区分必要条件与充分条件，检查导数变号与定义域边界；',
                '   - 判断题：优先尝试构造高数经典反例（如 f(x)=|x| 连续不可导、调和级数 ∑1/n 发散等）。',
                '3. 选项逐字精校：算出最终结果后，逐一化简并与每个选项核对正负号、系数（如 1/2 与 2）、开闭区间 () 与 []。',
                '4. 联网提示警告：若附带联网搜索摘要，数学题严禁盲信网搜答案，必须以你独立演算与反向验算为准！'
            );
        } else {
            baseLines.push(
                '',
                '【🎯 通用与专业课高准解题协议（必须严格执行）】：',
                '1. 否定题反查法：若题干含“不包括 / 不正确 / 无关 / 错误的是 / 不属于”，必须先逐一判定每个选项属于还是不属于，再反选唯一不符项！',
                '2. 组合编号题逐条核验：若含 ①②③④⑤，必须逐条独立判断每一项是否成立，绝不能凭直觉漏掉教材列出的因素！',
                '3. 隐含物理/工程公式必列式：若涉及稳性、横倾角、倾侧力矩、排水量、初稳性高度 GM、弯矩、力学等，必须先写出完整物理公式再判断各变量影响，严禁漏看未给定的变量！',
                '4. 联网搜题与同卷互证：若【🌐 实时联网搜题摘要】中出现与本题一致的原题及教材答案，请高度重视并核对；同时务必结合【📄 同卷其它题目互证摘要】交叉印证（同卷邻题常直接揭示公式变量与专业定义）。',
                '5. 多选题务必逐项审查，不漏选、不多选；判断题警惕“一定/必须/所有/唯一”等绝对化表述。'
            );
        }

        if (isMaritime) {
            baseLines.push(
                '',
                '【🚢 船舶货运 / 散装谷物 / 集装箱专业课权威核对要点】：',
                '- 散装谷物横倾角公式：tanθ = M_h / (Δ · GM)（或近似 θ = 57.3·M_h / (Δ·GM)），横倾角与谷物倾侧力矩 M_h、排水量 Δ、初稳性高度 GM（及 KG）均有关，与谷物颗粒大小无关；M_h 和 Δ 相同时，GM 越小横倾角越大！',
                '- 散装谷物下沉性影响因素：谷物表面状态、积载因数、含水量、颗粒大小、颗粒形状全部有关；围井作为止移装置应设在【二层舱舱口四周】；改善散装谷物船舶稳性的方法包括减少部分装载舱个数、将尺度较小的货舱用作部分装载舱、增加经平舱满载舱个数等（注意：按舱容比分配各舱质量是调整纵向强度/剪力弯矩，不是改善谷物稳性方法）。',
                '- 6位箱位号 BBRRTT：前两位奇数排号(01,03,05...)为 20ft 箱且对应自首第 (BB+1)/2 排；中两位列号奇右偶左；后两位 <80 为舱内，>=80 为甲板；两个 1CC(20ft) 长度之和比一个 1AA(40ft) 短；双岸桥同时作业至少纵向间隔一个 40ft 行箱位。'
            );
        }

        if (kind === 'blank') {
            baseLines.push(
                '',
                `【✍️ 填空题输出规范】：本题共有 ${Math.max(1, blankCount)} 个空格，请在 answerTexts 数组中按空格顺序精确输出 ${Math.max(1, blankCount)} 个最简标准答案（例如 "1/2"、"e^2"、"0"、"x^2+C"），绝对不要附带“答案是”或多余解释文字。`
            );
        } else if (kind === 'essay') {
            baseLines.push(
                '',
                '【📝 大题（计算题 / 证明题 / 简答题 / 论述题）规范作答协议】：',
                '- 请在 answerTexts[0] 中输出可直接提交或手写抄录的【完整规范解答】（使用 \\n 换行分段）：',
                '  * 数学计算/证明大题：以“解：”或“证明：”开头，分步写出核心公式、换元/求导/积分过程、边界条件代入与最终结论（优先使用清晰易读的数学符号，如 ∫、√、≤、≥、π、x^2、1/2）；',
                '  * 文科/专业课简答/论述/分析题：按“1. ...\\n2. ...\\n3. ...”分点条理作答，紧扣教材标准踩分点，结论明确。',
                '- thinking 字段只写简短的验算核对结论（如“已求导反验，边界条件吻合”），完整答题内容全部放在 answerTexts[0] 中！'
            );
        }

        baseLines.push(
            '',
            '必须严格返回合法 JSON（不要包含 Markdown 代码块；JSON 字符串内的反斜杠请双写为 \\\\ 或用简洁 ASCII/Unicode 数学符号）：',
            '{',
            '  "thinking": "精炼的关键推导步骤、公式或教材依据与反向验算结论（不超过150字）",',
            '  "answerLetters": ["正确选项大写字母，如 \\"D\\"；填空题和大题留空数组 []"],',
            '  "answerTexts": ["选择题填正确选项原文；填空题按空格顺序填最简答案；大题在 answerTexts[0] 填完整规范解答过程"],',
            '  "confidence": 0.95',
            '}'
        );

        return baseLines.join('\n');
    }

    async function requestSingleQuestionCoTAnalysis(q, paperContextSummary = '', options = {}) {
        const { overrideModel = null, forceFresh = false, scene = '单题' } = options;
        const startTime = Date.now();
        STATE.verifiedBank = GM_getValue('DEEPSEEK_VERIFIED_BANK', STATE.verifiedBank || {});
        const stemKey = normalizeStemKey(q.stemText);
        const memoryEntry = lookupVerifiedBank(STATE.verifiedBank, q.stemText);

        const isMath = isMathQuestion(q.stemText, q.options);
        const isComplex = isComplexReasoningQuestion(q.stemText, q.options);
        const isMaritime = !isMath && isMaritimeQuestion(q.stemText, q.options);

        // 1. 优先命中本地批改验证记忆库
        if (!forceFresh && !overrideModel && memoryEntry && Array.isArray(memoryEntry.correctLetters) && memoryEntry.correctLetters.length > 0) {
            const memRes = {
                thinking: '📚 命中已验证满分题库记忆，直接锁定标准答案',
                answerLetters: memoryEntry.correctLetters,
                answerTexts: [],
                confidence: 1.0,
                usedModel: 'memory',
                isMath
            };
            addLog({
                scene,
                model: '本地题库',
                web: '跳过',
                ms: Date.now() - startTime,
                stem: q.stemText.slice(0, 36),
                answer: memRes.answerLetters.join(''),
                thinking: memRes.thinking
            });
            return memRes;
        }

        // 决定本次调用模型
        let useModel = overrideModel;
        if (!useModel) {
            if (STATE.modelMode === 'deepseek-reasoner') {
                useModel = 'deepseek-reasoner';
            } else if (STATE.modelMode === 'deepseek-chat') {
                useModel = 'deepseek-chat';
            } else {
                useModel = (isMath || isComplex) ? 'deepseek-reasoner' : 'deepseek-chat';
            }
        }

        // 2. 命中本页会话缓存（确保单题与连刷 100% 一致，不重复烧 Token）
        const sessionKey = `${stemKey}::${useModel}`;
        if (!forceFresh && stemKey && STATE.sessionCache.has(sessionKey)) {
            const cached = STATE.sessionCache.get(sessionKey);
            addLog({
                scene,
                model: `${cached.usedModel === 'deepseek-reasoner' ? 'R1' : 'V3'}(缓存)`,
                web: cached.webCount ? `命中${cached.webCount}条` : '无',
                ms: Date.now() - startTime,
                stem: q.stemText.slice(0, 36),
                answer: (cached.answerLetters || []).join('') || (cached.answerTexts || []).join('|'),
                thinking: cached.thinking
            });
            return cached;
        }

        // 3. 限速队列实时联网检索
        const searchRes = await searchWebForQuestionClues(q.stemText, q.options, isMath);
        const webClues = searchRes.clues || '';

        const qTypeInfo = classifyQuestionType(q);
        const qTypeHintMap = {
            multi: '【多选题（可能有 2~4 个正确项，请逐项核验）】',
            truefalse: '【判断题（请严格判断对/错并尝试找反例）】',
            single: '【单选题（必选唯一最严谨正确项）】',
            blank: `【填空题（共 ${qTypeInfo.blankCount} 空，只需最简标准答案）】`,
            essay: '【大题（计算题/证明题/简答题/论述题，必须给出完整规范的解答步骤或分点答案）】'
        };
        const qTypeHint = qTypeHintMap[qTypeInfo.kind] || '【单选题】';

        const formattedOptions = q.options.length > 0
            ? q.options.map(o => `选项 ${o.letter}: ${o.cleanContent}`).join('\n')
            : (qTypeInfo.kind === 'essay' ? '（本题为大题/主观解答题，无候选选项，请输出完整规范解答步骤）' : '（本题为填空题，无候选选项）');

        const wrongExclusionNote = (memoryEntry && Array.isArray(memoryEntry.wrongLetters) && memoryEntry.wrongLetters.length > 0)
            ? `⚠️【重要错题排除指令】：本题上次提交选择【${memoryEntry.wrongLetters.join(', ')}】被判 0 分错误！严禁再选 ${memoryEntry.wrongLetters.join(', ')}，请从其余选项重新推导！`
            : '';

        const systemPrompt = buildSystemPrompt(isMath, isMaritime, qTypeInfo);

        const userPrompt = [
            `题目类型：${qTypeHint}${isMath ? '（高等数学/数学计算题）' : ''}`,
            `当前题干：${q.stemText}`,
            `候选选项：\n${formattedOptions}`,
            webClues ? `【🌐 联网参考摘要（共 ${searchRes.count} 条${isMath ? '，仅供参考，数学题必须独立验算' : ''}）】：\n${webClues}` : '',
            paperContextSummary ? `【📄 同卷其它题目互证摘要】：\n${paperContextSummary}` : '',
            wrongExclusionNote
        ].filter(Boolean).join('\n\n');

        const buildPayload = (modelName) => {
            const p = {
                model: modelName,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ]
            };
            if (modelName === 'deepseek-chat') {
                p.temperature = 0.0;
                p.response_format = { type: 'json_object' };
            }
            return p;
        };

        let res = await callDeepSeekWithRetry(buildPayload(useModel), useModel);

        if (!res.ok && useModel === 'deepseek-reasoner') {
            useModel = 'deepseek-chat';
            res = await callDeepSeekWithRetry(buildPayload(useModel), useModel);
        }

        if (!res.ok) {
            addLog({
                scene,
                model: useModel === 'deepseek-reasoner' ? 'R1(失败)' : 'V3(失败)',
                web: searchRes.count > 0 ? `命中${searchRes.count}条` : searchRes.status,
                ms: Date.now() - startTime,
                stem: q.stemText.slice(0, 36),
                answer: `HTTP ${res.status}`,
                thinking: '请求失败或超时'
            });
            return null;
        }

        let parsed = null;
        try {
            const data = JSON.parse(res.text);
            const msgObj = data.choices?.[0]?.message || {};
            parsed = safeParseAIJson(msgObj.content || '{}', msgObj.reasoning_content || '');
        } catch (e) {
            console.error('[DeepSeek Parse]', e);
            return null;
        }

        if (!parsed) return null;
        parsed.usedWebSearch = Boolean(webClues);
        parsed.webCount = searchRes.count;
        parsed.usedModel = useModel;
        parsed.isMath = isMath;
        parsed.questionKind = qTypeInfo.kind;

        // 智能分流模式下若 V3 置信度低于阈值或未能匹配选项，自动升级 R1 复核
        const conf = typeof parsed.confidence === 'number' ? parsed.confidence : 0.9;
        const matchedNow = q.options.length > 0 ? matchOptionsAccurately(q.options, parsed) : [1];
        if (!overrideModel && STATE.modelMode === 'auto' && useModel === 'deepseek-chat' && (conf < CONFIG.autoEscalateThreshold || matchedNow.length === 0)) {
            const r1Res = await callDeepSeekWithRetry(buildPayload('deepseek-reasoner'), 'deepseek-reasoner');
            if (r1Res.ok) {
                try {
                    const r1Data = JSON.parse(r1Res.text);
                    const r1Msg = r1Data.choices?.[0]?.message || {};
                    const r1Parsed = safeParseAIJson(r1Msg.content || '{}', r1Msg.reasoning_content || '');
                    if (r1Parsed) {
                        r1Parsed.usedWebSearch = Boolean(webClues);
                        r1Parsed.webCount = searchRes.count;
                        r1Parsed.usedModel = 'deepseek-reasoner';
                        r1Parsed.isMath = isMath;
                        r1Parsed.questionKind = qTypeInfo.kind;
                        r1Parsed.escalated = true;
                        parsed = r1Parsed;
                    }
                } catch (_) {}
            }
        }

        if (stemKey) {
            STATE.sessionCache.set(`${stemKey}::${parsed.usedModel}`, parsed);
            STATE.sessionCache.set(sessionKey, parsed);
        }

        addLog({
            scene,
            model: parsed.usedModel === 'deepseek-reasoner' ? (parsed.escalated ? 'R1复核' : 'R1深度') : 'V3',
            web: searchRes.count > 0 ? `命中${searchRes.count}条` : (searchRes.status === 'skipped-math' ? '数学跳过' : '未命中'),
            ms: Date.now() - startTime,
            stem: q.stemText.slice(0, 36),
            answer: (parsed.answerLetters || []).join('') || (parsed.answerTexts || []).join('|'),
            thinking: parsed.thinking || ''
        });

        return parsed;
    }

    function normalizeForOptionMatch(str) {
        return String(str || '')
            .replace(/^\s*[（(]?[A-H][)）.、．:：\s]\s*/i, '')
            .replace(/\$+/g, '')
            .replace(/[−–—]/g, '-')
            .replace(/×/g, '*')
            .replace(/÷/g, '/')
            .replace(/（/g, '(')
            .replace(/）/g, ')')
            .replace(/\s+/g, '')
            .toLowerCase()
            .trim();
    }

    function detectTrueFalsePolarity(str) {
        const s = normalizeForOptionMatch(str);
        if (/^(对|正确|true|t|√|yes|是)$/.test(s)) return 'true';
        if (/^(错|错误|false|f|×|no|否)$/.test(s)) return 'false';
        return '';
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
            const normTarget = normalizeForOptionMatch(texts[0]);
            if (normTarget.length >= 1) {
                const exactOpt = qOptions.find(o => normalizeForOptionMatch(o.cleanContent) === normTarget);
                if (exactOpt) {
                    addUnique(exactOpt);
                    return matched;
                }
            }
        }

        for (const letChar of letters) {
            const byLetter = qOptions.find(o => o.letter === letChar);
            if (byLetter) addUnique(byLetter);
        }

        if (matched.length === 0 && texts.length > 0 && qOptions.length === 2) {
            const targetPol = detectTrueFalsePolarity(texts[0]);
            if (targetPol) {
                const tfOpt = qOptions.find(o => detectTrueFalsePolarity(o.cleanContent) === targetPol);
                if (tfOpt) {
                    addUnique(tfOpt);
                    return matched;
                }
            }
        }

        if (matched.length === 0 && texts.length > 0) {
            for (const t of texts) {
                const normT = normalizeForOptionMatch(t);
                if (!normT) continue;
                const bySub = qOptions.find(o => {
                    const normO = normalizeForOptionMatch(o.cleanContent);
                    return normO === normT || (normT.length >= 2 && (normO.includes(normT) || normT.includes(normO)));
                });
                if (bySub) addUnique(bySub);
            }
        }

        return matched;
    }

    function applyAnswerToQuestion(q, parsed) {
        const qTypeInfo = classifyQuestionType(q);
        const matchedOpts = matchOptionsAccurately(q.options, parsed);
        const ansTexts = Array.isArray(parsed?.answerTexts)
            ? parsed.answerTexts.map(t => String(t).trim()).filter(Boolean)
            : (parsed?.answer ? [String(parsed.answer).trim()] : []);

        if (matchedOpts.length > 0) {
            return { type: 'choice', kind: qTypeInfo.kind, matchedOpts, ansTexts };
        }
        if (q.inputs && q.inputs.length > 0 && ansTexts.length > 0) {
            return { type: 'input', kind: qTypeInfo.kind, matchedOpts: [], ansTexts };
        }
        if (ansTexts.length > 0) {
            return { type: 'display-only', kind: qTypeInfo.kind, matchedOpts: [], ansTexts };
        }
        return { type: 'none', kind: qTypeInfo.kind, matchedOpts: [], ansTexts };
    }

    function buildFullPaperCrossContext(allQuestions) {
        return allQuestions.map((q, i) => {
            const optsInline = q.options.map(o => `${o.letter}.${o.cleanContent}`).join(' ');
            return `T${i + 1}: ${q.stemText.slice(0, 95)} [${optsInline.slice(0, 95)}]`;
        }).join('\n').slice(0, 3400);
    }

    /********************************************************************
     * 11. 准确率优先 全卷自动连刷流水线
     ********************************************************************/
    async function startFullPageAutoSweep() {
        harvestGradedPageAnswers();

        const ui = getUIElements();
        if (!ensureApiKeyReady()) return;
        if (STATE.isBatchRunning) return;

        const allQuestions = collectAllQuestionsOnPage();
        if (allQuestions.length === 0) {
            showCard();
            if (ui.contentBox) {
                ui.contentBox.innerHTML = `<div style="color:#f59e0b;">⚠️ 未在当前页面扫描到题目列表，请确认题目已加载完毕。</div>`;
            }
            return;
        }

        STATE.isBatchRunning = true;
        STATE.stopBatchRequested = false;
        startTurboSpinEffect();
        showCard();

        const total = allQuestions.length;
        let completedCount = 0;

        const concurrency = STATE.modelMode === 'deepseek-chat'
            ? CONFIG.concurrencyChat
            : CONFIG.concurrencyReasoner;

        const paperContextSummary = buildFullPaperCrossContext(allQuestions);
        const resultPromises = new Array(total);
        let nextPrefetchIdx = 0;

        function triggerPrefetchUpTo(limitIdx) {
            const maxIdx = Math.min(total, limitIdx);
            while (nextPrefetchIdx < maxIdx && !STATE.stopBatchRequested) {
                const idx = nextPrefetchIdx++;
                resultPromises[idx] = requestSingleQuestionCoTAnalysis(allQuestions[idx], paperContextSummary, {
                    scene: `连刷#${idx + 1}`
                });
            }
        }

        triggerPrefetchUpTo(concurrency);

        const updateSweepProgressUI = (curNum, titlePreview, answerPreview, thinkingNote, parsedMeta = {}) => {
            if (!ui.contentBox) return;
            const pct = Math.round((curNum / total) * 100);
            const badges = [];
            if (parsedMeta.isMath) badges.push('<span class="ds-badge ds-badge-math">📐 高数验算</span>');
            if (parsedMeta.usedModel === 'deepseek-reasoner') badges.push('<span class="ds-badge">🔬 R1深度</span>');
            else if (parsedMeta.usedModel === 'memory') badges.push('<span class="ds-badge">📚 题库命中</span>');
            if (parsedMeta.webCount > 0) badges.push(`<span class="ds-badge">🌐 搜到${parsedMeta.webCount}条</span>`);

            ui.contentBox.innerHTML = `
                <div style="display:flex;justify-content:space-between;align-items:center;color:#34d399;font-weight:600;font-size:12.5px;">
                    <span>🔬 全卷最高准连刷 (${curNum}/${total})</span>
                    <span style="font-size:11px;color:#94a3b8;">轻点 ⚡ 暂停</span>
                </div>
                <div class="ds-progress-bar-bg">
                    <div class="ds-progress-bar-fill" style="width:${pct}%;"></div>
                </div>
                <div class="ds-answer-box" style="margin-top:6px;margin-bottom:2px;">
                    <div class="ds-answer-meta">
                        <span>第 ${curNum} 题：${escapeHtml(titlePreview.slice(0, 24))}...</span>
                        ${badges.join('')}
                    </div>
                    <div class="ds-answer-main">${escapeHtml(answerPreview || '🔬 正在 R1 深度推导与验算...')}</div>
                    ${thinkingNote ? `<div class="ds-answer-sub">${escapeHtml(thinkingNote.slice(0, 120))}</div>` : ''}
                </div>
            `;
        };

        for (let i = 0; i < total; i++) {
            if (STATE.stopBatchRequested) break;

            triggerPrefetchUpTo(i + 1 + concurrency);

            const q = allQuestions[i];
            const curNum = i + 1;
            const qIsMath = isMathQuestion(q.stemText, q.options);

            q.blockEl.classList.add('ds-scope-flash');
            updateSweepProgressUI(
                curNum,
                q.stemText,
                qIsMath ? '📐 高数题：R1 深度演算与反向验算中...' : '🔬 R1 深度推理 + 联网核对中...',
                '',
                { isMath: qIsMath }
            );

            const [parsed] = await Promise.all([
                resultPromises[i],
                smoothScrollToElementAsync(q.blockEl, 220)
            ]);

            if (STATE.stopBatchRequested) {
                q.blockEl.classList.remove('ds-scope-flash');
                break;
            }

            const action = applyAnswerToQuestion(q, parsed);

            if (action.type === 'choice') {
                const ansDisplay = action.matchedOpts.map(o => `${o.letter}. ${o.cleanContent}`).join(' | ');
                updateSweepProgressUI(curNum, q.stemText, `✅ 已选：${ansDisplay}`, parsed?.thinking || '', parsed || {});
                for (const opt of action.matchedOpts) {
                    clickOptionElementReliably(opt.el);
                    if (action.matchedOpts.length > 1) await sleep(140);
                }
                completedCount++;
            } else if (action.type === 'input') {
                const isEssay = action.kind === 'essay';
                if (isEssay) {
                    const fullEssay = action.ansTexts.join('\n');
                    const inp = q.inputs[0];
                    inp.focus();
                    setNativeInputValue(inp, fullEssay, true);
                    inp.classList.add('ds-correct-highlight');
                    updateSweepProgressUI(curNum, q.stemText, `📝 大题已填：${fullEssay.slice(0, 60)}${fullEssay.length > 60 ? '...' : ''}`, parsed?.thinking || '', parsed || {});
                } else {
                    for (let k = 0; k < q.inputs.length; k++) {
                        const val = action.ansTexts[k] ?? action.ansTexts[0];
                        if (val !== undefined) {
                            const inp = q.inputs[k];
                            inp.focus();
                            setNativeInputValue(inp, String(val).trim(), false);
                            inp.classList.add('ds-correct-highlight');
                        }
                    }
                    updateSweepProgressUI(curNum, q.stemText, `✍️ 填空已填：${action.ansTexts.join(' | ')}`, parsed?.thinking || '', parsed || {});
                }
                completedCount++;
            } else if (action.type === 'display-only') {
                const preview = action.ansTexts.join('\n');
                updateSweepProgressUI(curNum, q.stemText, `📝 无输入框大题（可在日志/单题复制）：${preview.slice(0, 70)}...`, parsed?.thinking || '', parsed || {});
                completedCount++;
            } else {
                updateSweepProgressUI(curNum, q.stemText, action.ansTexts[0] || '⚠️ 未匹配到选项', parsed?.thinking || '', parsed || {});
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
                        <div class="ds-answer-sub">已完成 ${completedCount} / ${total} 题。点右上角 📋 可查看每题诊断日志。</div>
                    </div>
                `;
            } else {
                ui.contentBox.innerHTML = `
                    <div class="ds-answer-box">
                        <div class="ds-answer-main">🎉 全卷 ${completedCount} / ${total} 题已全部选完！</div>
                        <div class="ds-answer-sub">已完成【🔬 R1 深度验算 + 🌐 限速联网核对】作答，点右上角 📋 可查看每题详细日志。</div>
                    </div>
                `;
            }
        }
    }

    /********************************************************************
     * 12. 单题解析功能（与连刷共用同一套题干提取对象，彻底消除不一致）
     ********************************************************************/
    function findSingleQuestionObject(allQuestions) {
        const ui = getUIElements();
        const hitUnderMouse = document.elementFromPoint(STATE.lastMousePos.x, STATE.lastMousePos.y);
        let picked = (STATE.lastPickedScope && STATE.lastPickedScope.ownerDocument?.body.contains(STATE.lastPickedScope))
            ? STATE.lastPickedScope
            : (hitUnderMouse || document.activeElement);

        if (picked && (picked === ui.fab || ui.fab?.contains(picked) || picked === ui.card || ui.card?.contains(picked))) {
            picked = null;
        }

        // 优先从 collectAllQuestionsOnPage() 中直接匹配，确保单题与连刷的 blockEl/stemText/options 100% 相同！
        if (allQuestions && allQuestions.length > 0) {
            if (picked) {
                const containing = allQuestions.find(q => q.blockEl === picked || q.blockEl.contains(picked));
                if (containing) return containing;
            }
            const inView = allQuestions.find(q => {
                const r = q.blockEl.getBoundingClientRect();
                return r.bottom > 60 && r.top < window.innerHeight - 60;
            }) || allQuestions[0];
            if (inView) return inView;
        }

        // 兜底：当页面未命中标准题目块时向上回溯
        let curr = picked;
        let depth = 0;
        while (curr && curr !== document.body && depth < 12) {
            const opts = extractOptionsFromBlock(curr);
            const inps = extractInputsFromBlock(curr);
            if ((opts.length >= 2 && opts.length <= 8) || (inps.length >= 1 && extractRichMathText(curr).length >= 5)) {
                return {
                    index: 0,
                    blockEl: curr,
                    options: opts,
                    inputs: inps,
                    stemText: extractPureQuestionStem(curr, opts, inps[0] || null).slice(0, 1400)
                };
            }
            curr = curr.parentElement;
            depth++;
        }

        const fallbackOpts = extractOptionsFromBlock(document.body);
        const fallbackInps = extractInputsFromBlock(document.body);
        return {
            index: 0,
            blockEl: document.body,
            options: fallbackOpts,
            inputs: fallbackInps,
            stemText: extractPureQuestionStem(document.body, fallbackOpts, fallbackInps[0] || null).slice(0, 1400)
        };
    }

    function renderSingleResult(qObj, parsed, paperContextSummary) {
        const ui = getUIElements();
        if (!ui.contentBox) return;

        if (!parsed) {
            ui.contentBox.innerHTML = `<div style="color:#ef4444;">❌ 解析失败，请检查 API Key 余额或网络（点右上角 ⚙️ 可修改 Key，📋 可看日志）。</div>`;
            return;
        }

        const action = applyAnswerToQuestion(qObj, parsed);
        action.matchedOpts.forEach(opt => opt.el.classList.add('ds-correct-highlight'));
        const isEssay = action.kind === 'essay';

        const ansDisplay = action.type === 'choice'
            ? action.matchedOpts.map(o => `${o.letter}. ${o.cleanContent}`).join(' | ')
            : (isEssay ? action.ansTexts.join('\n') : (action.ansTexts.join(' | ') || '已解析'));

        const badges = [];
        if (isEssay) badges.push('<span class="ds-badge ds-badge-math">📝 大题完整解答</span>');
        else if (action.kind === 'blank') badges.push('<span class="ds-badge">✍️ 填空题</span>');
        if (parsed.isMath) badges.push('<span class="ds-badge ds-badge-math">📐 高数专项</span>');
        if (parsed.usedModel === 'deepseek-reasoner') {
            badges.push(`<span class="ds-badge">🔬 R1深度${parsed.escalated ? '复核' : '验算'}</span>`);
        } else if (parsed.usedModel === 'memory') {
            badges.push('<span class="ds-badge">📚 已验证题库</span>');
        } else {
            badges.push(`<span class="ds-badge">⚡ V3推理</span>`);
        }
        if (parsed.webCount > 0) {
            badges.push(`<span class="ds-badge">🌐 搜到${parsed.webCount}条</span>`);
        }

        const canApply = action.type === 'choice' || action.type === 'input';
        const copyableText = action.ansTexts.length > 0 ? action.ansTexts.join('\n') : ansDisplay;

        ui.contentBox.innerHTML = `
            <div class="ds-answer-box">
                <div class="ds-answer-meta">${badges.join('')}</div>
                <div class="ds-answer-main${isEssay ? ' ds-answer-essay' : ''}">${escapeHtml(ansDisplay)}</div>
                ${parsed.thinking ? `<div class="ds-answer-sub">${escapeHtml(parsed.thinking)}</div>` : ''}
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:2px;">
                ${canApply ? `<button class="ds-btn ds-btn-fill" id="ds-single-apply-btn">✅ 一键点选/填入本题</button>` : ''}
                ${copyableText ? `<button class="ds-btn" id="ds-single-copy-btn">📋 复制答案</button>` : ''}
                <button class="ds-btn ds-btn-accent" id="ds-single-r1-btn">🔄 R1重算</button>
            </div>
        `;

        const applyBtn = ui.contentBox.querySelector('#ds-single-apply-btn');
        if (applyBtn) {
            applyBtn.addEventListener('click', async () => {
                if (action.type === 'choice') {
                    for (const opt of action.matchedOpts) {
                        clickOptionElementReliably(opt.el);
                        if (action.matchedOpts.length > 1) await sleep(120);
                    }
                    applyBtn.innerText = '✅ 已自动点选';
                } else if (action.type === 'input') {
                    if (isEssay) {
                        const inp = qObj.inputs[0];
                        inp.focus();
                        setNativeInputValue(inp, action.ansTexts.join('\n'), true);
                        inp.classList.add('ds-correct-highlight');
                    } else {
                        for (let k = 0; k < qObj.inputs.length; k++) {
                            const val = action.ansTexts[k] ?? action.ansTexts[0];
                            if (val !== undefined) {
                                qObj.inputs[k].focus();
                                setNativeInputValue(qObj.inputs[k], String(val).trim(), false);
                                qObj.inputs[k].classList.add('ds-correct-highlight');
                            }
                        }
                    }
                    applyBtn.innerText = '✅ 已自动填入';
                }
            });
        }

        const copyBtn = ui.contentBox.querySelector('#ds-single-copy-btn');
        if (copyBtn) {
            copyBtn.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(copyableText);
                    copyBtn.innerText = '✅ 已复制';
                    setTimeout(() => { copyBtn.innerText = '📋 复制答案'; }, 1200);
                } catch (_) {
                    prompt('复制以下解答内容：', copyableText);
                }
            });
        }

        const r1Btn = ui.contentBox.querySelector('#ds-single-r1-btn');
        if (r1Btn) {
            r1Btn.addEventListener('click', () => {
                if (STATE.isAnalyzing) return;
                STATE.isAnalyzing = true;
                if (ui.fab) ui.fab.classList.add('ds-loading');
                ui.contentBox.innerHTML = `
                    <div style="display:flex;align-items:center;gap:8px;color:#d8b4fe;">
                        <span>🔬</span>
                        <span>正在忽略缓存，调用 DeepSeek-R1 重新深度演算...</span>
                    </div>
                `;
                requestSingleQuestionCoTAnalysis(qObj, paperContextSummary, {
                    overrideModel: 'deepseek-reasoner',
                    forceFresh: true,
                    scene: 'R1重算'
                }).then((r1Parsed) => {
                    STATE.isAnalyzing = false;
                    if (ui.fab) ui.fab.classList.remove('ds-loading');
                    renderSingleResult(qObj, r1Parsed, paperContextSummary);
                });
            });
        }
    }

    function triggerSingleQuestionAnalysis() {
        const harvested = harvestGradedPageAnswers();
        if (harvested.learnedRight > 0 || harvested.learnedWrong > 0) {
            return;
        }

        const ui = getUIElements();
        if (!ensureApiKeyReady()) return;
        if (STATE.isAnalyzing || STATE.isBatchRunning) return;

        const allQuestions = collectAllQuestionsOnPage();
        const qObj = findSingleQuestionObject(allQuestions);
        const paperContextSummary = buildFullPaperCrossContext(allQuestions);

        if (qObj.blockEl && qObj.blockEl !== document.body) {
            qObj.blockEl.classList.add('ds-scope-flash');
            setTimeout(() => qObj.blockEl.classList.remove('ds-scope-flash'), 700);
        }

        const qIsMath = isMathQuestion(qObj.stemText, qObj.options);
        STATE.lastSingleContext = { qObj, paperContextSummary };

        showCard();
        if (ui.contentBox) {
            ui.contentBox.innerHTML = `
                <div style="display:flex;align-items:center;gap:8px;color:${qIsMath ? '#d8b4fe' : '#38bdf8'};">
                    <span>${qIsMath ? '📐' : '🔬'}</span>
                    <span>${qIsMath ? '识别为高数/计算题，正在 R1 深度演算与反向验算...' : '正在 R1 深度推理 + 联网核对与全卷互证...'}</span>
                </div>
                <div style="font-size:11.5px;color:#94a3b8;margin-top:4px;">题目：${escapeHtml(qObj.stemText.slice(0, 48))}...</div>
            `;
        }
        if (ui.fab) ui.fab.classList.add('ds-loading');
        STATE.isAnalyzing = true;

        requestSingleQuestionCoTAnalysis(qObj, paperContextSummary, { scene: '单题' }).then((parsed) => {
            STATE.isAnalyzing = false;
            if (ui.fab) ui.fab.classList.remove('ds-loading');
            renderSingleResult(qObj, parsed, paperContextSummary);
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

    function setNativeInputValue(el, val, isEssay = false) {
        if (!el) return;
        const textVal = String(val ?? '');
        try {
            el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: textVal, bubbles: true }));
        } catch (_) {}
        if (el.isContentEditable) {
            if (isEssay && textVal.includes('\n')) {
                el.innerHTML = textVal
                    .split(/\r?\n/)
                    .map(line => `<p>${escapeHtml(line) || '<br>'}</p>`)
                    .join('');
            } else {
                el.innerText = textVal;
            }
        } else {
            const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) setter.call(el, textVal);
            else el.value = textVal;
        }
        try {
            el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: textVal, bubbles: true }));
        } catch (_) {
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        try { el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: ' ' })); } catch (_) {}
        el.dispatchEvent(new Event('change', { bubbles: true }));
        try { el.dispatchEvent(new Event('blur', { bubbles: true })); } catch (_) {}
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
