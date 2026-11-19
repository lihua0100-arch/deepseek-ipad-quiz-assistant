// ==UserScript==
// @name    DeepSeek 智能题库助手 (iPad 学习通/U校园/全平台触屏通用版)
// @namespace    https://tampermonkey.net/
// @version      3.5.0
// @updateURL    https://raw.githubusercontent.com/lihua0100-arch/deepseek-ipad-quiz-assistant/main/deepseek-ipad-quiz-assistant.user.js
// @downloadURL  https://raw.githubusercontent.com/lihua0100-arch/deepseek-ipad-quiz-assistant/main/deepseek-ipad-quiz-assistant.user.js
// @description  全面适配手机 / iPad Safari / Mac / PC（学习通、U校园、超星尔雅、雨课堂、智慧树）：1.高数专项引擎：无损提取 KaTeX/MathJax/MathML/上下标/公式图片 LaTeX，高数与计算题自动路由 DeepSeek-R1 深度推理+反向验算；2.普通题 V3+Bing/百度实时联网搜题(RAG)+全卷互证，低置信度自动升级 R1 复核；3.全新手机端底部自适应抽屉与防误触悬浮球，内置设置面板与一键重算！
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
        concurrencyChat: 6,       // V3 极速并发数
        concurrencyReasoner: 4,   // R1 深度推理并发数（兼顾速度与限流保护）
        searchTimeoutMs: 3200,    // 联网搜索超时（毫秒）
        chatTimeoutMs: 38000,     // V3 请求超时
        reasonerTimeoutMs: 98000, // R1 深度推理超时（高数多步验算需要更充裕时间）
        maxRetries: 2,            // 遇到 429 / 5xx / 网络波动自动重试次数
        autoEscalateThreshold: 0.78 // 智能模式下，V3 置信度低于此值自动升级 R1 复核
    };

    const MODEL_MODES = ['auto', 'deepseek-reasoner', 'deepseek-chat'];

    function loadSavedModelMode() {
        const v35 = GM_getValue('DEEPSEEK_MODEL_V35', '');
        if (MODEL_MODES.includes(v35)) return v35;
        return 'auto'; // v3.5 默认开启【智能路由：高数/疑难题自动 R1，普通题 V3+联网】
    }

    const STATE = {
        apiKey: GM_getValue('DEEPSEEK_API_KEY', ''),
        modelMode: loadSavedModelMode(),
        webSearchEnabled: GM_getValue('DEEPSEEK_WEB_SEARCH', true),
        verifiedBank: GM_getValue('DEEPSEEK_VERIFIED_BANK', {}),
        isAnalyzing: false,
        isBatchRunning: false,
        stopBatchRequested: false,
        lastPickedScope: null,
        lastSingleContext: null,
        lastMousePos: { x: window.innerWidth / 2, y: window.innerHeight / 2 }
    };

    function getModelModeLabel(mode = STATE.modelMode) {
        if (mode === 'auto') return '🧠 智能(高数R1)';
        if (mode === 'deepseek-reasoner') return '🔬 强制R1深度';
        return '⚡ V3极速';
    }

    // 新版题干归一化键：保留数学运算符号（+ - * / ^ = < > √ ∫ ∑ ∞），防止高数中 f(x) 与 f(-x) 撞键
    function normalizeStemKey(text) {
        return String(text || '')
            .replace(/^\s*\d+[.、\s)）]*/, '')
            .replace(/\(\s*[单多判填简计算证明]选题?.*?\)/g, '')
            .replace(/[\s_—，。；：？！、,.?;:!（）【】\[\]"'“”‘’$]/g, '')
            .slice(0, 100);
    }

    // 兼容 3.4 及以前版本的旧题库键，确保已记忆的满分题库无缝命中
    function normalizeLegacyStemKey(text) {
        return String(text || '')
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

        // 如果 MathML 内自带 TeX annotation，直接返回最精准的原生 LaTeX
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
     * 无损提取含高等数学公式的节点文本：
     * 支持 KaTeX / MathJax v2 & v3 / MathML / Quill Formula / HTML sup & sub / 公式 img
     */
    function extractRichMathText(node) {
        if (!node) return '';
        const clone = node.cloneNode(true);
        const doc = clone.ownerDocument || document;

        const replaceWithText = (el, text) => {
            if (!el || !el.parentNode) return;
            el.replaceWith(doc.createTextNode(text));
        };

        // 1. 移除干扰与不可见元素（保留 script[type^="math/tex"]）
        clone.querySelectorAll('style, noscript, .ans-icon, .font-cxsecret-ignore, .marking_duigou, .marking_cuowu').forEach(el => el.remove());
        clone.querySelectorAll('script').forEach(sc => {
            const t = (sc.getAttribute('type') || '').toLowerCase();
            if (!t.startsWith('math/tex') && !t.startsWith('math/mml')) {
                sc.remove();
            }
        });

        // 2. 处理 KaTeX（优先读取原生 application/x-tex 注解，避免分子分母错位和重复）
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

        // 4. 处理 MathJax v2 (script[type^="math/tex"] + .MathJax)
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

        // 8. 处理 HTML <sup> / <sub>（自内向外处理，防止嵌套错乱）
        const supSubNodes = Array.from(clone.querySelectorAll('sup, sub')).reverse();
        for (const el of supSubNodes) {
            if (!el.isConnected) continue;
            const inner = (el.textContent || '').replace(/\s+/g, '').trim();
            if (!inner) continue;
            const prefix = el.tagName.toLowerCase() === 'sup' ? '^' : '_';
            replaceWithText(el, inner.length === 1 ? `${prefix}${inner}` : `${prefix}{${inner}}`);
        }

        // 9. 读取最终文本并清理零宽字符与多余空白
        const raw = (clone.textContent || '')
            .replace(/[\u200B-\u200D\uFEFF]/g, '')
            .replace(/\u00A0/g, ' ')
            .replace(/[ \t\r\n]+/g, ' ')
            .trim();
        return raw;
    }

    /**
     * 精准识别高等数学 / 线性代数 / 概率论 / 数学计算推导题
     */
    function isMathQuestion(stemText, optionsList = []) {
        const combined = `${stemText || ''} ${(optionsList || []).map(o => o.cleanContent || o.text || '').join(' ')}`;

        // 1. LaTeX 公式命令或明显数学符号
        if (/\\(frac|int|lim|sum|prod|sqrt|sin|cos|tan|cot|sec|csc|arcsin|arccos|arctan|ln|log|exp|infty|to|rightarrow|partial|nabla|cdot|times|leq|geq|neq|approx|equiv|alpha|beta|gamma|delta|theta|lambda|mu|sigma|phi|omega|pi|Delta|Sigma|Omega|begin\{matrix\})/i.test(combined)) {
            return true;
        }
        if (/[∫∬∭∮∑∏∂∇∞√≤≥≠≈≡∈∉⊂⊆∪∩∀∃⇒⇔]/.test(combined)) {
            return true;
        }
        // 2. 高数/线代/概率论核心关键词
        if (/(高等数学|高数|微积分|极限|求导|导数|高阶导|隐函数|参数方程求导|微分|偏导|全微分|方向导数|梯度|散度|旋度|原函数|不定积分|定积分|反常积分|广义积分|二重积分|三重积分|曲线积分|曲面积分|格林公式|高斯公式|斯托克斯|级数|收敛|发散|收敛域|收敛半径|幂级数|傅里叶|泰勒|麦克劳林|洛必达|罗尔定理|拉格朗日|柯西中值|中值定理|间断点|可去间断|跳跃间断|无穷间断|连续性|可导|可微|拐点|凹凸性|极值|驻点|渐近线|切线方程|法线方程|曲率|微分方程|通解|特解|齐次|非齐次|特征方程|等价无穷小|无穷小|无穷大|矩阵|行列式|秩|特征值|特征向量|线性相关|线性无关|极大无关组|向量空间|二次型|正定|逆矩阵|伴随矩阵|随机变量|概率密度|分布函数|数学期望|方差|协方差|正态分布|泊松分布|二项分布|指数分布|均匀分布|中心极限定理|大数定律|参数估计|极大似然|假设检验)/.test(combined)) {
            return true;
        }
        // 3. 常见数学表达式模式（如 f(x), f'(x), y'', dx, dy, sinx, e^x, x->0）
        if (/\b(f\s*['′″]?\s*\([a-z,\s]+\)|y\s*['′″]+|d[xyzt]\s*\/\s*d[xyzt]|lim\s*[\(_]?[a-z]|sin\s*[a-z(]|cos\s*[a-z(]|tan\s*[a-z(]|ln\s*[\|(x]|log_?\d*\s*\(|e\^\{?[-\w+]+|\^[{\-]?\d+|_[{\-]?\d+)/i.test(combined)) {
            return true;
        }
        if (/(\b[xy]\s*(->|→)\s*[0∞+\-\d]|d[xyz]\b.*\b(积分|求|等于|=))/.test(combined)) {
            return true;
        }
        return false;
    }

    function isMaritimeQuestion(stemText, optionsList = []) {
        const combined = `${stemText || ''} ${(optionsList || []).map(o => o.cleanContent || '').join(' ')}`;
        return /(集装箱|散装|散货|IMSBC|箱位|船舶|横倾|配载|岸桥|舱内|甲板|1CC|1AA|种子饼|平舱)/i.test(combined);
    }

    /********************************************************************
     * 3. 实时联网搜题引擎 (Web Search RAG via GM_xmlhttpRequest)
     ********************************************************************/
    function cleanSearchQuery(stemText) {
        return String(stemText || '')
            .replace(/^\s*\d+[.、\s)）]*/, '')
            .replace(/\(\s*[单多判填简计算]选题?[^)]*\)/g, '')
            .replace(/\[\[.*?\]\]/g, ' ')
            .replace(/\$+/g, ' ')
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

    async function searchWebForQuestionClues(stemText, optionsList = [], isMath = false) {
        if (!STATE.webSearchEnabled) return '';
        // 纯符号高数计算题联网容易搜到系数/符号不同的近似题产生误导，直接走 R1 独立推导更准更快
        const query = cleanSearchQuery(stemText);
        if (query.length < 6) return '';
        if (isMath && (query.replace(/[^a-zA-Z0-9\\^_{}()+\-*/=]/g, '').length / Math.max(1, query.length) > 0.55)) {
            return '';
        }

        const optKeywords = optionsList.slice(0, 4).map(o => o.cleanContent).join(' ').replace(/\$+/g, '');
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
     * 5. 手机 + iPad + PC 响应式 UI 样式
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
            width: 376px;
            max-width: calc(100vw - 24px);
            max-height: 70vh;
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

        #ds-settings-panel {
            display: none;
            background: rgba(30, 41, 59, 0.9);
            border: 1px solid rgba(56, 189, 248, 0.35);
            border-radius: 10px;
            padding: 10px;
            margin-bottom: 8px;
            flex-shrink: 0;
        }
        #ds-settings-panel.ds-show {
            display: block;
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
            gap: 6px;
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

        /* 手机端窄屏自适应：底部抽屉卡片 + 紧凑悬浮球 + 大触控区 */
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
                max-height: 58vh;
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

    function openSettingsInCard(tipMsg = '') {
        const ui = getUIElements();
        showCard();
        if (ui.settingsPanel) {
            ui.settingsPanel.classList.add('ds-show');
        }
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
        // 手机端优先打开内置设置面板输入 Key，避免移动浏览器拦截 window.prompt
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
        fabEl.title = '轻点1下：高数/联网解析单题 | 长按或连点3下：全卷高准自动连刷！';
        document.body.appendChild(fabEl);

        cardEl = document.createElement('div');
        cardEl.id = 'ds-card';
        cardEl.innerHTML = `
            <div class="ds-card-header">
                <span class="ds-card-title">📐 DeepSeek 题库助手 3.5 (高数+手机增强)</span>
                <span class="ds-header-icons">
                    <button class="ds-icon-btn" id="ds-card-settings-btn" title="设置 API Key 与题库">⚙️</button>
                    <button class="ds-icon-btn" id="ds-card-close-btn" title="关闭">✕</button>
                </span>
            </div>
            <div id="ds-settings-panel">
                <div style="font-size:12px;color:#94a3b8;">DeepSeek API Key（保存在本地油猴存储，跨版本保留）：</div>
                <div class="ds-setting-row">
                    <input class="ds-input" id="ds-apikey-input" type="password" placeholder="sk-..." autocomplete="off" />
                    <button class="ds-btn ds-btn-fill" id="ds-apikey-save-btn" style="flex:0 0 auto;">保存</button>
                </div>
                <div class="ds-setting-row" style="justify-content:space-between;margin-top:8px;font-size:11.5px;color:#94a3b8;">
                    <span>本地已记忆题库：<b id="ds-bank-count" style="color:#38bdf8;">0</b> 题</span>
                    <button class="ds-btn" id="ds-bank-clear-btn" style="flex:0 0 auto;min-height:28px;padding:3px 8px;font-size:11px;">清空记忆库</button>
                </div>
            </div>
            <div id="ds-card-content">
                <div style="color:#cbd5e1;font-size:12px;line-height:1.6;">
                    • <b>轻点 1 下 🎯</b>：解析当前题目（高数自动提取公式并启动 <b>R1 深度验算</b>）<br>
                    • <b>长按 🎯 或 连点 3 下 🎯</b>：全卷高准自动连刷（高数 R1 + 普通题联网互证）<br>
                    • <b>拖动 🎯</b>：可自由挪动悬浮球位置，不遮挡手机选项
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

        document.getElementById('ds-card-settings-btn').addEventListener('click', () => {
            const panel = document.getElementById('ds-settings-panel');
            if (!panel) return;
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
            GM_setValue('DEEPSEEK_MODEL_V35', STATE.modelMode);
            e.currentTarget.innerText = getModelModeLabel(STATE.modelMode);
        });

        // 注册油猴菜单命令（桌面/iPad 快捷入口）
        if (typeof GM_registerMenuCommand === 'function') {
            GM_registerMenuCommand('🔑 设置 DeepSeek API Key', () => openSettingsInCard('🔑 请在下方输入 DeepSeek API Key'));
            GM_registerMenuCommand('🚀 启动全卷高准自动全选', () => startFullPageAutoSweep());
        }

        fabEl.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
        });

        // 手机端触控去重与流畅拖拽（修复 touchstart + 合成 mousedown 双重触发问题）
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
            if (Date.now() - lastTouchTimestamp < 600) return; // 忽略移动端合成鼠标事件
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

                // 手机端底部有抽屉卡片，将题目滚到屏幕上方 22% 处，避免被卡片遮挡
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
     * 8. 精准题目与选项提取器（支持高数公式无损还原）
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
     * 9. 高容错 JSON 解析器（彻底修复高数 LaTeX 反斜杠导致解析崩溃的 Bug）
     ********************************************************************/
    function repairJsonBackslashes(str) {
        // 将非合法 JSON 转义序列的单个反斜杠（如 \frac, \sin, \lim, \int, \pi, \to）修复为双反斜杠
        // 注意：保留 \" \\ \/ \b \f \n \r \t \uXXXX，但对 \frac / \theta / \tau / \beta / \nu / \rho 等常见 LaTeX 词前缀也做转义保护
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
                // 终极正则兜底：即便 JSON 格式损坏，也绝不丢失已经算出的答案
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
     * 10. 高数专项 + 智能路由 + 联网 RAG + 全卷互证 推理引擎
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
            await sleep(700 * (attempt + 1));
        }
        return { ok: false, status: 0, text: '' };
    }

    function buildSystemPrompt(isMath, isMaritime, blankCount) {
        const baseLines = [
            '你是一位满分级高校学科与大学数学（高等数学、线性代数、概率论）解题专家。',
            '核心目标：追求 100% 准确率，严禁凭感觉蒙题。'
        ];

        if (isMath) {
            baseLines.push(
                '',
                '【📐 高等数学与计算推导专项验算协议（必须严格执行）】：',
                '1. 严谨分步求解：先明确定义域、连续性、可导性、收敛条件与积分上下限，再规范推导。',
                '2. 强制反向验算（缺一不可）：',
                '   - 不定积分：对所得原函数求导，核对是否完全还原被积函数（并注意常数 C）；',
                '   - 定积分/重积分：核对对称区间奇偶性、换元后上下限是否同步变换、分部积分负号；',
                '   - 极限题：先判未定式类型（0/0、∞/∞、1^∞ 等），加减项中严禁盲目等价无穷小替换，优先用泰勒展开至足够阶数或洛必达法则交叉验算；',
                '   - 微分方程：把通解/特解代回原方程及初值条件检验；',
                '   - 级数题：先查通项极限是否为 0，再用比值/根值/比较/莱布尼茨判别法核对端点收敛性；',
                '   - 极值/拐点/间断点/渐近线：严格区分必要条件与充分条件，检查导数变号与定义域边界；',
                '   - 判断题：优先尝试构造高数经典反例（如 f(x)=|x| 连续不可导、调和级数 ∑1/n 发散、分段函数等）。',
                '3. 选项逐字精校：算出最终结果后，逐一化简并与每个选项核对正负号、系数（如 1/2 与 2）、开闭区间 () 与 []，防止看错选项。',
                '4. 联网提示警告：下方若附带联网搜索摘要，极可能是系数/符号不同的近似题，数学题严禁盲信网搜答案，必须以你独立演算与反向验算为准！'
            );
        } else {
            baseLines.push(
                '',
                '【解题准则】：',
                '1. 优先核对【🌐 实时联网搜题摘要】：若摘要中出现与本题完全一致的原题及权威答案，应高度参考；若题干存在关键词/否定词差异，必须以逻辑与教材为准。',
                '2. 善用【📄 同卷其它题目互证摘要】：同一份试卷的前后题目常包含相同概念或数值线索，可交叉印证。',
                '3. 多选题务必逐项审查，不漏选、不多选；判断题注意“一定/必须/所有/唯一”等绝对化陷阱词。'
            );
        }

        if (isMaritime) {
            baseLines.push(
                '',
                '【海运/集装箱与散货运输补充规则】：',
                '- 6位箱位号 BBRRTT：前两位奇数排号(01,03,05...)为 20ft 箱且对应自首第 (BB+1)/2 排；中两位列号奇右偶左；后两位 <80 为舱内，>=80 为甲板。',
                '- 两个 1CC(20ft) 长度之和比一个 1AA(40ft) 短；端门第 3 行标明总重和自重；超高标记数字为实际高度；双岸桥同时作业至少纵向间隔一个 40ft 行箱位。'
            );
        }

        if (blankCount > 0) {
            baseLines.push(
                '',
                `【填空题输出规范】：本题共有 ${blankCount} 个空格，请在 answerTexts 数组中按空格顺序精确输出 ${blankCount} 个最简标准答案（例如 "1/2"、"e^2"、"0"），不要多余解释文字。`
            );
        }

        baseLines.push(
            '',
            '必须严格返回合法 JSON（不要包含 Markdown 代码块；JSON 字符串内的反斜杠请务必双写为 \\\\ 或直接用简洁 ASCII/Unicode 数学符号）：',
            '{',
            '  "thinking": "精炼的关键推导步骤与反向验算结论（不超过140字）",',
            '  "answerLetters": ["正确选项大写字母，如 \\"C\\"；填空题可为空数组 []"],',
            '  "answerTexts": ["正确选项完整原文内容；填空题按空格顺序填写每个空的答案"],',
            '  "confidence": 0.95',
            '}'
        );

        return baseLines.join('\n');
    }

    async function requestSingleQuestionCoTAnalysis(q, paperContextSummary = '', overrideModel = null) {
        STATE.verifiedBank = GM_getValue('DEEPSEEK_VERIFIED_BANK', STATE.verifiedBank || {});
        const memoryEntry = lookupVerifiedBank(STATE.verifiedBank, q.stemText);

        // 1. 优先命中本地批改验证记忆库
        if (!overrideModel && memoryEntry && Array.isArray(memoryEntry.correctLetters) && memoryEntry.correctLetters.length > 0) {
            return {
                thinking: '📚 命中已验证满分题库记忆，直接锁定标准答案',
                answerLetters: memoryEntry.correctLetters,
                answerTexts: [],
                confidence: 1.0,
                usedModel: 'memory',
                isMath: isMathQuestion(q.stemText, q.options)
            };
        }

        const isMath = isMathQuestion(q.stemText, q.options);
        const isMaritime = !isMath && isMaritimeQuestion(q.stemText, q.options);

        // 决定本次调用模型：auto 模式下高数题自动走 deepseek-reasoner (R1)，普通题走 deepseek-chat (V3)
        let useModel = overrideModel;
        if (!useModel) {
            if (STATE.modelMode === 'deepseek-reasoner') {
                useModel = 'deepseek-reasoner';
            } else if (STATE.modelMode === 'deepseek-chat') {
                useModel = 'deepseek-chat';
            } else {
                useModel = isMath ? 'deepseek-reasoner' : 'deepseek-chat';
            }
        }

        // 2. 实时联网检索（纯符号高数题自动跳过噪声网搜，概念型高数题/普通题并发检索）
        const webClues = await searchWebForQuestionClues(q.stemText, q.options, isMath);

        const isMultiChoice = /多选|多项|more than one|multiple/i.test(q.stemText);
        const isTrueFalse = q.options.length === 2 && q.options.some(o => /对|错|正确|错误|true|false|√|×/i.test(o.text));
        const blankCount = q.options.length === 0 ? (q.inputs?.length || 1) : 0;
        const qTypeHint = isMultiChoice
            ? '【多选题（可能有 2~4 个正确项，请逐项核验）】'
            : (isTrueFalse ? '【判断题（请严格判断对/错并尝试找反例）】'
                : (q.options.length > 0 ? '【单选题（必选唯一最严谨正确项）】' : `【填空/主观题（共 ${blankCount} 空）】`));

        const formattedOptions = q.options.length > 0
            ? q.options.map(o => `选项 ${o.letter}: ${o.cleanContent}`).join('\n')
            : '（本题为填空或主观题，无候选选项）';

        const wrongExclusionNote = (memoryEntry && Array.isArray(memoryEntry.wrongLetters) && memoryEntry.wrongLetters.length > 0)
            ? `⚠️【重要错题排除指令】：本题上次提交选择【${memoryEntry.wrongLetters.join(', ')}】被判 0 分错误！严禁再选 ${memoryEntry.wrongLetters.join(', ')}，请从其余选项重新推导！`
            : '';

        const systemPrompt = buildSystemPrompt(isMath, isMaritime, blankCount);

        const userPrompt = [
            `题目类型：${qTypeHint}${isMath ? '（高等数学/数学计算题）' : ''}`,
            `当前题干：${q.stemText}`,
            `候选选项：\n${formattedOptions}`,
            webClues ? `【🌐 联网参考摘要${isMath ? '（仅供参考，数学题必须独立验算）' : ''}】：\n${webClues}` : '',
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

        // 若 R1 不可用或请求失败，优雅降级到 V3，绝不直接卡死
        if (!res.ok && useModel === 'deepseek-reasoner') {
            useModel = 'deepseek-chat';
            res = await callDeepSeekWithRetry(buildPayload(useModel), useModel);
        }

        if (!res.ok) return null;

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
        parsed.usedModel = useModel;
        parsed.isMath = isMath;

        // 智能二审复核：auto 模式下若 V3 置信度低于阈值或未能匹配选项，自动升级 R1 深度复核！
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
                        r1Parsed.usedModel = 'deepseek-reasoner';
                        r1Parsed.isMath = isMath;
                        r1Parsed.escalated = true;
                        return r1Parsed;
                    }
                } catch (_) {}
            }
        }

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

        // 1. 单选且文本精确匹配（含数学符号归一化）
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

        // 2. 按选项字母精准匹配
        for (const letChar of letters) {
            const byLetter = qOptions.find(o => o.letter === letChar);
            if (byLetter) addUnique(byLetter);
        }

        // 3. 若字母未命中，尝试判断题语义匹配（正确/对/√/T vs 错误/错/×/F）
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

        // 4. 文本归一化包含兜底
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
        const matchedOpts = matchOptionsAccurately(q.options, parsed);
        const ansTexts = Array.isArray(parsed?.answerTexts)
            ? parsed.answerTexts.map(t => String(t).trim()).filter(Boolean)
            : (parsed?.answer ? [String(parsed.answer).trim()] : []);

        if (matchedOpts.length > 0) {
            return { type: 'choice', matchedOpts, ansTexts };
        }
        if (q.inputs && q.inputs.length > 0 && ansTexts.length > 0) {
            return { type: 'input', matchedOpts: [], ansTexts };
        }
        return { type: 'none', matchedOpts: [], ansTexts };
    }

    function buildFullPaperCrossContext(allQuestions) {
        return allQuestions.map((q, i) => {
            const optsInline = q.options.map(o => `${o.letter}.${o.cleanContent}`).join(' ');
            return `T${i + 1}: ${q.stemText.slice(0, 95)} [${optsInline.slice(0, 95)}]`;
        }).join('\n').slice(0, 3200);
    }

    /********************************************************************
     * 11. 高数增强 + 智能并发 全卷自动连刷流水线
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

        const hasMathInPaper = allQuestions.some(q => isMathQuestion(q.stemText, q.options));
        const concurrency = (STATE.modelMode === 'deepseek-reasoner' || (STATE.modelMode === 'auto' && hasMathInPaper))
            ? CONFIG.concurrencyReasoner
            : CONFIG.concurrencyChat;

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

        triggerPrefetchUpTo(concurrency);

        const updateSweepProgressUI = (curNum, titlePreview, answerPreview, thinkingNote, parsedMeta = {}) => {
            if (!ui.contentBox) return;
            const pct = Math.round((curNum / total) * 100);
            const badges = [];
            if (parsedMeta.isMath) badges.push('<span class="ds-badge ds-badge-math">📐 高数验算</span>');
            if (parsedMeta.usedModel === 'deepseek-reasoner') badges.push('<span class="ds-badge">🔬 R1深度</span>');
            else if (parsedMeta.usedModel === 'memory') badges.push('<span class="ds-badge">📚 题库命中</span>');
            else if (parsedMeta.usedWebSearch) badges.push('<span class="ds-badge">🌐 联网RAG</span>');

            ui.contentBox.innerHTML = `
                <div style="display:flex;justify-content:space-between;align-items:center;color:#34d399;font-weight:600;font-size:12.5px;">
                    <span>⚡ 全卷高准连刷 (${curNum}/${total})</span>
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
                    <div class="ds-answer-main">${escapeHtml(answerPreview || '🔬 正在深度推导与验算...')}</div>
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
                qIsMath ? '📐 高数题：R1 深度演算与反向验算中...' : '🌐 正在联网搜题与全卷互证...',
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
                // 支持多空填空题逐一填入
                for (let k = 0; k < q.inputs.length; k++) {
                    const val = action.ansTexts[k] ?? action.ansTexts[0];
                    if (val !== undefined) {
                        const inp = q.inputs[k];
                        inp.focus();
                        setNativeInputValue(inp, String(val).trim());
                        inp.classList.add('ds-correct-highlight');
                    }
                }
                updateSweepProgressUI(curNum, q.stemText, `✍️ 已填：${action.ansTexts.join(' | ')}`, parsed?.thinking || '', parsed || {});
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
                        <div class="ds-answer-sub">已完成 ${completedCount} / ${total} 题。长按或连点 3 下 🎯 可继续。</div>
                    </div>
                `;
            } else {
                ui.contentBox.innerHTML = `
                    <div class="ds-answer-box">
                        <div class="ds-answer-main">🎉 全卷 ${completedCount} / ${total} 题已全部选完！</div>
                        <div class="ds-answer-sub">已完成【📐 高数 R1 深度验算 + 🌐 联网互证】作答，请快速核对后提交。</div>
                    </div>
                `;
            }
        }
    }

    /********************************************************************
     * 12. 单题解析功能（轻点 1 下悬浮球触发，支持一键点选与 R1 深度重算）
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
                return r.bottom > 60 && r.top < window.innerHeight - 60;
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
            if (isMatched || (opts.length >= 2 && opts.length <= 8) || (inps.length >= 1 && extractRichMathText(curr).length >= 5)) {
                return curr;
            }
            curr = curr.parentElement;
            depth++;
        }
        return document.body;
    }

    function renderSingleResult(qObj, parsed, paperContextSummary) {
        const ui = getUIElements();
        if (!ui.contentBox) return;

        if (!parsed) {
            ui.contentBox.innerHTML = `<div style="color:#ef4444;">❌ 解析失败，请检查 API Key 余额或网络连接（点右上角 ⚙️ 可修改 Key）。</div>`;
            return;
        }

        const action = applyAnswerToQuestion(qObj, parsed);
        action.matchedOpts.forEach(opt => opt.el.classList.add('ds-correct-highlight'));

        const ansDisplay = action.type === 'choice'
            ? action.matchedOpts.map(o => `${o.letter}. ${o.cleanContent}`).join(' | ')
            : (action.ansTexts.join(' | ') || '已解析');

        const badges = [];
        if (parsed.isMath) badges.push('<span class="ds-badge ds-badge-math">📐 高数专项</span>');
        if (parsed.usedModel === 'deepseek-reasoner') {
            badges.push(`<span class="ds-badge">🔬 R1深度${parsed.escalated ? '复核' : '验算'}</span>`);
        } else if (parsed.usedModel === 'memory') {
            badges.push('<span class="ds-badge">📚 已验证题库</span>');
        } else {
            badges.push(`<span class="ds-badge">${parsed.usedWebSearch ? '🌐 联网+V3' : '⚡ V3推理'}</span>`);
        }

        ui.contentBox.innerHTML = `
            <div class="ds-answer-box">
                <div class="ds-answer-meta">${badges.join('')}</div>
                <div class="ds-answer-main">${escapeHtml(ansDisplay)}</div>
                ${parsed.thinking ? `<div class="ds-answer-sub">${escapeHtml(parsed.thinking)}</div>` : ''}
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:2px;">
                ${action.type !== 'none' ? `<button class="ds-btn ds-btn-fill" id="ds-single-apply-btn">✅ 一键点选/填入本题</button>` : ''}
                ${parsed.usedModel !== 'deepseek-reasoner' ? `<button class="ds-btn ds-btn-accent" id="ds-single-r1-btn">🔬 用 R1 深度重算</button>` : ''}
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
                    for (let k = 0; k < qObj.inputs.length; k++) {
                        const val = action.ansTexts[k] ?? action.ansTexts[0];
                        if (val !== undefined) {
                            qObj.inputs[k].focus();
                            setNativeInputValue(qObj.inputs[k], String(val).trim());
                            qObj.inputs[k].classList.add('ds-correct-highlight');
                        }
                    }
                    applyBtn.innerText = '✅ 已自动填入';
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
                        <span>正在调用 DeepSeek-R1 进行深度演算与复核...</span>
                    </div>
                `;
                requestSingleQuestionCoTAnalysis(qObj, paperContextSummary, 'deepseek-reasoner').then((r1Parsed) => {
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

        const scopeEl = findSingleQuestionScope();
        if (scopeEl && scopeEl !== document.body) {
            scopeEl.classList.add('ds-scope-flash');
            setTimeout(() => scopeEl.classList.remove('ds-scope-flash'), 700);
        }

        const options = extractOptionsFromBlock(scopeEl);
        const inputs = extractInputsFromBlock(scopeEl);
        const stemText = extractPureQuestionStem(scopeEl, options, inputs[0] || null).slice(0, 1400);
        const allQuestions = collectAllQuestionsOnPage();
        const paperContextSummary = buildFullPaperCrossContext(allQuestions);
        const qIsMath = isMathQuestion(stemText, options);
        const qObj = { blockEl: scopeEl, stemText, options, inputs };
        STATE.lastSingleContext = { qObj, paperContextSummary };

        showCard();
        if (ui.contentBox) {
            ui.contentBox.innerHTML = `
                <div style="display:flex;align-items:center;gap:8px;color:${qIsMath ? '#d8b4fe' : '#38bdf8'};">
                    <span>${qIsMath ? '📐' : '🌐'}</span>
                    <span>${qIsMath ? '识别为高数/计算题，正在 R1 深度演算与反向验算...' : '正在实时联网搜题并结合全卷互证解析...'}</span>
                </div>
                <div style="font-size:11.5px;color:#94a3b8;margin-top:4px;">题目：${escapeHtml(stemText.slice(0, 48))}...</div>
            `;
        }
        if (ui.fab) ui.fab.classList.add('ds-loading');
        STATE.isAnalyzing = true;

        requestSingleQuestionCoTAnalysis(qObj, paperContextSummary).then((parsed) => {
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

    function setNativeInputValue(el, val) {
        if (!el) return;
        try {
            el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: val, bubbles: true }));
        } catch (_) {}
        if (el.isContentEditable) {
            el.innerText = val;
        } else {
            const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) setter.call(el, val);
            else el.value = val;
        }
        try {
            el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: val, bubbles: true }));
        } catch (_) {
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }
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
